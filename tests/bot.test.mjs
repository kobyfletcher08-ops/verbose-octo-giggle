import test from 'node:test';
import assert from 'node:assert/strict';
import {BotApp,parseCommand,parseChains,formatReport} from '../lib/bot-app.mjs';
import {Telegram} from '../lib/telegram.mjs';
import {loadConfig} from '../lib/config.mjs';
function fixture(){
  const cfg=loadConfig({}),store={state:{version:1,ownerId:'',ledger:{},lastAlerts:{},chains:['base','bsc'],amount:null,trading:false,watching:false},async save(){}};
  const sent=[],calls=[];
  const tg={async send(id,text,keyboard){sent.push({id,text,keyboard});},async call(method,data){calls.push({method,data});return true;}};
  const engine={amount:()=>store.state.amount??cfg.amount,hasPending:()=>false,busy:false,wallet:null,async reconcile(){return [];},async chain(){return {executor:{},signer:{}};}};
  const app=new BotApp({cfg,store,engine,telegram:tg,env:{},username:'ExampleBot',pairCode:'abcdef123456'});
  const update=(id,text,extra={})=>({message:{message_id:1,chat:{id,type:'private'},from:{id},text,...extra}});
  return {app,store,sent,calls,update,engine,cfg};
}
test('pairing requires the local code; strangers and group callbacks cannot control the bot',async()=>{
  const f=fixture();
  await f.app.handle(f.update(99,'/start wrong'));assert.equal(f.store.state.ownerId,'');
  await f.app.handle(f.update(42,'/start abcdef123456'));assert.equal(f.store.state.ownerId,'42');
  assert.equal(f.app.pairCode,'');assert.ok(f.calls.some(c=>c.method==='deleteMessage'));
  await f.app.handle(f.update(99,'/trade on'));assert.equal(f.store.state.trading,false);
  await f.app.handle({callback_query:{id:'c',from:{id:99},data:'trade on',message:{chat:{id:99,type:'private'}}}});
  assert.equal(f.store.state.trading,false);
  await f.app.handle(f.update(42,'/trade on',{chat:{id:-123,type:'group'}}));assert.equal(f.store.state.trading,false);
  await f.app.handle(f.update(42,'/trade on'));assert.equal(f.store.state.trading,true);
  await f.app.handle(f.update(42,'/pause'));assert.equal(f.store.state.trading,false);assert.equal(f.store.state.watching,false);
});
test('Telegram settings persist, live mode requires confirmation and a locked wallet cannot trade live',async()=>{
  const f=fixture();f.store.state.ownerId='42';f.engine.isUnlocked=()=>false;
  await f.app.handle(f.update(42,'/set profit 2'));assert.equal(f.cfg.minProfit,'2');assert.equal(f.store.state.config.MIN_NET_PROFIT,'2');
  await f.app.handle(f.update(42,'/set slippage_bps 201'));assert.equal(f.cfg.slippageBps,30);
  await f.app.handle(f.update(42,'/set BOT_TOKEN invalid'));assert.equal(f.cfg.token,'');
  await f.app.handle(f.update(42,'/mode live'));assert.equal(f.cfg.mode,'paper');
  const data=f.sent.at(-1).keyboard.inline_keyboard[0][0].callback_data;
  await f.app.handle({callback_query:{id:'live',from:{id:99},data,message:{chat:{id:99,type:'private'}}}});assert.equal(f.cfg.mode,'paper');
  await f.app.handle({callback_query:{id:'live2',from:{id:42},data,message:{chat:{id:42,type:'private'}}}});assert.equal(f.cfg.mode,'live');assert.equal(f.store.state.trading,false);
  await f.app.handle(f.update(42,'/trade on'));assert.equal(f.store.state.trading,false);assert.ok(f.sent.at(-1).text.includes('/unlock'));
  await f.app.handle(f.update(42,'/mode paper'));assert.equal(f.cfg.mode,'paper');
  await f.app.handle(f.update(42,'/prompt profit'));await f.app.handle(f.update(42,'3'));assert.equal(f.cfg.minProfit,'3');
});
test('wallet setup opens an HTTPS Mini App and unauthorized users cannot deploy, approve or withdraw',async()=>{
  const f=fixture();f.store.state.ownerId='42';f.cfg.appUrl='https://wallet.example.com';
  let requests=0;f.app.admin.request=async()=>{requests++;return {id:'123',text:'test preview'};};
  for(const text of ['/deploy bsc','/approve bsc 100','/withdraw bsc BNB 1 0xExample'])await f.app.handle(f.update(99,text));assert.equal(requests,0);
  await f.app.handle(f.update(42,'/import'));
  assert.equal(f.sent.at(-1).keyboard.inline_keyboard[0][0].web_app.url,f.cfg.appUrl);
  await f.app.handle(f.update(42,'/setup'));assert.ok(f.sent.at(-1).text.includes('Telegram setup'));
  for(const row of f.sent.at(-1).keyboard.inline_keyboard)for(const button of row)if(button.callback_data)assert.ok(Buffer.byteLength(button.callback_data)<=64);
  await f.app.handle(f.update(42,'/deploy bsc'));assert.equal(requests,1);assert.equal(f.sent.at(-1).keyboard.inline_keyboard[0][0].callback_data,'confirm 123');
});
test('seed text is not saved or echoed and the Telegram wallet form is offered',async()=>{
  const f=fixture();f.store.state.ownerId='42';
  const phrase='one two three four five six seven eight nine ten eleven twelve';
  await f.app.handle(f.update(42,phrase));
  assert.ok(f.calls.some(c=>c.method==='deleteMessage'));
  assert.ok(f.sent.at(-1).text.includes('wallet form'));
  assert.ok(!JSON.stringify(f.store.state).includes(phrase));assert.ok(!JSON.stringify(f.sent).includes(phrase));
});
test('size/chain inputs are bounded, chain changes pause trading and manual scans never execute',async()=>{
  const f=fixture();f.store.state.ownerId='42';
  await f.app.handle(f.update(42,'/size 2000'));assert.equal(f.store.state.amount,null);
  await f.app.handle(f.update(42,'/size 125.5'));assert.equal(f.store.state.amount,'125.5');
  f.store.state.trading=true;await f.app.handle(f.update(42,'/chains bsc'));assert.deepEqual(f.store.state.chains,['bsc']);assert.equal(f.store.state.trading,false);
  let scans=0,executions=0;
  f.engine.execute=async()=>{executions++;};
  f.engine.scanChain=async()=>{scans++;return {key:'bsc',n:{name:'BSC',quote:'USDT',asset:'WBNB'},block:{number:1,timestamp:1},observedAt:Date.now(),pools:[],rows:[],notes:[]};};
  await f.app.handle(f.update(42,'/scan bsc'));await f.app.handle(f.update(42,'/scan bsc'));
  assert.equal(scans,1);assert.equal(executions,0);
});
test('one cached scan is shared by simultaneous requests and failed scans remain retryable',async()=>{
  const f=fixture();let count=0;
  f.engine.scanChain=async()=>{count++;await new Promise(r=>setTimeout(r,10));return {observedAt:Date.now()};};
  await Promise.all([f.app.scan('base'),f.app.scan('base')]);assert.equal(count,1);
  let errors=0;f.engine.scanChain=async()=>{errors++;throw new Error('offline');};
  await assert.rejects(f.app.scan('bsc'));await assert.rejects(f.app.scan('bsc'));assert.equal(errors,2);
});
test('command suffixes, chain parser, and Telegram rate-limit handling follow the API',async()=>{
  assert.deepEqual(parseCommand('/scan@ExampleBot base','examplebot'),{name:'scan',args:'base'});
  assert.equal(parseCommand('/trade@OtherBot on','examplebot'),null);
  assert.throws(()=>parseChains('ethereum'));assert.deepEqual(parseChains('both'),['base','bsc']);
  let count=0;
  const tg=new Telegram('123456:abcdefghijklmnopqrstuvwxyzABCDE',{fetchImpl:async()=>{
    count++;return {ok:count>1,status:count>1?200:429,json:async()=>count>1?{ok:true,result:true}:{ok:false,error_code:429,parameters:{retry_after:1}}};
  }});
  assert.equal(await tg.call('getMe'),true);assert.equal(count,2);
  await assert.rejects(tg.send(1,'x'.repeat(4097)),/length limit/);
});
test('encrypted wallet backups use the Telegram multipart document API',async()=>{
  let request;
  const tg=new Telegram('123456:abcdefghijklmnopqrstuvwxyzABCDE',{fetchImpl:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({ok:true,result:{message_id:1}})};}});
  await tg.document('42','trading-wallet-encrypted.json','{"version":3,"crypto":{}}','Encrypted backup');
  assert.ok(request.url.endsWith('/sendDocument'));assert.equal(request.options.body.get('chat_id'),'42');
  assert.equal(request.options.body.get('document').name,'trading-wallet-encrypted.json');
  assert.equal(await request.options.body.get('document').text(),'{"version":3,"crypto":{}}');
  assert.equal(request.options.headers,undefined);
});
