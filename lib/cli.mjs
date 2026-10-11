import {VoidSigner,Contract,keccak256} from 'ethers';
import {unlockWallet,walletAddress} from './wallet.mjs';
import {ceilDiv,formatAmount} from './math.mjs';
export function cliOptions(argv,{amount=false}={}){
  const cfg={send:false};
  for(const arg of argv){
    if(arg==='--send'){cfg.send=true;continue;}
    if(arg.startsWith('--chain=')){cfg.chain=arg.slice(8);continue;}
    if(amount&&arg.startsWith('--amount=')){cfg.amount=arg.slice(9);continue;}
    throw new Error('Unknown option. Use --chain=base|bsc and optionally --send'+(amount?' or --amount=1000.':'.'));
  }
  if(!['base','bsc'].includes(cfg.chain))throw new Error('Choose --chain=base or --chain=bsc.');
  return cfg;
}
export async function localSigner(cfg,send){
  if(send)return unlockWallet(cfg);
  const address=await walletAddress(cfg);if(!address)throw new Error('Run npm run wallet:import first.');
  return new VoidSigner(address);
}
export async function prepareTransaction(c,request,cfg,budget=c.settings.gasCap){
  const fee=await c.provider.getFeeData();
  const price=c.n.key==='base'?fee.maxFeePerGas:fee.gasPrice;
  if(!price||price>c.settings.gasPriceCap)throw new Error('Gas price is above the configured cap.');
  const fields=c.n.key==='base'?{type:2,maxFeePerGas:price,maxPriorityFeePerGas:fee.maxPriorityFeePerGas??0n}:{type:0,gasPrice:price};
  const gas=await c.provider.estimateGas({...request,from:c.signer.address,...fields});
  const gasLimit=ceilDiv(gas*125n,100n),extra=c.n.key==='base'?cfg.baseExtraFeeCap:0n;
  const reserve=gasLimit*price+extra;
  if(reserve>budget)throw new Error('Transaction exceeds its local gas budget.');
  const [nonce,confirmed]=await Promise.all([c.provider.getTransactionCount(c.signer.address,'pending'),c.provider.getTransactionCount(c.signer.address,'latest')]);
  if(nonce!==confirmed)throw new Error('This wallet already has a pending transaction.');
  if(Number((await c.provider.getNetwork()).chainId)!==c.n.chainId)throw new Error('RPC chain changed.');
  return {transaction:{...request,...fields,value:request.value??0,gasLimit,nonce,chainId:c.n.chainId},reserve};
}
export async function signPrepared(c,prepared,cfg){
  const raw=await c.signer.signTransaction(prepared.transaction);
  if(c.n.key==='base'){
    const oracle=new Contract(c.n.gasOracle,['function getL1Fee(bytes) view returns(uint256)'],c.provider);
    const l1block=new Contract(c.n.l1Block,['function operatorFeeScalar() view returns(uint32)','function operatorFeeConstant() view returns(uint64)'],c.provider);
    const [l1,scalar,constant]=await Promise.all([oracle.getL1Fee(raw),l1block.operatorFeeScalar(),l1block.operatorFeeConstant()]);
    if(ceilDiv(l1*150n,100n)+constant+prepared.transaction.gasLimit*scalar*100n>cfg.baseExtraFeeCap)throw new Error('Base additional fees exceed BASE_EXTRA_FEE_CAP_NATIVE.');
  }
  if(await c.provider.getBalance(c.signer.address)<prepared.reserve+BigInt(prepared.transaction.value??0))throw new Error('Insufficient native gas balance.');
  return {raw,hash:keccak256(raw)};
}
export async function sendPrepared(c,prepared,cfg,beforeBroadcast=async()=>{}){
  const {raw,hash:intendedHash}=await signPrepared(c,prepared,cfg);
  console.log('Intended transaction: '+c.n.explorer+'/tx/'+intendedHash);
  await beforeBroadcast(intendedHash);
  const tx=await c.provider.broadcastTransaction(raw);
  if(tx.hash.toLowerCase()!==intendedHash.toLowerCase())throw new Error('RPC returned an unexpected transaction hash.');
  console.log('Transaction: '+c.n.explorer+'/tx/'+tx.hash);
  const receipt=await tx.wait(2,180000);
  if(!receipt||receipt.status!==1)throw new Error('Transaction did not complete successfully. Check the displayed transaction hash before retrying.');
  return receipt;
}
export function showPreview(c,prepared){console.log(`Estimated maximum native cost with extra-fee allowance: ${formatAmount(prepared.reserve,18,10)} ${c.n.native}`);}
