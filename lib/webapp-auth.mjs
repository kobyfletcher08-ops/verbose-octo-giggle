import {createHmac,timingSafeEqual,randomBytes,generateKeyPair,privateDecrypt,constants} from 'node:crypto';
import {promisify} from 'node:util';

export function validateInitData(raw,token,ownerId,{now=Date.now(),maxAge=300}={}){
  if(typeof raw!=='string'||raw.length>10000||!ownerId)throw new Error('Open this form from the paired private Telegram bot.');
  const fields=new URLSearchParams(raw),seen=new Set();
  for(const [key] of fields){if(seen.has(key))throw new Error('Invalid Telegram authentication.');seen.add(key);}
  const hash=fields.get('hash');fields.delete('hash');
  if(!/^[a-fA-F0-9]{64}$/.test(hash??''))throw new Error('Invalid Telegram authentication.');
  const check=[...fields.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const calculated=createHmac('sha256',secret).update(check).digest();
  if(!timingSafeEqual(calculated,Buffer.from(hash,'hex')))throw new Error('Invalid Telegram authentication.');
  const date=Number(fields.get('auth_date'));
  if(!Number.isInteger(date)||date<now/1000-maxAge||date>now/1000+30)throw new Error('The wallet form expired. Close it and open /wallet again.');
  let user;try{user=JSON.parse(fields.get('user'));}catch{throw new Error('Invalid Telegram authentication.');}
  if(!Number.isSafeInteger(user?.id)||user.is_bot||String(user.id)!==String(ownerId))throw new Error('This wallet form is for the paired owner only.');
  if(fields.has('chat_type')&&!['private','sender'].includes(fields.get('chat_type')))throw new Error('Use the private bot chat.');
  if(fields.has('chat')){let chat;try{chat=JSON.parse(fields.get('chat'));}catch{throw new Error('Invalid chat.');}if(chat.type!=='private')throw new Error('Use the private bot chat.');}
  return user;
}

export class SecretSessions {
  static async create(){
    const keys=await promisify(generateKeyPair)('rsa',{modulusLength:3072});
    return new SecretSessions(keys);
  }
  constructor({publicKey,privateKey}){this.publicKey=publicKey.export({format:'jwk'});this.privateKey=privateKey;this.sessions=new Map();}
  issue(ownerId,now=Date.now()){
    // Only one active wallet form per owner; neither the key nor a capability is written to disk.
    for(const [id,s] of this.sessions)if(s.ownerId===String(ownerId)||s.expires<now)this.sessions.delete(id);
    const id=randomBytes(16).toString('hex');this.sessions.set(id,{ownerId:String(ownerId),expires:now+300000});
    return {id,publicKey:this.publicKey,expiresAt:now+300000};
  }
  consume(id,sealed,ownerId,now=Date.now()){
    const session=this.sessions.get(id);this.sessions.delete(id);
    if(!session||session.expires<now||session.ownerId!==String(ownerId))throw new Error('The wallet form expired or was already used. Reopen it.');
    let plain;
    try{
      if(typeof sealed!=='string'||sealed.length>600)throw new Error();
      const bytes=Buffer.from(sealed,'base64');if(bytes.length!==384)throw new Error();
      plain=privateDecrypt({key:this.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},bytes);
      const data=JSON.parse(plain.toString('utf8'));
      if(data.id!==id||!['import','unlock'].includes(data.action)||typeof data.password!=='string'||Buffer.byteLength(data.password)>96)throw new Error();
      const allowed=data.action==='import'?['id','action','password','privateKey']:['id','action','password'];
      if(Object.keys(data).some(k=>!allowed.includes(k)))throw new Error();
      if(data.action==='import'&&!/^0x[a-fA-F0-9]{64}$/.test(data.privateKey??''))throw new Error();
      return data;
    }catch{throw new Error('Invalid encrypted wallet request. Reopen the wallet form.');}
    finally{plain?.fill(0);}
  }
  close(){this.sessions.clear();this.privateKey=null;}
}
