import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,webcrypto} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet} from 'ethers';
import {validateInitData,SecretSessions} from '../lib/webapp-auth.mjs';
import {startWebApp} from '../lib/webapp-server.mjs';
import {loadConfig} from '../lib/config.mjs';
import {StateStore} from '../lib/state.mjs';
import {TradingEngine} from '../lib/engine.mjs';
import {BotApp} from '../lib/bot-app.mjs';
import {walletFromSeed} from '../lib/wallet.mjs';
const TOKEN='123456:abcdefghijklmnopqrstuvwxyzABCDE';
// Public development fixture only. No test wallet may hold real funds.
const PHRASE='test test test test test test test test test test test junk';
function auth(id=42,{date=Math.floor(Date.now()/1000),extra={}}={}){
  const fields=new URLSearchParams({auth_date:String(date),query_id:'test_query',user:JSON.stringify({id,first_name:'Local fixture'}),...extra});
  const check=[...fields.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(TOKEN).digest();
  fields.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return fields.toString();
}
async function seal(session,fields){
  const key=await webcrypto.subtle.importKey('jwk',session.publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const bytes=new TextEncoder().encode(JSON.stringify({id:session.id,...fields}));
  return Buffer.from(await webcrypto.subtle.encrypt({name:'RSA-OAEP'},key,bytes)).toString('base64');
}
test('Mini App authentication verifies the signed owner, age, duplicates and private context',()=>{
  assert.equal(validateInitData(auth(),TOKEN,'42').id,42);
  assert.equal(validateInitData(auth(42,{extra:{signature:'signed-extra-field'}}),TOKEN,'42').id,42);
  assert.throws(()=>validateInitData(auth(99),TOKEN,'42'),/owner/);
  assert.throws(()=>validateInitData(auth().replace('test_query','tampered'),TOKEN,'42'),/authentication/);
  assert.throws(()=>validateInitData(auth(42,{date:Math.floor(Date.now()/1000)-301}),TOKEN,'42'),/expired/);
  assert.throws(()=>validateInitData(auth(42,{date:Math.floor(Date.now()/1000)+60}),TOKEN,'42'),/expired/);
  assert.throws(()=>validateInitData(auth()+'&user={}',TOKEN,'42'),/authentication/);
  assert.throws(()=>validateInitData(auth(42,{extra:{chat_type:'group'}}),TOKEN,'42'),/private/);
});
test('browser-compatible encrypted requests are owner-bound, expiring and usable once',async()=>{
  const sessions=await SecretSessions.create();
  try{
    let session=sessions.issue('42');const data={action:'import',privateKey:walletFromSeed(PHRASE).privateKey,password:'test-password-only'};
    const encrypted=await seal(session,data);assert.ok(!encrypted.includes(data.password));
    assert.deepEqual(sessions.consume(session.id,encrypted,'42'),{id:session.id,...data});
    assert.throws(()=>sessions.consume(session.id,encrypted,'42'),/already used/);
    session=sessions.issue('42');assert.throws(()=>sessions.consume(session.id,encrypted,'99'),/expired/);
    session=sessions.issue('42',1);assert.throws(()=>sessions.consume(session.id,encrypted,'42',300002),/expired/);
    session=sessions.issue('42');const unexpected=await seal(session,{...data,phrase:PHRASE});
    assert.throws(()=>sessions.consume(session.id,unexpected,'42'),/Invalid encrypted/);
  }finally{sessions.close();}
});
test('HTTP wallet form imports, locks, unlocks and backs up without sending secrets through chat',async()=>{
  const root=await mkdtemp(join(tmpdir(),'arb-mini-app-'));let webapp;
  const cfg=loadConfig({BOT_TOKEN:TOKEN,APP_PUBLIC_URL:'https://wallet.example.com',WALLET_FILE:join(root,'wallet.json'),STATE_FILE:join(root,'state.json')});
  const store=new StateStore(cfg.stateFile);await store.load();store.state.ownerId='42';await store.save();
  const engine=new TradingEngine(cfg,store),sent=[];
  const telegram={async send(id,text,keyboard){sent.push({id,text,keyboard});},async call(){return true;}};
  const app=new BotApp({cfg,store,engine,telegram,env:{BOT_TOKEN:TOKEN,APP_PUBLIC_URL:cfg.appUrl,WALLET_FILE:cfg.walletFile,STATE_FILE:cfg.stateFile}});
  const wallet=walletFromSeed(PHRASE),password='only-a-local-test-password';
  try{
    webapp=await startWebApp({cfg,store,app,port:0});const base=`http://127.0.0.1:${webapp.port}`;
    async function post(path,body={},origin=cfg.appUrl){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({initData:auth(),...body})});return {status:r.status,data:await r.json()};}
    const html=await fetch(base+'/');assert.equal(html.status,200);assert.equal(html.headers.get('cache-control'),'no-store, max-age=0');assert.ok(html.headers.get('content-security-policy').includes("connect-src 'self'"));
    assert.ok((await html.text()).includes('Import seed'));
    const module=await fetch(base+'/ethers.js');assert.equal(module.status,200);assert.ok((await module.text()).includes('HDNodeWallet'));
    assert.equal((await post('/api/session',{},'https://untrusted.example')).status,403);
    assert.equal((await post('/api/session',{initData:auth(99)})).status,400);
    let session=(await post('/api/session')).data;assert.equal(session.hasWallet,false);
    const body={id:session.id,sealed:await seal(session,{action:'import',privateKey:wallet.privateKey,password})};
    const imported=await post('/api/wallet',body);assert.equal(imported.status,200);assert.equal(imported.data.address,wallet.address);assert.equal(engine.isUnlocked(),true);
    assert.equal((await post('/api/wallet',body)).status,400);
    const encrypted=await readFile(cfg.walletFile,'utf8'),state=await readFile(cfg.stateFile,'utf8');
    for(const secret of [PHRASE,password,wallet.privateKey.slice(2)]){assert.ok(!encrypted.includes(secret));assert.ok(!state.includes(secret));assert.ok(!JSON.stringify(sent).includes(secret));}
    const backup=await post('/api/backup');assert.equal(backup.status,200);assert.equal(backup.data.keystore,encrypted);
    await app.command({name:'lock',args:''});assert.equal(engine.isUnlocked(),false);
    session=(await post('/api/session')).data;assert.equal(session.hasWallet,true);assert.equal(session.unlocked,false);
    assert.equal((await post('/api/wallet',{id:session.id,sealed:await seal(session,{action:'unlock',password:'incorrect-password'})})).status,400);
    session=(await post('/api/session')).data;
    const unlocked=await post('/api/wallet',{id:session.id,sealed:await seal(session,{action:'unlock',password})});
    assert.equal(unlocked.status,200);assert.equal(engine.isUnlocked(),true);assert.equal(store.state.trading,false);
    assert.equal((await Wallet.fromEncryptedJson(encrypted,password)).address,wallet.address);
  }finally{if(webapp)await webapp.close();engine.close();await store.queue;await rm(root,{recursive:true,force:true});}
});
