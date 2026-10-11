import {ContractFactory,getCreateAddress} from 'ethers';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {readRuntimeConfig} from '../lib/settings.mjs';
import {connectChain,artifact} from '../lib/chain.mjs';
import {cliOptions,localSigner,prepareTransaction,sendPrepared,showPreview} from '../lib/cli.mjs';
import {safeError} from '../lib/errors.mjs';
async function main(){
  const options=cliOptions(process.argv.slice(2)),cfg=await readRuntimeConfig();
  if(cfg.perChain[options.chain].executor)throw new Error('An executor is already configured. Use npm run check to validate it.');
  const file=new URL('../data/deployments.json',import.meta.url);
  let deployments={};try{deployments=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(deployments[options.chain])throw new Error('A deployment is already recorded for this chain. Use its address; verify its transaction before any redeployment.');
  const wallet=await localSigner(cfg,options.send),c=await connectChain(cfg,options.chain,wallet);
  try{
    const data=await artifact(),factory=new ContractFactory(data.abi,data.bytecode,c.signer),n=c.n;
    const request=await factory.getDeployTransaction(wallet.address,n.quoteAddress,n.assetAddress,n.flashPool,...n.routers.map(r=>r.address));
    const prepared=await prepareTransaction(c,request,cfg,c.settings.gasCap*10n);
    console.log(`Deploy on ${n.name} (chain ${n.chainId}), owner ${wallet.address}.`);showPreview(c,prepared);
    if(!options.send){console.log('Preview only. Append --send to deploy this contract.');return;}
    const predicted=getCreateAddress({from:wallet.address,nonce:prepared.transaction.nonce});
    const receipt=await sendPrepared(c,prepared,cfg,async hash=>{
      deployments[options.chain]={address:predicted,transactionHash:hash,chainId:n.chainId,owner:wallet.address,status:'pending'};
      await mkdir(new URL('../data/',import.meta.url),{recursive:true,mode:0o700});
      await writeFile(file,JSON.stringify(deployments,null,2)+'\n',{mode:0o600});
    });
    deployments[options.chain]={address:receipt.contractAddress,transactionHash:receipt.hash,chainId:n.chainId,owner:wallet.address};
    await mkdir(new URL('../data/',import.meta.url),{recursive:true,mode:0o700});
    await writeFile(file,JSON.stringify(deployments,null,2)+'\n',{mode:0o600});
    console.log(`Set ${options.chain.toUpperCase()}_EXECUTOR_ADDRESS=${receipt.contractAddress} in .env.`);
  }finally{c.provider.destroy();}
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
