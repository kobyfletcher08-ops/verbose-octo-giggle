import {createServer} from 'node:http';
import {RescueEngine,safeError} from './engine.mjs';
import {Telegram} from '../lib/telegram.mjs';
const env=process.env;
if(!/^\d+$/.test(env.RESCUE_OWNER_TELEGRAM_ID||''))throw Error('Set numeric RESCUE_OWNER_TELEGRAM_ID in Render');
if(!env.RESCUE_BOT_TOKEN)throw Error('Set a SEPARATE RESCUE_BOT_TOKEN in Render, not arbitrage BOT_TOKEN');
const OWNER=env.RESCUE_OWNER_TELEGRAM_ID;
const tg=new Telegram(env.RESCUE_BOT_TOKEN);
const engine=new RescueEngine({stateFile:env.RESCUE_STATE_FILE||'data/rescue-state.json'});await engine.init();
engine.notify=(s)=>tg.send(OWNER,s).catch(e=>console.error('Telegram:',safeError(e)));
let offset=0,stopped=false,ticking=false;
const help=`Self Rescue 7702 — owner-only bot\n\n/chains — list preset/custom EVM chains\n/chainadd NAME CHAINID HTTPS_PUBLIC_RPC — add chain\n/chaindel CHAINID — remove unused chain\n/import — upload a signed rescue-*.json document here\n/jobs — view rescue packages\n/check ID — check balance/authorization\n/watch on|off — toggle automatic monitoring\n/mode paper|live — change mode (live also needs ENABLE_RESCUE_LIVE=true)\n/execute ID — private-submit one armed rescue in live mode\n/status — service details\n/pause — disable watcher / switch to paper\n\nOwner key/seed phrases must NEVER enter Telegram or Render. Locally run rescue/prepare.mjs to generate a single-use signed rescue package. The relayer key ONLY pays gas. Private broadcast only; no public fallback.`;
async function respond(text){await tg.send(OWNER,String(text).slice(0,3900))}
async function handle(update){
  const msg=update.message;
  if(!msg||msg.chat?.type!=='private'||String(msg.from?.id)!==OWNER||String(msg.chat.id)!==OWNER)return;
  const text=(msg.text||'').trim();const [cmd,...args]=text.split(/\s+/);
  if(msg.document){
    if(msg.document.file_size>40000)throw Error('JSON rescue package exceeds 40 KB');
    const info=await tg.call('getFile',{file_id:msg.document.file_id});
    const r=await fetch(`https://api.telegram.org/file/bot${env.RESCUE_BOT_TOKEN}/${info.file_path}`,{signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('Could not read uploaded JSON');
    const raw=await r.text();if(raw.length>40000)throw Error('JSON package too large');
    const job=await engine.importPackage(JSON.parse(raw));
    await respond(`Imported signed rescue job ${job.id}\nWallet: ${job.owner}\nSafe: ${job.rescue.destination}\nAsset: ${job.rescue.token}\nChain ID: ${job.chainId}\nStatus: armed\nNo transaction was sent. /watch on to monitor.`);return;
  }
  if(!cmd)return;
  switch(cmd.toLowerCase().split('@')[0]){
    case '/start':case '/help':return respond(help);
    case '/status':return respond(`Mode: ${engine.state.mode}\nWatcher: ${engine.state.watch?'on':'off'}\nLive env gate: ${env.ENABLE_RESCUE_LIVE==='true'?'enabled':'disabled'}\nChains: ${engine.state.chains.length}\nJobs: ${engine.state.jobs.length}\nPrivate-only submissions. No gasless promise: relayer pays gas.`);
    case '/chains':return respond(engine.state.chains.map(c=>`${c.name}: ${c.chainId} | private RPC ${(()=>{try{engine.privateRpc(c.chainId);return 'configured'}catch{return 'missing'}})()}`).join('\n'));
    case '/chainadd':{
      if(args.length!==3)throw Error('Usage: /chainadd NAME CHAINID HTTPS_PUBLIC_RPC (no credentials)');
      await engine.addChain(args[0],Number(args[1]),args[2]);return respond('Custom chain added; verify EIP-7702 compatibility and configure private RPC in Render.');
    }
    case '/chaindel':{
      const id=Number(args[0]);if(engine.state.jobs.some(j=>j.chainId===id&&['armed','broadcast','submitting','unconfirmed'].includes(j.status)))throw Error('Cannot remove chain with active jobs');
      const len=engine.state.chains.length;engine.state.chains=engine.state.chains.filter(x=>x.chainId!==id);if(len===engine.state.chains.length)throw Error('Unknown chain');await engine.save();return respond('Chain removed.');
    }
    case '/jobs':return respond(engine.state.jobs.length?engine.state.jobs.map(x=>`${x.id} | ${x.status} | chain ${x.chainId} | ${x.rescue.token==='0x0000000000000000000000000000000000000000'?'NATIVE':x.rescue.token} | owner ${x.owner}`).join('\n'):'No jobs. Generate a signed package locally, then upload JSON as a document.');
    case '/check':{
      const job=engine.state.jobs.find(j=>j.id===args[0]);if(!job)throw Error('Unknown job ID');const data=await engine.checkJob(job);return respond(`Job ${job.id}\nStatus: ${job.status}\nBalance: ${data.balance} raw units\nThreshold: ${job.rescue.minAmount}\nReady: ${data.ready}\nDelegated: ${Boolean(data.delegated)}`);
    }
    case '/watch':if(!['on','off'].includes(args[0]))throw Error('Use /watch on or /watch off');engine.state.watch=args[0]==='on';await engine.save();return respond(`Automatic monitoring ${args[0]}. Mode: ${engine.state.mode}.`);
    case '/mode':if(!['paper','live'].includes(args[0]))throw Error('Use /mode paper or /mode live');
      if(args[0]==='live'&&env.ENABLE_RESCUE_LIVE!=='true')throw Error('Set ENABLE_RESCUE_LIVE=true on Render first');
      engine.state.mode=args[0];await engine.save();return respond(`Mode: ${args[0]}. Live auto-rescue sends real private transactions paid for by the relayer. Watcher: ${engine.state.watch}`);
    case '/execute':{
      const job=engine.state.jobs.find(j=>j.id===args[0]);if(!job)throw Error('Unknown job ID');return respond(`Private submission: ${await engine.send(job)}`);
    }
    case '/pause':engine.state.watch=false;engine.state.mode='paper';await engine.save();return respond('Monitoring stopped; mode returned to paper. Previously broadcast transactions cannot be cancelled by /pause.');
    default:return respond('Unknown command. /help');
  }
}
async function telegramLoop(){
  while(!stopped){
    try{const updates=await tg.call('getUpdates',{offset,timeout:25,allowed_updates:['message'],limit:50});
      for(const u of updates){offset=u.update_id+1;try{await handle(u)}catch(e){await respond('Error: '+safeError(e)).catch(()=>{})}}
    }catch(e){if(!stopped)console.error('Telegram polling:',safeError(e));await new Promise(r=>setTimeout(r,2500))}
  }
}
const port=Number(env.PORT||3001);
const server=createServer((req,res)=>{
  if(req.url!=='/healthz'){res.writeHead(404);res.end('not found');return}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,mode:engine.state.mode,watch:engine.state.watch}));
});
server.listen(port,'0.0.0.0');
const timer=setInterval(async()=>{if(ticking)return;ticking=true;try{await engine.tick()}catch(e){console.error('Watch:',safeError(e))}finally{ticking=false}},Math.max(5000,Number(env.RESCUE_POLL_MS||15000)));
timer.unref();
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopped=true;clearInterval(timer);server.close()});
console.log('Rescue Telegram bot started, private-only, owner',OWNER,'mode',engine.state.mode);
await telegramLoop();
