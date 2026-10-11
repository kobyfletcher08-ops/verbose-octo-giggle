import {Wallet,Contract,JsonRpcProvider,keccak256,ZeroAddress,formatEther,parseUnits} from 'ethers';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {ABI,IFACE,checkPackage,toJsonJob,parseHttps} from './common.mjs';
import {ATLAS_ADDRESS,ATLAS_ABI,checkAtlasPackage,atlasToJob,atlasExecution} from './atlas.mjs';

const DEFAULT_CHAINS = [
  {name:'ethereum',chainId:1,rpc:'https://ethereum-rpc.publicnode.com'},
  {name:'base',chainId:8453,rpc:'https://mainnet.base.org'},
  {name:'bsc',chainId:56,rpc:'https://bsc-dataseed.bnbchain.org'}
];
const DEFAULT_STATE = ()=>({version:1,mode:'paper',watch:false,chains:DEFAULT_CHAINS,jobs:[],attempts:[]});
export function safeError(error){const str=String(error?.shortMessage||error?.message||error||'Unknown error');return str.replace(/https?:\/\/[^\s'"<>]+/gi,'[RPC URL]').replace(/0x[a-fA-F0-9]{64}/g,'[hash]').slice(0,240)}
export class RescueEngine {
  constructor({stateFile,env=process.env,request=fetch}={}){
    this.stateFile=stateFile||'data/rescue-state.json';this.env=env;this.request=request;this.state=null;
    this.busy=false;this.notify=async()=>{};this._artifact=null;
  }
  async init(){
    try{this.state=JSON.parse(await readFile(this.stateFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;this.state=DEFAULT_STATE();await this.save()}
    if(this.state.version!==1||!Array.isArray(this.state.chains)||!Array.isArray(this.state.jobs))throw Error('Invalid rescue state');
    this._artifact=JSON.parse(await readFile(new URL('./artifact.json',import.meta.url),'utf8'));
    if(!this._artifact?.deployedBytecode)throw Error('Compile rescue artifact before launching');
    this.runtimeHash=keccak256(this._artifact.deployedBytecode).toLowerCase();
  }
  async save(){
    await mkdir(dirname(this.stateFile),{recursive:true});const temp=this.stateFile+'.new';
    await writeFile(temp,JSON.stringify(this.state,null,2),{mode:0o600});await rename(temp,this.stateFile);
  }
  async chain(chainId){
    const c=this.state.chains.find(x=>String(x.chainId)===String(chainId));if(!c)throw Error('Chain ID not configured: '+chainId);
    const rpc=parseHttps(this.env[`RESCUE_RPC_${c.chainId}`]||c.rpc);
    const provider=new JsonRpcProvider(rpc);
    const network=await provider.getNetwork();if(network.chainId!==BigInt(c.chainId))throw Error('RPC chain ID mismatch');
    return {c,provider};
  }
  privateRpc(chainId){const url=this.env[`RESCUE_PRIVATE_RPC_${chainId}`]||(Number(chainId)===1?'https://rpc.flashbots.net/fast':null);
    if(!url)throw Error(`No verified private RPC for chain ${chainId}. Configure RESCUE_PRIVATE_RPC_${chainId} in Render. No public fallback.`);
    return parseHttps(url);
  }
  async addChain(name,chainId,rpc){
    if(!/^[a-z][a-z0-9-]{1,23}$/.test(name))throw Error('Use a 2-24 character lowercase chain name');
    if(!Number.isSafeInteger(chainId)||chainId<=0)throw Error('Invalid chain ID');
    const url=parseHttps(rpc);if(new URL(url).search)throw Error('Never paste credential-bearing RPC URLs into Telegram; use RESCUE_RPC_<ID> in Render');
    const p=new JsonRpcProvider(url);const net=await p.getNetwork();if(net.chainId!==BigInt(chainId))throw Error('RPC reports a different chain ID');
    if(this.state.chains.some(c=>c.chainId===chainId||c.name===name))throw Error('Chain already exists');
    if(this.state.chains.length>=20)throw Error('Maximum 20 custom/preset chains');
    this.state.chains.push({name,chainId,rpc:url});await this.save();
  }
  async importPackage(json){
    const p=json?.version===2?checkAtlasPackage(json):checkPackage(json);
    if(p.version!==2&&p.delegateCodeHash!==this.runtimeHash)throw Error('Delegate hash does not match bot compiled Solidity: refusing to import');
    if(!this.state.chains.some(c=>c.chainId===p.chainId))throw Error('Add chain before importing package');
    if(this.state.jobs.find(x=>x.id===p.id))throw Error('Package already imported');
    if(this.state.jobs.length>=100)throw Error('Maximum stored jobs is 100');
    const item={...(p.version===2?atlasToJob(p):toJsonJob(p)),status:'armed',submittedHash:null,createdAt:Date.now(),failures:0};
    this.state.jobs.push(item);await this.save();return item;
  }
  async balance(job,provider){
    if(job.rescue.token===ZeroAddress)return provider.getBalance(job.owner);
    const token=new Contract(job.rescue.token,['function balanceOf(address) view returns (uint256)'],provider);
    return token.balanceOf(job.owner);
  }
  async checkJob(job){
    const {provider}=await this.chain(job.chainId);
    const now=BigInt(Math.floor(Date.now()/1000));if(BigInt(job.rescue.deadline)<now){job.status='expired';await this.save();return {balance:0n,ready:false,reason:'expired'}}
    const deployed=await provider.getCode(job.delegate);
    const expectedHash=job.implementation==='atlas'?job.delegateCodeHash:this.runtimeHash;
    if(deployed==='0x'||keccak256(deployed).toLowerCase()!==expectedHash)throw Error('Delegate code mismatch/missing on configured chain');
    if(job.implementation==='atlas'&&job.delegate.toLowerCase()!==ATLAS_ADDRESS.toLowerCase())throw Error('Unrecognized Atlas implementation');
    const code=(await provider.getCode(job.owner)).toLowerCase();
    const delegated=('0xef0100'+job.delegate.slice(2)).toLowerCase();
    if(job.implementation==='atlas'){
      if(code!=='0x'&&!/^0xef0100[0-9a-f]{40}$/.test(code))throw Error('Owner contains non-7702 bytecode; cannot replace it');
      const c=new Contract(job.owner,ATLAS_ABI,provider);
      if(code===delegated&&await c.isNonceUsed(job.rescue.nonce)){job.status='done';await this.save();return {balance:0n,ready:false,reason:'already executed'}}
      const currentNonce=await provider.getTransactionCount(job.owner,'pending');
      if(BigInt(currentNonce)!==BigInt(job.auths[0].nonce))throw Error('Owner nonce advanced: dual authorization expired. Re-sign locally.');
    }else if(code!=='0x'&&code!==delegated)throw Error('Owner has an unexpected EIP-7702 delegation');
    if(job.implementation!=='atlas'&&code==='0x'){
      const ownerNonce=await provider.getTransactionCount(job.owner,'pending');
      if(BigInt(ownerNonce)!==BigInt(job.auth.nonce))throw Error('Owner nonce changed, re-sign rescue locally');
    }else if(job.implementation!=='atlas'){
      const c=new Contract(job.owner,ABI,provider);
      if(await c.alreadyUsed(job.rescue.nonce)){job.status='done';await this.save();return {balance:0n,ready:false,reason:'already executed'}}
    }
    const balance=await this.balance(job,provider);
    return {balance,ready:balance>=BigInt(job.rescue.minAmount)&&balance>0n,reason:balance>0n?'below threshold':'empty',delegated:code===delegated};
  }
  async send(job){
    if(this.busy)throw Error('Another rescue is already submitting');
    if(job.status!=='armed')throw Error('Job is no longer armed');
    if(this.state.jobs.some(x=>x.id!==job.id&&x.chainId===job.chainId&&['submitting','broadcast','unconfirmed'].includes(x.status)))
      throw Error('Another private transaction on this chain is unresolved; check its receipt before resubmitting to avoid a relayer nonce collision');
    if(this.state.mode!=='live'||this.env.ENABLE_RESCUE_LIVE!=='true')throw Error('Live execution is locked. Set ENABLE_RESCUE_LIVE=true and /mode live.');
    const relayPrivate=this.env[`RESCUE_RELAYER_KEY_${job.chainId}`]||this.env.RESCUE_RELAYER_KEY;
    if(!/^0x[0-9a-fA-F]{64}$/.test(relayPrivate||''))throw Error('Set gas-payer RESCUE_RELAYER_KEY (NOT compromised wallet key) in Render');
    const privateUrl=this.privateRpc(job.chainId); // validate before signing
    const now=Date.now();
    const todays=this.state.attempts.filter(x=>x.at>now-24*3600*1000);
    if(todays.length>=Number(this.env.RESCUE_MAX_TX_PER_DAY||5))throw Error('Daily rescue transaction limit reached');
    this.busy=true;
    try{
      const status=await this.checkJob(job);if(!status.ready)throw Error('No recoverable balance meets signed threshold');
      const {provider}=await this.chain(job.chainId);
      const wallet=new Wallet(relayPrivate,provider);
      const fee=await provider.getFeeData();const block=await provider.getBlock('latest');
      const priority=fee.maxPriorityFeePerGas??parseUnits('1','gwei');
      const gasPrice=fee.maxFeePerGas??fee.gasPrice??parseUnits('1','gwei');
      const maxFee=block?.baseFeePerGas!=null ? (block.baseFeePerGas*2n+priority>gasPrice?block.baseFeePerGas*2n+priority:gasPrice) : (gasPrice>priority?gasPrice:priority);
      const gasLimit=BigInt(this.env.RESCUE_GAS_LIMIT||'350000');
      if(gasLimit<80000n||gasLimit>800000n)throw Error('Gas limit outside 80k-800k safe bounds');
      const maxCost=BigInt(this.env.RESCUE_MAX_GAS_COST_WEI||'15000000000000000');
      if(maxFee*gasLimit>maxCost)throw Error(`Gas budget cap exceeded: worst case ${formatEther(maxFee*gasLimit)} native units; set RESCUE_MAX_GAS_COST_WEI deliberately`);
      if(await provider.getBalance(wallet.address)<maxFee*gasLimit)throw Error('Gas-payer relayer has insufficient native balance');
      const atlas=job.implementation==='atlas';
      const auth={address:job.auth?.address,chainId:BigInt(job.auth?.chainId||job.chainId),nonce:BigInt(job.auth?.nonce||0),signature:job.auth?.signature};
      const authList=atlas?job.auths.map(a=>({address:a.address,chainId:BigInt(a.chainId),nonce:BigInt(a.nonce),signature:a.signature})):[auth];
      const data=atlas?atlasExecution(job):IFACE.encodeFunctionData('rescue',[job.rescue.token,job.rescue.destination,BigInt(job.rescue.minAmount),BigInt(job.rescue.nonce),BigInt(job.rescue.deadline),job.rescue.signature]);
      const nonce=await provider.getTransactionCount(wallet.address,'pending');
      // Atlas jobs ALWAYS use a single type-4 transaction containing two consecutive 7702 auths.
      // The first clears any old delegation; the second installs the verified Atlas code.
      const tx={type:atlas?4:status.delegated?2:4,chainId:job.chainId,nonce,to:job.owner,gasLimit,value:0n,data,maxFeePerGas:maxFee,maxPriorityFeePerGas:priority,...(atlas?{authorizationList:authList}:status.delegated?{}:{authorizationList:authList})};
      const raw=await wallet.signTransaction(tx);const localHash=keccak256(raw);
      // Record BEFORE broadcast so any ambiguous network failure requires manual investigation.
      job.status='submitting';job.submittedHash=localHash;this.state.attempts=todays.concat([{id:job.id,at:now,hash:localHash}]);await this.save();
      const response=await this.request(privateUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[raw]}),signal:AbortSignal.timeout(14000)});
      const json=await response.json();if(!response.ok||json.error||!json.result)throw Error('Private RPC rejected transaction (check endpoint, EIP-7702 compatibility and gas)');
      if(String(json.result).toLowerCase()!==localHash.toLowerCase())throw Error('Private RPC returned unexpected transaction hash');
      job.status='broadcast';job.sentAt=Date.now();await this.save();return localHash;
    }finally{this.busy=false;}
  }
  async tick(){
    if(this.busy)return;const live=this.state.mode==='live'&&this.env.ENABLE_RESCUE_LIVE==='true';
    for(const job of this.state.jobs){
      if(job.status==='broadcast'||job.status==='submitting'){
        try{
          const {provider}=await this.chain(job.chainId);
          const receipt=await provider.getTransactionReceipt(job.submittedHash);
          if(receipt){job.status=receipt.status===1?'done':'failed';await this.save();await this.notify(`${job.id}: transaction ${job.status}. Hash: ${job.submittedHash}`)}
          else if(job.status==='broadcast'&&Date.now()-job.sentAt>120000){job.status='unconfirmed';await this.save();await this.notify(`${job.id}: private submission not confirmed after 2 minutes. Check hash manually before retrying.`)}
        }catch(e){console.error('Receipt check:',safeError(e))}
        continue;
      }
      if(job.status!=='armed'||!this.state.watch)continue;
      try{
        const {balance,ready}=await this.checkJob(job);
        if(ready){
          if(live){const hash=await this.send(job);await this.notify(`${job.id}: PRIVATE rescue submitted. ${hash}`)}
          else if(Date.now()-(job.lastNoticeAt||0)>3600000){job.lastNoticeAt=Date.now();await this.save();await this.notify(`${job.id}: balance ${balance} raw units meets threshold. PAPER mode: no transaction sent.`)}
        }
      }catch(e){
        const s=safeError(e);if(Date.now()-(job.lastErrorAt||0)>3600000){job.lastErrorAt=Date.now();await this.save();await this.notify(`${job.id}: ${s}`)}
      }
    }
  }
}
