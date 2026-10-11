import test from 'node:test';
import assert from 'node:assert/strict';
import {ContractFactory} from 'ethers';
import {artifact} from '../lib/chain.mjs';
import {cliOptions,prepareTransaction,sendPrepared} from '../lib/cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {fixture} from './fixtures/evm.mjs';
test('deployment helper previews and signs the same bounded transaction, journals its hash before broadcasting',async()=>{
  assert.deepEqual(cliOptions(['--chain=base','--send']),{chain:'base',send:true});
  assert.throws(()=>cliOptions(['--chain=ethereum']));
  const f=await fixture();try{
    const data=await artifact(),factory=new ContractFactory(data.abi,data.bytecode,f.owner);
    const request=await factory.getDeployTransaction(f.owner.address,f.quote.target,f.asset.target,f.pool.target,...f.defs.map(d=>d.address));
    const cfg=loadConfig({});const prepared=await prepareTransaction(f.c,request,cfg,f.c.settings.gasCap*10n);
    assert.ok(prepared.reserve<=f.c.settings.gasCap*10n);assert.equal(prepared.transaction.chainId,56);
    let journaled='';const original=f.provider.broadcastTransaction.bind(f.provider);
    f.provider.broadcastTransaction=async raw=>{assert.ok(journaled);const result=await original(raw);await f.rpc.request({method:'evm_mine',params:[]});return result;};
    const receipt=await sendPrepared(f.c,prepared,cfg,async hash=>{journaled=hash;});
    assert.equal(receipt.hash,journaled);assert.ok(receipt.contractAddress);assert.equal(receipt.status,1);
  }finally{await f.close();}
});
