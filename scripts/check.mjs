import {VoidSigner} from 'ethers';
import {readRuntimeConfig} from '../lib/settings.mjs';
import {StateStore} from '../lib/state.mjs';
import {walletAddress} from '../lib/wallet.mjs';
import {TradingEngine} from '../lib/engine.mjs';
import {formatReport} from '../lib/bot-app.mjs';
import {safeError} from '../lib/errors.mjs';
async function main(){
  const cfg=await readRuntimeConfig(),store=new StateStore(cfg.stateFile);await store.load();
  const address=await walletAddress(cfg),engine=new TradingEngine(cfg,store,address?new VoidSigner(address):null);
  try{
    for(const key of store.state.chains){
      try{
        const report=await engine.scanChain(key);console.log(formatReport(report));
        console.log('Full simulation ready: '+report.ready);
        const row=report.rows.find(r=>r.profitable);
        if(row&&report.ready){await engine.simulate(report,row);console.log('Full atomic transaction simulation passed.');}
      }catch(e){console.error(`${key}: ${safeError(e)}`);process.exitCode=1;}
    }
  }finally{engine.close();}
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
