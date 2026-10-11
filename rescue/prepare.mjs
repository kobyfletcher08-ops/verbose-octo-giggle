// Run ONLY on a trusted local computer. NEVER use the rescue key on Render.
import {Wallet,JsonRpcProvider,ContractFactory,keccak256,randomBytes,hexlify,ZeroAddress,parseUnits,getAddress} from 'ethers';
import {readFile,writeFile} from 'node:fs/promises';
import {TYPES,parseHttps,asUInt} from './common.mjs';
const options=Object.fromEntries(process.argv.slice(2).flatMap((v,i,a)=>v.startsWith('--')?[[v.slice(2),a[i+1]]]:[]));
const action=process.argv[2];
const rpc=parseHttps(options.rpc||process.env.RESCUE_RPC_URL||'');
const provider=new JsonRpcProvider(rpc,undefined,{staticNetwork:false});
const net=await provider.getNetwork();const chainId=net.chainId;
if(options.chain&&asUInt(options.chain,'chain',true)!==chainId)throw Error('Chain ID mismatch');
const artifact=JSON.parse(await readFile(new URL('./artifact.json',import.meta.url),'utf8'));
if(action==='deploy'){
  const key=process.env.RESCUE_DEPLOYER_KEY;
  if(!key)throw Error('Set RESCUE_DEPLOYER_KEY locally (funded deployer wallet)');
  const signer=new Wallet(key,provider);
  const factory=new ContractFactory(artifact.abi,artifact.bytecode,signer);
  const contract=await factory.deploy();console.log('Deployment transaction:',contract.deploymentTransaction().hash);
  await contract.waitForDeployment();console.log('Delegate address:',await contract.getAddress());
  console.log('Verify source and deployed bytecode before signing any authorization.');
  process.exit(0);
}
if(action!=='sign')throw Error('Usage: node rescue/prepare.mjs sign|deploy --rpc URL --chain ID [--delegate ADDRESS --token ADDRESS|native --safe ADDRESS --min INTEGER --hours 24 --out FILE]');
if(!process.env.RESCUE_OWNER_PRIVATE_KEY)throw Error('RESCUE_OWNER_PRIVATE_KEY is required locally; do not upload it or message it to the Telegram bot');
const owner=new Wallet(process.env.RESCUE_OWNER_PRIVATE_KEY,provider);
const delegate=getAddress(options.delegate);
const onchain=await provider.getCode(delegate);if(onchain==='0x')throw Error('Delegate contract is not deployed on this chain');
const expected=keccak256(artifact.deployedBytecode);
if(keccak256(onchain)!==expected)throw Error('DELEGATE CODE DOES NOT MATCH locally compiled contract - refusing to authorize');
const currentCode=await provider.getCode(owner.address);
if(currentCode!=='0x' && currentCode.toLowerCase()!==('0xef0100'+delegate.slice(2)).toLowerCase())throw Error('Owner has a different delegation. Resolve it before signing.');
const token=options.token==='native'?ZeroAddress:getAddress(options.token);
const safe=getAddress(options.safe);if(safe===owner.address)throw Error('Safe destination must differ from owner');
const minAmount=asUInt(options.min||'1','min',true);
const hours=Number(options.hours||24);if(!Number.isFinite(hours)||hours<=0||hours>168)throw Error('Hours must be 0-168');
const nonce=BigInt(hexlify(randomBytes(32))).toString();
const deadline=Math.floor(Date.now()/1000+hours*3600).toString();
const ownerNonce=await provider.getTransactionCount(owner.address,'pending');
// Always scope 7702 authorization to the specific chain; never use chainId=0.
const auth=await owner.authorize({address:delegate,nonce:ownerNonce,chainId});
const value={token,destination:safe,minAmount,nonce,deadline};
const sig=await owner.signTypedData({name:'SelfRescue7702',version:'1',chainId,verifyingContract:owner.address},TYPES,value);
const pack={version:1,chainId:chainId.toString(),owner:owner.address,delegate,delegateCodeHash:expected,auth:{address:auth.address,nonce:auth.nonce.toString(),chainId:auth.chainId.toString(),signature:auth.signature.serialized},rescue:{...value,minAmount:minAmount.toString(),signature:sig}};
const filename=options.out||`rescue-${chainId}-${owner.address.slice(2,10)}.json`;
await writeFile(filename,JSON.stringify(pack,null,2),{mode:0o600,flag:'wx'});
console.log('Signed ONE rescue package (no private key saved):',filename);
console.log('Wallet:',owner.address,'\nDestination:',safe,'\nChain:',chainId.toString(),'\nToken:',token,'\nMin raw units:',minAmount.toString());
console.log('Delegating to:',delegate,'\nCODE HASH:',expected,'\nExpires:',new Date(Number(deadline)*1000).toISOString());
console.log('Only upload the JSON rescue package to YOUR private bot. DO NOT upload a wallet key/seed.');
