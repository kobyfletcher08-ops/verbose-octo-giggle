import {loadConfig} from '../lib/config.mjs';
import {ask,secret} from '../lib/terminal.mjs';
import {walletFromSeed,saveWallet} from '../lib/wallet.mjs';
async function main(){
  const cfg=loadConfig();
  console.log('Local wallet import. Enter a BIP-39 seed phrase for a dedicated trading wallet.');
  let phrase=await secret('Seed phrase (hidden): ');
  let passphrase=await secret('Optional BIP-39 passphrase (hidden; Enter for none): ');
  const path=(await ask("Derivation path [m/44'/60'/0'/0/0]: "))||"m/44'/60'/0'/0/0";
  const wallet=walletFromSeed(phrase,passphrase,path);phrase='';passphrase='';
  console.log('Derived wallet address: '+wallet.address);
  const password=await secret('New keystore encryption password (12+ characters, hidden): ');
  const confirm=await secret('Repeat encryption password (hidden): ');
  if(password!==confirm)throw new Error('Passwords do not match.');
  await saveWallet(wallet,password,cfg.walletFile);
  console.log('Encrypted wallet saved. Fund this address with native gas on each selected chain.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
