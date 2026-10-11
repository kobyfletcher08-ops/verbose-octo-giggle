import {Wallet,HDNodeWallet,Mnemonic} from '/ethers.js';
const $=id=>document.getElementById(id),tg=window.Telegram?.WebApp;
let session=null,wallet=null,generated=false,busy=false;
const encoder=new TextEncoder();
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function clearSecrets(){for(const id of ['phrase','bip39','password','repeat','unlock-password'])$(id).value='';$('generated-phrase').textContent='';$('review').hidden=true;$('backed-up').checked=false;$('address-checked').checked=false;wallet=null;generated=false;}
function controls(disabled){document.querySelectorAll('button').forEach(button=>button.disabled=disabled);}
async function api(path,body={}){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:tg.initData,...body}),cache:'no-store',credentials:'omit'});
  const data=await response.json();if(!response.ok)throw new Error(data.error??'Request failed.');return data;
}
async function initialize(){
  if(!tg?.initData||!window.isSecureContext){status('Open this form using the Wallet button in your private Telegram bot.',true);return;}
  tg.ready();tg.expand();tg.enableClosingConfirmation?.();
  try{
    session=await api('/api/session');
    $('setup').hidden=session.hasWallet;$('existing').hidden=!session.hasWallet;
    $('existing-address').textContent=session.address??'';
    status(session.hasWallet?(session.unlocked?'Wallet already unlocked. Use the chat controls to deploy and trade.':'Wallet locked. Enter its encryption password below.'):'Import an existing seed phrase or create a new trading wallet.');
    $('unlock-form').hidden=session.unlocked;
  }catch(e){status(e.message,true);}
}
function review(derived,isGenerated){
  wallet=new Wallet(derived.privateKey);generated=isGenerated;
  $('address').textContent=wallet.address;$('review').hidden=false;$('new-seed').hidden=!generated;
  $('address-checked').checked=false;$('backed-up').checked=false;
  status('Check the full wallet address, then choose an encryption password.');
}
function switchTab(create){
  clearSecrets();generated=false;$('review').hidden=true;$('import-form').hidden=create;$('create-form').hidden=!create;
  $('create-tab').classList.toggle('selected',create);$('import-tab').classList.toggle('selected',!create);
}
$('import-tab').addEventListener('click',()=>switchTab(false));$('create-tab').addEventListener('click',()=>switchTab(true));
$('import-form').addEventListener('submit',event=>{
  event.preventDefault();if(busy||!session)return;
  wallet=null;$('review').hidden=true;
  try{
    const phrase=$('phrase').value.trim().replace(/\s+/g,' ');
    if(!Mnemonic.isValidMnemonic(phrase))throw new Error();
    const derived=HDNodeWallet.fromPhrase(phrase,$('bip39').value,$('path').value.trim());
    review(derived,false);$('phrase').value='';$('bip39').value='';
  }catch{status('Invalid English seed phrase, passphrase or account path. Check your wallet backup.',true);}
});
$('generate').addEventListener('click',()=>{
  if(busy||!session)return;
  const entropy=crypto.getRandomValues(new Uint8Array(32)),mnemonic=Mnemonic.fromEntropy(entropy);
  const derived=HDNodeWallet.fromMnemonic(mnemonic);review(derived,true);
  $('generated-phrase').textContent=mnemonic.phrase;entropy.fill(0);
});
async function submitSecret(action,password,privateKey){
  if(busy||!session)return;
  if(encoder.encode(password).length>96)throw new Error('Password must be at most 96 UTF-8 bytes.');
  busy=true;controls(true);status('Encrypting the request and updating your wallet…');
  let plaintext;
  try{
    const key=await crypto.subtle.importKey('jwk',session.publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    plaintext=encoder.encode(JSON.stringify({id:session.id,action,password,...(privateKey?{privateKey}:{})}));
    const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,plaintext));
    const sealed=btoa(String.fromCharCode(...encrypted));
    const result=await api('/api/wallet',{id:session.id,sealed});
    clearSecrets();$('setup').hidden=true;$('existing').hidden=true;$('return').hidden=false;
    tg.disableClosingConfirmation?.();status(`Wallet ready: ${result.address}. Return to the bot and tap Setup.`);
  }catch(e){clearSecrets();$('review').hidden=true;status(e.message,true);await initialize();throw e;}
  finally{plaintext?.fill(0);password='';privateKey='';busy=false;controls(false);}
}
$('save-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!wallet||busy)return;
  try{
    const password=$('password').value;
    if(password.length<12)throw new Error('Choose a password with at least 12 characters.');
    if(password!==$('repeat').value)throw new Error('The passwords do not match.');
    if(generated&&!$('backed-up').checked)throw new Error('Save the new seed phrase before continuing.');
    if(!$('address-checked').checked)throw new Error('Confirm the wallet address before continuing.');
    await submitSecret('import',password,wallet.privateKey);
  }catch(e){status(e.message,true);}
});
$('unlock-form').addEventListener('submit',async event=>{
  event.preventDefault();try{await submitSecret('unlock',$('unlock-password').value);}catch(e){status(e.message,true);}
});
$('backup').addEventListener('click',async()=>{
  try{
    const {keystore}=await api('/api/backup'),url=URL.createObjectURL(new Blob([keystore],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='trading-wallet-encrypted.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);status('Encrypted backup downloaded. Its password is still required to unlock it.');
  }catch(e){status(e.message,true);}
});
$('return').addEventListener('click',()=>tg?.close());
window.addEventListener('pagehide',clearSecrets);
initialize();
