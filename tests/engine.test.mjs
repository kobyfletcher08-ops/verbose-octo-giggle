import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingEngine} from '../lib/engine.mjs';
import {loadConfig} from '../lib/config.mjs';
import {fixture} from './fixtures/evm.mjs';
function setup(f,mode='live'){
  const cfg=loadConfig({TRADING_MODE:mode});
  const store={state:{ledger:{},amount:null,trading:true},writes:0,async save(){this.writes++;}};
  const engine=new TradingEngine(cfg,store,f.owner);engine.connections.set(f.c.n.key,f.c);
  return {engine,store};
}
test('on-chain quote -> simulation -> signed local transaction -> persisted hash -> confirmation',async()=>{
  const f=await fixture();try{
    const {engine,store}=setup(f),report=await engine.scanChain('bsc');
    const row=report.rows.find(r=>r.profitable);assert.ok(row);
    let broadcasts=0;const original=f.provider.broadcastTransaction.bind(f.provider);
    f.provider.broadcastTransaction=async raw=>{broadcasts++;assert.ok(store.writes>0);assert.ok(store.state.ledger.bsc.pending.hash);return original(raw);};
    const result=await engine.execute('bsc',row,()=>true);
    assert.equal(result.kind,'submitted');assert.equal(broadcasts,1);
    assert.equal(store.state.ledger.bsc.count,1);assert.equal(store.state.ledger.bsc.gasReserved,f.c.settings.gasCap.toString());
    await assert.rejects(engine.execute('bsc',row,()=>true),/unresolved/);
    await f.rpc.request({method:'evm_mine',params:[]});
    const notices=await engine.reconcile();assert.equal(notices.length,1);assert.equal(notices[0].status,1);
    assert.equal(store.state.ledger.bsc.pending,null);assert.ok(notices[0].profit>0n);
  }finally{await f.close();}
});
test('Base live path includes L1/operator fee allowance and rejects excessive additional fees',async()=>{
  const f=await fixture('base');try{
    const {engine,store}=setup(f);const row=(await engine.scanChain('base')).rows.find(r=>r.profitable);assert.ok(row);
    await(await f.gasOracle.setFee(100000000000000n)).wait();
    await assert.rejects(engine.execute('base',row,()=>true),/extra-fee allowance/);
    assert.equal(store.state.ledger.base.count,0);assert.equal(store.state.ledger.base.pending,null);
    await(await f.gasOracle.setFee(10000000000000n)).wait();
    const result=await engine.execute('base',row,()=>true);assert.equal(result.kind,'submitted');
  }finally{await f.close();}
});
test('paper execution fully simulates without signing, broadcasting or charging a daily attempt',async()=>{
  const f=await fixture();try{
    const {engine,store}=setup(f,'paper'),before=await f.provider.getTransactionCount(f.owner.address);
    f.provider.broadcastTransaction=()=>{throw new Error('Must not broadcast in paper mode');};
    const row=(await engine.scanChain('bsc')).rows.find(r=>r.profitable);
    const result=await engine.execute('bsc',row,()=>true);assert.equal(result.kind,'paper');
    assert.equal(await f.provider.getTransactionCount(f.owner.address),before);
    assert.deepEqual(store.state.ledger,{});
  }finally{await f.close();}
});
test('paused trading, exhausted budgets and failed state persistence never broadcast',async()=>{
  const f=await fixture();try{
    const {engine,store}=setup(f);const row=(await engine.scanChain('bsc')).rows.find(r=>r.profitable);
    let broadcasts=0;f.provider.broadcastTransaction=()=>{broadcasts++;throw new Error('unexpected');};
    assert.equal((await engine.execute('bsc',row,()=>false)).kind,'cancelled');
    store.state.ledger.bsc={day:new Date().toISOString().slice(0,10),count:5,gasReserved:'0',pending:null,lastAttemptAt:0};
    await assert.rejects(engine.execute('bsc',row,()=>true),/Daily transaction limit/);
    store.state.ledger.bsc.count=0;store.save=async()=>{throw new Error('disk failed');};
    await assert.rejects(engine.execute('bsc',row,()=>true),/disk failed/);
    assert.equal(broadcasts,0);assert.ok(store.state.ledger.bsc.pending);
  }finally{await f.close();}
});
test('disabled flash reserve and changed quotes prevent execution',async()=>{
  const f=await fixture();try{
    const {engine}=setup(f);const row=(await engine.scanChain('bsc')).rows.find(r=>r.profitable);
    await(await f.pool.setConfiguration(1n<<56n)).wait();
    await assert.rejects(engine.scanChain('bsc'),/unavailable/);
    await(await f.pool.setConfiguration((1n<<56n)|(1n<<63n))).wait();
    // Higher first-pool price erases the quoted opportunity; the submit path must re-quote.
    await(await f.defs[0].pair.setReserves(1200000000000n,500n*10n**18n)).wait();
    await assert.rejects(engine.execute('bsc',row,()=>true),/no longer meets/);
  }finally{await f.close();}
});
