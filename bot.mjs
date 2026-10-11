#!/usr/bin/env node
import {setTimeout as delay} from 'node:timers/promises';
import {VoidSigner} from 'ethers';
import {loadConfig} from './lib/config.mjs';
import {StateStore} from './lib/state.mjs';
import {unlockWallet,walletAddress} from './lib/wallet.mjs';
import {TradingEngine} from './lib/engine.mjs';
import {Telegram,COMMANDS} from './lib/telegram.mjs';
import {BotApp} from './lib/bot-app.mjs';
import {safeError} from './lib/errors.mjs';
import {runtimeConfig} from './lib/settings.mjs';
import {startWebApp} from './lib/webapp-server.mjs';

async function main(){
  const boot=loadConfig(),controller=new AbortController();
  const store=new StateStore(boot.stateFile);await store.load();
  const cfg=runtimeConfig(process.env,store.state);
  if(cfg.ownerId)store.state.ownerId=cfg.ownerId;
  if(store.state.activationMode!==cfg.mode)store.state.trading=false;
  let wallet=null;
  if(cfg.passwordFile)wallet=await unlockWallet(cfg,{optional:true});
  else {const address=await walletAddress(cfg);if(address)wallet=new VoidSigner(address);}
  if(cfg.mode==='live'&&!wallet?.privateKey)store.state.trading=false;
  await store.save();
  const tg=new Telegram(cfg.token,{signal:controller.signal});
  const info=await tg.call('getMe');
  const webhook=await tg.call('getWebhookInfo');
  if(webhook.url)throw new Error('This bot has a webhook. Use a new BotFather bot or remove its existing webhook before using long polling.');
  await tg.call('setMyCommands',{commands:COMMANDS});
  const engine=new TradingEngine(cfg,store,wallet),app=new BotApp({cfg,store,engine,telegram:tg,username:info.username});
  const webapp=await startWebApp({cfg,store,app});
  console.log(`@${info.username} ready. Mode: ${cfg.mode}; funding: ${cfg.funding}.`);
  if(!store.state.ownerId)console.log(`Pair in a PRIVATE Telegram chat with: /start ${app.pairCode}`);
  else console.log('Private owner pairing loaded.');
  if(!wallet)console.log('Wallet not imported. Use /wallet in Telegram to import or create one.');
  else if(!wallet.privateKey)console.log('Wallet locked. Use /unlock in Telegram when signing is needed.');
  if(webapp)console.log(`Telegram wallet form listening on ${cfg.appHost}:${webapp.port}.`);
  else console.log('Set APP_PUBLIC_URL to enable the Telegram wallet form. See README hosting setup.');
  const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let offset;
  const poll=async()=>{
    while(!controller.signal.aborted){
      try{
        const updates=await tg.call('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});
        if(!Array.isArray(updates))throw new Error('Invalid Telegram updates response.');
        for(const update of updates){
          if(!Number.isSafeInteger(update.update_id))continue;
          // Stale trading commands are never executed after a long host outage.
          const date=update.message?.date??update.callback_query?.message?.date;
          const stale=!update.callback_query&&date&&Date.now()/1000-date>120;
          if(!stale)try{await app.handle(update);}catch(e){console.error(safeError(e));}
          offset=update.update_id+1;
        }
      }catch(e){
        if(controller.signal.aborted)break;
        if(e.status===401||e.status===409){console.error(safeError(e));stop();throw new Error('Invalid token or another process is already polling this bot.');}
        console.error(safeError(e));await delay(5000,undefined,{signal:controller.signal}).catch(()=>{});
      }
    }
  };
  const monitor=async()=>{
    while(!controller.signal.aborted){
      try{await app.tick();}catch(e){if(!controller.signal.aborted)console.error(safeError(e));}
      await delay(cfg.interval*1000,undefined,{signal:controller.signal}).catch(()=>{});
    }
  };
  try{await Promise.all([poll(),monitor()]);}finally{controller.abort();if(webapp)await webapp.close();await store.queue;engine.close();}
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
