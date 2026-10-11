import {readRuntimeConfig} from '../lib/settings.mjs';
import {connectChain} from '../lib/chain.mjs';
import {parseAmount,formatAmount} from '../lib/math.mjs';
import {cliOptions,localSigner,prepareTransaction,sendPrepared,showPreview} from '../lib/cli.mjs';
import {safeError} from '../lib/errors.mjs';
async function main(){
  const options=cliOptions(process.argv.slice(2),{amount:true}),cfg=await readRuntimeConfig();
  const wallet=await localSigner(cfg,options.send),c=await connectChain(cfg,options.chain,wallet);
  try{
    if(!c.executor)throw new Error('Deploy and configure the executor first.');
    const wanted=parseAmount(options.amount??cfg.maxAmount,c.n.quoteDecimals);
    if(wanted>parseAmount(cfg.maxAmount,c.n.quoteDecimals))throw new Error('Approval amount exceeds MAX_TRADE_SIZE.');
    const current=await c.token.allowance(wallet.address,c.settings.executor);
    if(current===wanted){console.log('Allowance already matches.');return;}
    console.log(`Allowance ${formatAmount(current,c.n.quoteDecimals)} -> ${formatAmount(wanted,c.n.quoteDecimals)} ${c.n.quote}; spender ${c.settings.executor}.`);
    // USDT-style reset-to-zero approvals, with a bounded amount, never unlimited.
    const values=current!==0n&&wanted!==0n?[0n,wanted]:[wanted];
    for(const [index,value] of values.entries()){
      if(!options.send&&index>0){console.log(`Then set the allowance to ${formatAmount(value,c.n.quoteDecimals)} ${c.n.quote}; this is estimated after the reset confirms when using --send.`);continue;}
      const request={to:c.n.quoteAddress,data:c.token.interface.encodeFunctionData('approve',[c.settings.executor,value])};
      const prepared=await prepareTransaction(c,request,cfg);showPreview(c,prepared);
      if(options.send)await sendPrepared(c,prepared,cfg);
      else console.log('Preview only. Append --send to set this allowance.');
    }
  }finally{c.provider.destroy();}
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
