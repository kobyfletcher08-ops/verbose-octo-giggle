import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {validateInitData,SecretSessions} from './webapp-auth.mjs';
import {encryptedWallet} from './wallet.mjs';
import {safeError} from './errors.mjs';

const require=createRequire(import.meta.url);
const ethersRoot=dirname(dirname(require.resolve('ethers')));
const assets={
  '/':['text/html; charset=utf-8',new URL('../webapp/index.html',import.meta.url)],
  '/wallet.js':['text/javascript; charset=utf-8',new URL('../webapp/wallet.js',import.meta.url)],
  '/wallet.css':['text/css; charset=utf-8',new URL('../webapp/wallet.css',import.meta.url)],
  '/ethers.js':['text/javascript; charset=utf-8',join(ethersRoot,'dist','ethers.min.js')]
};
async function jsonBody(req){
  if(!(req.headers['content-type']??'').startsWith('application/json'))throw new Error('Use a JSON request.');
  let size=0;const chunks=[];
  for await(const part of req){size+=part.length;if(size>14000)throw new Error('Request is too large.');chunks.push(part);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Invalid request.');}
}
export async function startWebApp({cfg,store,app,port=cfg.appPort,host=cfg.appHost}){
  if(!cfg.appUrl)return null;
  const sessions=await SecretSessions.create(),attempts=new Map(),cached=new Map();
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Pragma','no-cache');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    const send=(code,data)=>{if(!res.destroyed){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}};
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/healthz'){send(200,{ok:true});return;}
      if(req.method==='GET'&&assets[path]){
        const [type,file]=assets[path];let content=cached.get(path);if(!content){content=await readFile(file);cached.set(path,content);}
        res.writeHead(200,{'Content-Type':type});res.end(content);return;
      }
      if(req.method!=='POST'||!['/api/session','/api/wallet','/api/backup'].includes(path)){send(404,{error:'Not found.'});return;}
      if(req.headers.origin!==cfg.appUrl){send(403,{error:'Invalid origin.'});return;}
      const source=req.socket.remoteAddress??'unknown',now=Date.now(),record=attempts.get(source);
      if(!record||now-record.at>60000){if(attempts.size>1000)attempts.clear();attempts.set(source,{at:now,count:1});}
      else if(++record.count>30){send(429,{error:'Too many requests. Try again in a minute.'});return;}
      const body=await jsonBody(req);
      validateInitData(body.initData,cfg.token,store.state.ownerId);
      if(path==='/api/session'){
        const session=sessions.issue(store.state.ownerId);
        send(200,{...session,...await app.walletStatus()});return;
      }
      if(path==='/api/backup'){
        const keystore=await encryptedWallet(cfg);send(200,{keystore});return;
      }
      let secret=sessions.consume(body.id,body.sealed,store.state.ownerId);
      try{const address=await app.changeWallet(secret.action,secret);send(200,{ok:true,address});}
      finally{secret.password='';secret.privateKey='';secret=null;}
    }catch(e){send(400,{error:safeError(e)});}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});
  return {server,port:server.address().port,async close(){sessions.close();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}};
}
