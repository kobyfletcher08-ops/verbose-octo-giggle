import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,keccak256,randomBytes,ZeroAddress} from 'ethers';
import {checkPackage,TYPES,parseHttps,asUInt} from './common.mjs';
test('only HTTPS public endpoints accepted',()=>{
  for(const url of ['http://example.org','https://localhost:8443','https://127.0.0.1','https://a:pass@api.org','https://10.1.1.1'])assert.throws(()=>parseHttps(url));
  assert.equal(parseHttps('https://mainnet.base.org'),'https://mainnet.base.org/');
});
test('strict decimal integer parsing',()=>{
  assert.equal(asUInt('15','min',true),15n);
  for(const value of ['-1','1.5','1e3','0x1'])assert.throws(()=>asUInt(value,'field'));
});
test('verifies chain-bound 7702 and typed data owner signatures',async()=>{
  const owner=Wallet.createRandom();const delegate=Wallet.createRandom().address;const safe=Wallet.createRandom().address;
  const chainId=11155111n;const nonce='12345',deadline=String(Math.floor(Date.now()/1000)+1800);
  const auth=await owner.authorize({address:delegate,chainId,nonce:7});
  const values={token:ZeroAddress,destination:safe,minAmount:'1',nonce,deadline};
  const signature=await owner.signTypedData({name:'SelfRescue7702',version:'1',chainId,verifyingContract:owner.address},TYPES,values);
  const pack={version:1,chainId:String(chainId),owner:owner.address,delegate,delegateCodeHash:keccak256(randomBytes(32)),auth:{address:auth.address,chainId:auth.chainId.toString(),nonce:auth.nonce.toString(),signature:auth.signature.serialized},rescue:{...values,signature}};
  const result=checkPackage(pack);
  assert.equal(result.owner,owner.address);
  assert.equal(result.rescue.destination,safe);
  assert.throws(()=>checkPackage({...pack,chainId:'1'}));
  assert.throws(()=>checkPackage({...pack,rescue:{...pack.rescue,destination:Wallet.createRandom().address}}));
  assert.throws(()=>checkPackage({...pack,auth:{...pack.auth,chainId:'0'}}));
});
