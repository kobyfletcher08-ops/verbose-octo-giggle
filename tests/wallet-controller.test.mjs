import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHmac,webcrypto} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Wallet,HDNodeWallet,Mnemonic} from 'ethers';
import {loadConfig} from '../lib/config.mjs';
import {StateStore} from '../lib/state.mjs';
import {TradingEngine} from '../lib/engine.mjs';
import {BotApp} from '../lib/bot-app.mjs';
import {startWebApp} from '../lib/webapp-server.mjs';
// A DOM fixture exercises the shipped controller; it does not verify browser layout or Telegram rendering.
class Element {
  constructor(){this.hidden=true;this.checked=false;this.value='';this.textContent='';this.handlers={};this.disabled=false;this.classList={toggle(){}};}
  addEventListener(name,callback){this.handlers[name]=callback;}
  async trigger(name){return this.handlers[name]?.({preventDefault(){}});}
}
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('Controller did not finish.');await new Promise(resolve=>setTimeout(resolve,10));}}
test('the shipped wallet controller derives client-side and submits only encrypted data, then clears fields',async()=>{
  const root=await mkdtemp(join(tmpdir(),'arb-controller-')),token='123456:abcdefghijklmnopqrstuvwxyzABCDE';let webapp;
  const cfg=loadConfig({BOT_TOKEN:token,APP_PUBLIC_URL:'https://wallet.example.com',WALLET_FILE:join(root,'wallet.json'),STATE_FILE:join(root,'state.json')});
  const store=new StateStore(cfg.stateFile);await store.load();store.state.ownerId='42';await store.save();
  const engine=new TradingEngine(cfg,store),sent=[],posts=[],elements=new Map(),windowHandlers={};
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  element('path').value="m/44'/60'/0'/0/0";
  const app=new BotApp({cfg,store,engine,telegram:{async send(id,text){sent.push(text);}}});
  const fields=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'controller_fixture',user:JSON.stringify({id:42,first_name:'Fixture'})});
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  fields.set('hash',createHmac('sha256',secret).update([...fields.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
  const phrase='test test test test test test test test test test test junk',password='controller-development-password';
  try{
    webapp=await startWebApp({cfg,store,app,port:0});const base=`http://127.0.0.1:${webapp.port}`;
    const context=vm.createContext({Wallet,HDNodeWallet,Mnemonic,TextEncoder,Uint8Array,crypto:webcrypto,btoa,Blob,URL,setTimeout,
      document:{getElementById:element,querySelectorAll(){return [...elements.values()];},createElement(){return {click(){}};}},
      window:{isSecureContext:true,Telegram:{WebApp:{initData:fields.toString(),ready(){},expand(){},enableClosingConfirmation(){},disableClosingConfirmation(){},close(){}}},addEventListener(name,handler){windowHandlers[name]=handler;}},
      fetch:async(path,options)=>{posts.push(options.body);return fetch(base+path,{...options,headers:{...options.headers,Origin:cfg.appUrl}});}
    });
    const source=(await readFile(new URL('../webapp/wallet.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
    vm.runInContext(source,context);await until(()=>element('setup').hidden===false);
    element('phrase').value=phrase;await element('import-form').trigger('submit');
    assert.equal(element('address').textContent,'0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');assert.equal(element('phrase').value,'');
    element('phrase').value='bad words';await element('import-form').trigger('submit');assert.equal(element('review').hidden,true);
    element('phrase').value=phrase;await element('import-form').trigger('submit');
    element('password').value=password;element('repeat').value=password;element('address-checked').checked=true;
    await element('save-form').trigger('submit');assert.equal(engine.isUnlocked(),true);assert.ok(element('status').textContent.startsWith('Wallet ready:'));
    assert.equal(element('password').value,'');assert.equal(element('repeat').value,'');
    for(const value of [phrase,password,engine.wallet.privateKey]){assert.ok(!posts.join('\n').includes(value));assert.ok(!sent.join('\n').includes(value));}
    assert.ok(posts.some(post=>JSON.parse(post).sealed));
    windowHandlers.pagehide();assert.equal(element('review').hidden,true);
  }finally{if(webapp)await webapp.close();engine.close();await store.queue;await rm(root,{recursive:true,force:true});}
});
