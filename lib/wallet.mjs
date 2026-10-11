import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Wallet,HDNodeWallet,Mnemonic} from 'ethers';
import {secret} from './terminal.mjs';
export function walletFromSeed(phrase,passphrase='',path="m/44'/60'/0'/0/0") {
  try {
    const normalized=phrase.trim().replace(/\s+/g,' ');
    if(!Mnemonic.isValidMnemonic(normalized))throw new Error();
    const derived=HDNodeWallet.fromPhrase(normalized,passphrase,path);
    // Encrypt only the derived private key. The seed and BIP-39 passphrase are not saved.
    return new Wallet(derived.privateKey);
  }catch{throw new Error('Invalid seed phrase or derivation path.');}
}
export async function saveWallet(wallet,password,file) {
  if(password.length<12)throw new Error('Use an encryption password of at least 12 characters.');
  const encrypted=await wallet.encrypt(password);
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  await writeFile(file,encrypted+'\n',{flag:'wx',mode:0o600});
}
async function privateFile(file) {
  const info=await stat(file);
  if(!info.isFile())throw new Error('Wallet/password path is not a regular file.');
  if(process.platform!=='win32'&&(info.mode&0o077))throw new Error('Set wallet/password file permissions to 600.');
}
export async function decryptWallet(cfg,password) {
  await privateFile(cfg.walletFile);
  try{return await Wallet.fromEncryptedJson(await readFile(cfg.walletFile,'utf8'),password);}
  catch{throw new Error('Cannot unlock the wallet: incorrect password or damaged keystore.');}
}
export async function encryptedWallet(cfg){await privateFile(cfg.walletFile);return readFile(cfg.walletFile,'utf8');}
export async function unlockWallet(cfg,{optional=false}={}) {
  try{await privateFile(cfg.walletFile);}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}
  let password;
  if(cfg.passwordFile){await privateFile(cfg.passwordFile);password=(await readFile(cfg.passwordFile,'utf8')).replace(/\r?\n$/,'');}
  else password=await secret('Wallet encryption password (hidden): ');
  try{return await decryptWallet(cfg,password);}
  finally{password='';}
}
export async function walletAddress(cfg) {
  try{
    const data=JSON.parse(await readFile(cfg.walletFile,'utf8'));
    if(!/^[0-9a-fA-F]{40}$/.test(data.address??''))throw new Error('Invalid keystore address.');
    return '0x'+data.address;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
