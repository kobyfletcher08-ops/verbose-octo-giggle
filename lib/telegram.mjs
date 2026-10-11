import {setTimeout as delay} from 'node:timers/promises';
export class TelegramError extends Error {
  constructor(method,code,retryAfter=0){super(`Telegram ${method} failed (${code}).`);this.status=code;this.retryAfter=retryAfter;}
}
export class Telegram {
  constructor(token,{fetchImpl=fetch,signal}={}){
    if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))throw new Error('Set BOT_TOKEN to the token from BotFather.');
    this.token=token;this.fetch=fetchImpl;this.signal=signal;
  }
  async call(method,params={},form=null){
    for(let attempt=0;attempt<3;attempt++){
      let response,data;
      try{
        const timeout=AbortSignal.timeout(method==='getUpdates'?35000:15000);
        const signal=this.signal?AbortSignal.any([this.signal,timeout]):timeout;
        response=await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',...(form?{}:{headers:{'content-type':'application/json'}}),body:form??JSON.stringify(params),signal});
        data=await response.json();
      }catch{if(this.signal?.aborted)throw new Error('Stopped.');throw new Error(`Telegram ${method} network request failed.`);}
      if(response.ok&&data.ok)return data.result;
      const error=new TelegramError(method,data.error_code??response.status,data.parameters?.retry_after??0);
      if(error.status===429&&attempt<2){await delay(Math.min(Math.max(error.retryAfter,1),60)*1000,undefined,{signal:this.signal});continue;}
      throw error;
    }
  }
  async send(chatId,text,keyboard){
    if(!text.length||text.length>4000)throw new Error('Telegram message is outside the local length limit.');
    return this.call('sendMessage',{chat_id:chatId,text,link_preview_options:{is_disabled:true},...(keyboard?{reply_markup:keyboard}:{})});
  }
  document(chatId,name,content,caption=''){
    const form=new FormData();form.append('chat_id',String(chatId));
    form.append('document',new Blob([content],{type:'application/json'}),name);
    if(caption)form.append('caption',caption);
    return this.call('sendDocument',{},form);
  }
}
export const COMMANDS=[
  ['start','Pair this private bot and show controls'],['setup','Set up wallet, contracts and trading in Telegram'],['scan','Get fresh DEX round-trip quotes'],
  ['watch','Enable or disable opportunity alerts'],['trade','Enable or disable automatic execution'],
  ['pause','Stop all automatic scans and trading'],['status','Show mode, limits and transaction state'],
  ['settings','Show trading configuration'],['size','Set trade size within the local cap'],
  ['chains','Select base, bsc or both'],['wallet','Show wallet address and balances'],
  ['configure','List every editable setting'],['set','Change a setting without restarting'],
  ['mode','Switch paper or live mode'],['funding','Choose flashloan or funded mode'],
  ['import','Import a seed or create a wallet inside Telegram'],['unlock','Unlock wallet in the built-in form'],['lock','Lock the wallet and pause trading'],['deposit','Show wallet funding details'],
  ['backup','Receive your encrypted wallet backup in this chat'],
  ['deploy','Preview and confirm an executor deployment'],['executor','Verify and attach an existing executor'],
  ['approve','Preview a bounded token approval'],['revoke','Revoke executor token approval'],
  ['withdraw','Preview a native or quote-token withdrawal'],['check','Verify chain, DEX and executor setup'],['history','Show confirmed transaction history'],
  ['pending','Show unresolved transaction hashes'],['reconcile','Check transaction confirmations'],
  ['help','Show commands and wallet setup'],['id','Show your Telegram user ID']
].map(([command,description])=>({command,description}));
