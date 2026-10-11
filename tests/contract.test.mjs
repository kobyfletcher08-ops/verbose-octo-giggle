import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/evm.mjs';

test('funded atomic trade returns principal/profit, clears allowances and preserves donations',async()=>{
  const f=await fixture();try{
    await(await f.quote.mint(f.owner.address,100000000n)).wait();
    await(await f.quote.mint(f.executor.target,7000000n)).wait();
    await(await f.asset.mint(f.executor.target,123n)).wait();
    await(await f.quote.approve(f.executor.target,100000000n)).wait();
    const t=await f.trade();const simulated=await f.executor.executeFunded.staticCall(t);
    assert.ok(simulated>9000000n);
    const receipt=await(await f.executor.executeFunded(t)).wait();assert.equal(receipt.status,1);
    assert.equal(await f.quote.balanceOf(f.owner.address),100000000n+simulated);
    assert.equal(await f.quote.balanceOf(f.executor.target),7000000n);
    assert.equal(await f.asset.balanceOf(f.executor.target),123n);
    assert.equal(await f.quote.allowance(f.executor.target,f.defs[0].address),0n);
    assert.equal(await f.asset.allowance(f.executor.target,f.defs[1].address),0n);
  }finally{await f.close();}
});
test('flash loan executes both swaps, repays actual premium and returns only profit',async()=>{
  const f=await fixture();try{
    const before=await f.quote.balanceOf(f.pool.target),t=await f.trade();
    const expected=await f.executor.executeFlash.staticCall(t);
    await(await f.executor.executeFlash(t)).wait();
    assert.equal(await f.quote.balanceOf(f.owner.address),expected);
    assert.equal(await f.quote.balanceOf(f.pool.target),before+50000n);
    assert.equal(await f.quote.balanceOf(f.executor.target),0n);
    assert.equal(await f.quote.allowance(f.executor.target,f.pool.target),0n);
  }finally{await f.close();}
});
test('a losing funded round trip reverts the first swap and cannot consume donated balances',async()=>{
  const f=await fixture();try{
    await(await f.quote.mint(f.owner.address,100000000n)).wait();
    await(await f.quote.mint(f.executor.target,1000000000n)).wait();
    await(await f.quote.approve(f.executor.target,100000000n)).wait();
    await(await f.defs[1].router.setHaircut(2000)).wait();
    const reserves=await f.defs[0].pair.getReserves();
    const tx=await f.executor.executeFunded(await f.trade(),{gasLimit:1200000});
    await assert.rejects(tx.wait(),/reverted/);
    assert.equal(await f.quote.balanceOf(f.owner.address),100000000n);
    assert.equal(await f.quote.balanceOf(f.executor.target),1000000000n);
    assert.deepEqual(Array.from(await f.defs[0].pair.getReserves()).slice(0,2),Array.from(reserves).slice(0,2));
    assert.equal(await f.quote.allowance(f.owner.address,f.executor.target),100000000n);
  }finally{await f.close();}
});
test('a losing flash loan reverts without using contract donations or leaving debt',async()=>{
  const f=await fixture();try{
    await(await f.quote.mint(f.executor.target,1000000000n)).wait();
    await(await f.defs[1].router.setHaircut(2000)).wait();
    const before=await f.quote.balanceOf(f.pool.target);
    await assert.rejects(f.executor.executeFlash.staticCall(await f.trade()));
    assert.equal(await f.quote.balanceOf(f.pool.target),before);
    assert.equal(await f.quote.balanceOf(f.executor.target),1000000000n);
  }finally{await f.close();}
});
test('owner-only access, allowlisted routers, deadlines, and callback provenance are enforced',async()=>{
  const f=await fixture();try{
    const t=await f.trade();
    await assert.rejects(f.executor.connect(f.other).executeFlash.staticCall(t));
    await assert.rejects(f.executor.connect(f.other).rescue.staticCall(f.quote.target,1));
    await assert.rejects(f.executor.executeFlash.staticCall({...t,sellRouter:t.buyRouter}));
    await assert.rejects(f.executor.executeFlash.staticCall({...t,buyRouter:f.other.address}));
    await assert.rejects(f.executor.executeFlash.staticCall({...t,deadline:1}));
    await assert.rejects(f.executor.executeOperation.staticCall(f.quote.target,100,0,f.executor.target,'0x'));
    await assert.rejects(f.pool.maliciousCallback.staticCall(f.executor.target,f.quote.target,'0x'));
    await(await f.pool.setDuplicate(true)).wait();
    await assert.rejects(f.executor.executeFlash.staticCall(t));
  }finally{await f.close();}
});
