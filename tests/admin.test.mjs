import test from 'node:test';
import assert from 'node:assert/strict';
import {getCreateAddress} from 'ethers';
import {fixture} from './fixtures/evm.mjs';
import {loadConfig} from '../lib/config.mjs';
import {TradingEngine} from '../lib/engine.mjs';
import {AdminService} from '../lib/admin.mjs';
function setup(f){
  const cfg=loadConfig({TRADING_MODE:'paper'});cfg.perChain[f.n?.key??f.c.n.key]=f.c.settings;
  const store={state:{ownerId:'42',chains:['bsc'],ledger:{},operations:{},executors:{},config:{},history:[],trading:true},writes:0,async save(){this.writes++;}};
  const engine=new TradingEngine(cfg,store,f.owner);engine.connections.set(f.c.n.key,f.c);
  const admin=new AdminService({cfg,store,engine});return {cfg,store,engine,admin};
}
async function confirm(f,admin,id){const result=await admin.confirm(id);await f.rpc.request({method:'evm_mine',params:[]});const notices=await admin.reconcile();assert.equal(notices.length,1);assert.equal(notices[0].status,1);return {result,notice:notices[0]};}
test('Telegram deployment is previewed, journaled before broadcast, verified and configured automatically',async()=>{
  const f=await fixture();try{
    const {cfg,store,engine,admin}=setup(f);f.c.settings.executor='';f.c.executor=null;
    const nonce=await f.provider.getTransactionCount(f.owner.address);
    const plan=await admin.request('deploy','bsc');assert.ok(plan.id);assert.equal(store.state.trading,false);
    assert.equal(await f.provider.getTransactionCount(f.owner.address),nonce);
    const original=f.provider.broadcastTransaction.bind(f.provider);
    f.provider.broadcastTransaction=async raw=>{assert.ok(store.state.operations.bsc.pending.hash);assert.ok(store.writes>=2);return original(raw);};
    const {result}=await confirm(f,admin,plan.id);
    const predicted=getCreateAddress({from:f.owner.address,nonce});
    assert.equal(cfg.perChain.bsc.executor,predicted);assert.equal(store.state.executors.bsc,predicted);
    assert.equal(await f.c.executor.owner(),f.owner.address);assert.equal(store.state.operations.bsc.pending,null);assert.equal(engine.hasPending(),false);
    await assert.rejects(admin.confirm(plan.id),/already used/);assert.equal(store.state.history[0].hash,result.hash);
    await assert.rejects(admin.request('deploy','bsc'),/already configured/);
  }finally{await f.close();}
});
test('bounded approvals, zero resets, finishing approvals and revocation are controlled from previews',async()=>{
  const f=await fixture();try{
    const {admin}=setup(f);
    await assert.rejects(admin.request('approve','bsc',{amount:'1001'}),/maximum/);
    let plan=await admin.request('approve','bsc',{amount:'1000'});await confirm(f,admin,plan.id);
    assert.equal(await f.quote.allowance(f.owner.address,f.executor.target),1000000000n);
    plan=await admin.request('approve','bsc',{amount:'500'});assert.ok(plan.text.includes('zero reset'));
    const reset=await confirm(f,admin,plan.id);assert.equal(reset.notice.nextApproval,'500');
    assert.equal(await f.quote.allowance(f.owner.address,f.executor.target),0n);
    plan=await admin.request('approve','bsc',{amount:'500'});await confirm(f,admin,plan.id);
    assert.equal(await f.quote.allowance(f.owner.address,f.executor.target),500000000n);
    plan=await admin.request('approve','bsc',{amount:'0'});await confirm(f,admin,plan.id);
    assert.equal(await f.quote.allowance(f.owner.address,f.executor.target),0n);
  }finally{await f.close();}
});
test('withdrawals retain native value and token amount; expired and changed previews cannot execute',async()=>{
  const f=await fixture();try{
    const {admin}=setup(f);
    await f.quote.mint(f.owner.address,100000000n);
    const before=await f.provider.getBalance(f.other.address);
    let plan=await admin.request('withdraw','bsc',{token:'BNB',amount:'0.01',to:f.other.address});await confirm(f,admin,plan.id);
    assert.equal(await f.provider.getBalance(f.other.address),before+10000000000000000n);
    plan=await admin.request('withdraw','bsc',{token:'USDT',amount:'25',to:f.other.address});await confirm(f,admin,plan.id);
    assert.equal(await f.quote.balanceOf(f.other.address),25000000n);
    plan=await admin.request('withdraw','bsc',{token:'USDT',amount:'1',to:f.other.address});admin.plans.get(plan.id).expires=1;
    await assert.rejects(admin.confirm(plan.id),/expired/);
    await assert.rejects(admin.request('withdraw','bsc',{token:'ANY_TOKEN',amount:'1',to:f.other.address}),/Supported/);
  }finally{await f.close();}
});
test('ambiguous or unjournaled setup transactions never automatically retry and block trading',async()=>{
  const f=await fixture();try{
    const {admin,engine,store}=setup(f);
    let broadcasts=0;f.provider.broadcastTransaction=async()=>{broadcasts++;throw new Error('network timeout');};
    let plan=await admin.request('approve','bsc',{amount:'100'});
    await assert.rejects(admin.confirm(plan.id),/uncertain/);assert.equal(broadcasts,1);assert.equal(engine.hasPending(),true);
    await assert.rejects(admin.request('approve','bsc',{amount:'100'}),/unresolved/);
    assert.equal(store.state.trading,false);assert.ok(store.state.operations.bsc.pending.hash);
    store.state.operations.bsc.pending=null;
    plan=await admin.request('approve','bsc',{amount:'100'});
    store.save=async()=>{if(store.state.operations.bsc.pending)throw new Error('disk failed');};
    await assert.rejects(admin.confirm(plan.id),/disk failed/);assert.equal(broadcasts,1);assert.equal(engine.hasPending(),true);
  }finally{await f.close();}
});
