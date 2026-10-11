import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,ZeroAddress,randomBytes,hexlify} from 'ethers';
import {ATLAS_ADDRESS,ATLAS_TYPES,atlasDomain,makeAtlasCall,checkAtlasPackage,atlasToJob,atlasExecution,ATLAS_IFACE} from './atlas.mjs';
const CHAIN=8453n;
async function fixture(){
  const wallet=Wallet.createRandom(),safe=Wallet.createRandom().address;
  const first=await wallet.authorize({address:ZeroAddress,nonce:7n,chainId:CHAIN});
  const second=await wallet.authorize({address:ATLAS_ADDRESS,nonce:8n,chainId:CHAIN});
  const call=makeAtlasCall(ZeroAddress,safe,1000n);
  const deadline=BigInt(Math.floor(Date.now()/1000)+300);
  const nonce=BigInt(hexlify(randomBytes(32)));
  const signature=await wallet.signTypedData(atlasDomain(wallet.address,CHAIN),ATLAS_TYPES,{call,deadline,nonce});
  const auths=[first,second].map(a=>({address:a.address,nonce:a.nonce.toString(),chainId:a.chainId.toString(),signature:a.signature.serialized}));
  const p={version:2,implementation:'atlas',chainId:CHAIN.toString(),owner:wallet.address,delegate:ATLAS_ADDRESS,
    delegateCodeHash:'0x'+'99'.repeat(32),auths,atlasCall:call,
    rescue:{token:ZeroAddress,destination:safe,minAmount:'1000',nonce:nonce.toString(),deadline:deadline.toString(),signature}};
  return {p,wallet};
}
test('two signed consecutive 7702 authorizations are accepted and encode Atlas call',async()=>{
  const {p}=await fixture();
  const checked=checkAtlasPackage(p);
  assert.equal(checked.auths[0].address,ZeroAddress);
  assert.equal(checked.auths[1].address,ATLAS_ADDRESS);
  assert.equal(checked.auths[1].nonce,checked.auths[0].nonce+1n);
  const job=atlasToJob(checked);
  const parsed=ATLAS_IFACE.parseTransaction({data:atlasExecution(job)});
  assert.equal(parsed.name,'executeCall');
  assert.equal(parsed.args[0].to,p.rescue.destination);
  assert.equal(parsed.args[0].value,1000n);
});
test('reject reversed or skipped authorizations',async()=>{
  const {p}=await fixture();
  const reversed=structuredClone(p);reversed.auths.reverse();
  assert.throws(()=>checkAtlasPackage(reversed),/Authorization order/);
  const omitted=structuredClone(p);omitted.auths.pop();
  assert.throws(()=>checkAtlasPackage(omitted),/Two authorizations/);
});
test('reject attacker modified safe wallet, amount, calldata or chain',async()=>{
  const {p}=await fixture();
  const corrupt=structuredClone(p);corrupt.rescue.destination=Wallet.createRandom().address;
  assert.throws(()=>checkAtlasPackage(corrupt),/Atlas operation/);
  const amount=structuredClone(p);amount.rescue.minAmount='1001';
  assert.throws(()=>checkAtlasPackage(amount),/Atlas operation/);
  const wrong=structuredClone(p);wrong.chainId='1';
  assert.throws(()=>checkAtlasPackage(wrong),/Authorization chain/);
  const bytes=structuredClone(p);bytes.atlasCall.data='0x1234';
  assert.throws(()=>checkAtlasPackage(bytes),/Atlas operation/);
});
test('token transfer is exact amount with safe wallet, no unlimited spend',async()=>{
  const token=Wallet.createRandom().address,dest=Wallet.createRandom().address;
  const call=makeAtlasCall(token,dest,12n);
  assert.equal(call.value,'0');
  assert.equal(call.to,token);
  assert.equal(call.data.slice(0,10),'0xa9059cbb');
});
