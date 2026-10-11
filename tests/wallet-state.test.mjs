import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet} from 'ethers';
import {walletFromSeed,saveWallet} from '../lib/wallet.mjs';
import {StateStore,todayLedger} from '../lib/state.mjs';
import {loadConfig} from '../lib/config.mjs';
import {parseAmount,tradeBounds,validateBudget,formatAmount} from '../lib/math.mjs';
import {readRuntimeConfig} from '../lib/settings.mjs';
// Public Ethereum development fixture, NEVER a real wallet.
const TEST_MNEMONIC='test test test test test test test test test test test junk';
test('seed import derives the selected account; encrypted file stores neither plaintext key nor phrase',async()=>{
  const root=await mkdtemp(join(tmpdir(),'arb-wallet-'));
  try{
    const wallet=walletFromSeed(TEST_MNEMONIC);
    assert.equal(wallet.address,'0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    assert.notEqual(walletFromSeed(TEST_MNEMONIC,'',"m/44'/60'/0'/0/1").address,wallet.address);
    assert.notEqual(walletFromSeed(TEST_MNEMONIC,'example').address,wallet.address);
    const file=join(root,'wallet.json'),password='local-test-password-only';
    await saveWallet(wallet,password,file);
    const data=await readFile(file,'utf8');
    assert.ok(!data.includes(TEST_MNEMONIC));assert.ok(!data.includes(wallet.privateKey.slice(2)));
    assert.equal((await Wallet.fromEncryptedJson(data,password)).address,wallet.address);
    if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
    assert.throws(()=>walletFromSeed('invalid phrase'),/Invalid seed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('saved Telegram settings and executors survive restart without overriding host credentials or paths',async()=>{
  const root=await mkdtemp(join(tmpdir(),'arb-settings-'));
  try{
    const file=join(root,'state.json'),store=new StateStore(file);await store.load();
    store.state.config={TRADING_MODE:'live',MIN_NET_PROFIT:'3',BASE_RPC_URL:'https://configured.example.com'};
    store.state.executors={base:'0x1111111111111111111111111111111111111111'};await store.save();
    const cfg=await readRuntimeConfig({STATE_FILE:file,TRADING_MODE:'paper',BOT_TOKEN:'host-only-token'});
    assert.equal(cfg.mode,'live');assert.equal(cfg.minProfit,'3');assert.equal(cfg.perChain.base.rpc,'https://configured.example.com');
    assert.equal(cfg.perChain.base.executor,store.state.executors.base);assert.equal(cfg.token,'host-only-token');assert.equal(cfg.stateFile,file);
    store.state.config.BOT_TOKEN='untrusted-override';await store.save();
    await assert.rejects(readRuntimeConfig({STATE_FILE:file}),/Unexpected saved/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('atomic state writes preserve the latest settings and unresolved transactions survive a day rollover',async()=>{
  const root=await mkdtemp(join(tmpdir(),'arb-state-'));
  try{
    const file=join(root,'state.json'),s=new StateStore(file);await s.load();
    s.state.ownerId='123';const first=s.save();s.state.watching=true;const second=s.save();await Promise.all([first,second]);
    const reread=new StateStore(file);await reread.load();assert.equal(reread.state.ownerId,'123');assert.equal(reread.state.watching,true);
    const day=todayLedger(reread.state,'base',new Date('2026-10-10T23:59:59Z'));day.pending={hash:'0xabc'};day.count=5;day.gasReserved='123';
    const next=todayLedger(reread.state,'base',new Date('2026-10-11T00:00:01Z'));
    assert.equal(next.count,0);assert.equal(next.gasReserved,'0');assert.deepEqual(next.pending,{hash:'0xabc'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('amount parsing and profit floor include gas, loan premium and slippage without floating-point rounding',()=>{
  assert.equal(parseAmount('100.123456',6),100123456n);assert.throws(()=>parseAmount('1e3',6));assert.throws(()=>parseAmount('0.0000001',6));
  const b=tradeBounds({amountIn:100000000n,assetOut:1000000000000000000n,quoteOut:110000000n,premium:50000n,gasInQuote:500000n,minNetProfit:1000000n,slippageBps:30});
  assert.equal(b.minProfit,1500000n);assert.equal(b.estimatedNet,9450000n);assert.ok(b.minQuoteOut>=101550000n);
  assert.equal(formatAmount(-1500000n,6),'-1.5');
  assert.throws(()=>validateBudget({cost:2n,perTrade:1n,dailySpent:0n,dailyLimit:5n,count:0,maxCount:5}),/gas-fee cap/);
  assert.throws(()=>validateBudget({cost:2n,perTrade:3n,dailySpent:4n,dailyLimit:5n,count:0,maxCount:5}),/Daily gas/);
  assert.throws(()=>loadConfig({TRADING_MODE:'anything'}));assert.throws(()=>loadConfig({TRADE_SIZE:'1001',MAX_TRADE_SIZE:'1000'}));
});
