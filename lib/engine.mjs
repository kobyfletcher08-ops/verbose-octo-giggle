import {Contract,ZeroAddress,keccak256} from 'ethers';
import {connectChain,PAIR_ABI,same} from './chain.mjs';
import {ceilDiv,max,parseAmount,formatAmount,tradeBounds,validateBudget} from './math.mjs';
import {todayLedger} from './state.mjs';
import {safeError} from './errors.mjs';

export class TradingEngine {
  constructor(cfg,store,wallet=null){this.cfg=cfg;this.store=store;this.wallet=wallet;this.connections=new Map();this.initializing=new Map();this.busy=false;this.reconciling=false;this.reports=new Map();}
  async chain(key){
    if(this.connections.has(key))return this.connections.get(key);
    if(this.initializing.has(key))return this.initializing.get(key);
    const job=connectChain(this.cfg,key,this.wallet).then(c=>{this.connections.set(key,c);return c;}).finally(()=>this.initializing.delete(key));
    this.initializing.set(key,job);return job;
  }
  amount(){return this.store.state.amount??this.cfg.amount;}
  hasPending(){return Object.values(this.store.state.ledger).some(l=>l.pending)||Object.values(this.store.state.operations??{}).some(op=>op.pending);}
  isUnlocked(){return Boolean(this.wallet?.privateKey);}
  async refresh(wallet=this.wallet){
    if(this.busy||this.reconciling)throw new Error('A transaction is being prepared or checked. Try again when it finishes.');
    await Promise.allSettled([...this.initializing.values()]);
    this.close();this.wallet=wallet;this.reports.clear();
  }
  async scanChain(key){
    const c=await this.chain(key),{n,provider}=c;
    const block=await provider.getBlock('latest');
    const observedAt=Date.now();
    if(!block||Date.now()/1000-block.timestamp>this.cfg.maxBlockAge||block.timestamp>Date.now()/1000+10)throw new Error('RPC block timestamp is stale or the local clock is incorrect.');
    const overrides={blockTag:block.number};
    const amountIn=parseAmount(this.amount(),n.quoteDecimals);
    if(amountIn<=0n||amountIn>parseAmount(this.cfg.maxAmount,n.quoteDecimals))throw new Error('Trade size is outside the configured limit.');
    let premium=0n;
    if(this.cfg.funding==='flashloan'){
      const [fee,bits]=await Promise.all([c.pool.FLASHLOAN_PREMIUM_TOTAL(overrides),c.pool.getConfiguration(n.quoteAddress,overrides)]);
      // Aave reserve bits: active=56, paused=60, flash-loans enabled=63.
      if(!(bits&(1n<<56n))||(bits&(1n<<60n))||!(bits&(1n<<63n)))throw new Error(`${n.quote} flash loans are unavailable for this reserve.`);
      premium=ceilDiv(amountIn*fee,10000n);
    }
    const pools=[],notes=[];
    const results=await Promise.allSettled(c.routers.map(async router=>{
      const factory=new Contract(router.factory,['function getPair(address,address) view returns(address)'],provider);
      const address=await factory.getPair(n.quoteAddress,n.assetAddress,overrides);
      if(same(address,ZeroAddress))throw new Error('No direct pair.');
      const pair=new Contract(address,PAIR_ABI,provider);
      const [token0,token1,reserves]=await Promise.all([pair.token0(overrides),pair.token1(overrides),pair.getReserves(overrides)]);
      if(!((same(token0,n.quoteAddress)&&same(token1,n.assetAddress))||(same(token1,n.quoteAddress)&&same(token0,n.assetAddress))))throw new Error('Pair token verification failed.');
      const quoteReserve=same(token0,n.quoteAddress)?reserves[0]:reserves[1];
      const assetReserve=same(token0,n.assetAddress)?reserves[0]:reserves[1];
      if(quoteReserve<parseAmount(this.cfg.minReserve,n.quoteDecimals)||assetReserve===0n)throw new Error('Pool reserve is below the configured minimum.');
      return {...router,pairAddress:address,quoteReserve,assetReserve};
    }));
    for(let i=0;i<results.length;i++){const r=results[i];if(r.status==='fulfilled')pools.push(r.value);else notes.push(c.routers[i].name+': '+safeError(r.reason));}
    const rows=[];
    if(pools.length===2){
      // Conservative native-gas valuation: higher pool spot rate, plus 25% buffer.
      const gasInQuote=pools.reduce((worst,p)=>max(worst,ceilDiv(c.settings.gasCap*p.quoteReserve*12500n,p.assetReserve*10000n)),0n);
      for(const [buy,sell] of [[pools[0],pools[1]],[pools[1],pools[0]]]){
        if(amountIn*10000n>buy.quoteReserve*BigInt(this.cfg.maxReserveShareBps)){notes.push('Trade size exceeds the buy-pool reserve-share cap.');continue;}
        try{
          const first=await buy.contract.getAmountsOut(amountIn,[n.quoteAddress,n.assetAddress],overrides);
          const assetOut=first[1];
          if(assetOut*10000n>sell.assetReserve*BigInt(this.cfg.maxReserveShareBps)){notes.push('Trade size exceeds the sell-pool reserve-share cap.');continue;}
          const second=await sell.contract.getAmountsOut(assetOut,[n.assetAddress,n.quoteAddress],overrides);
          const quoteOut=second[1];
          const bounds=tradeBounds({amountIn,assetOut,quoteOut,premium,gasInQuote,minNetProfit:parseAmount(this.cfg.minProfit,n.quoteDecimals),slippageBps:this.cfg.slippageBps});
          rows.push({key,buy,sell,amountIn,assetOut,quoteOut,premium,gasInQuote,...bounds,
            profitable:bounds.estimatedNet>=parseAmount(this.cfg.minProfit,n.quoteDecimals)});
        }catch(e){notes.push(`${buy.name} -> ${sell.name}: ${safeError(e)}`);}
      }
    }
    rows.sort((a,b)=>a.estimatedNet>b.estimatedNet?-1:a.estimatedNet<b.estimatedNet?1:0);
    const report={key,n,block,observedAt,pools,rows,notes,ready:Boolean(c.executor&&c.signer)};
    this.reports.set(key,report);return report;
  }
  async simulate(report,row){
    const c=await this.chain(report.key);
    if(!c.executor||!c.signer)throw new Error('Import a wallet and deploy/configure the executor before full transaction simulation.');
    const trade={buyRouter:row.buy.address,sellRouter:row.sell.address,amountIn:row.amountIn,minAssetOut:row.minAssetOut,
      minQuoteOut:row.minQuoteOut,minProfit:row.minProfit,deadline:report.block.timestamp+60};
    const method=this.cfg.funding==='flashloan'?'executeFlash':'executeFunded';
    const profit=await c.executor[method].staticCall(trade);
    return {c,trade,method,profit};
  }
  async execute(key,row,canTrade=()=>false){
    if(this.busy||this.hasPending())throw new Error('A transaction is already being prepared or is unresolved.');
    this.busy=true;
    try{
      // Never submit the displayed/cached quote. Re-quote both legs at a new pinned block.
      const report=await this.scanChain(key);
      const fresh=report.rows.find(r=>same(r.buy.address,row.buy.address)&&same(r.sell.address,row.sell.address)&&r.profitable);
      if(!fresh)throw new Error('The opportunity no longer meets the minimum net-profit floor.');
      const {c,trade,method,profit}=await this.simulate(report,fresh);
      if(!canTrade())return {kind:'cancelled'};
      if(this.cfg.mode==='paper')return {kind:'paper',key,profit,net:profit-fresh.gasInQuote};
      if(this.cfg.mode!=='live'||!this.isUnlocked())throw new Error('Live wallet is not unlocked. Use /unlock in Telegram.');
      const ledger=todayLedger(this.store.state,key);
      if(Date.now()-ledger.lastAttemptAt<this.cfg.cooldown*1000)throw new Error('Trade cooldown is active.');
      validateBudget({cost:c.settings.gasCap,perTrade:c.settings.gasCap,dailySpent:BigInt(ledger.gasReserved),dailyLimit:c.settings.dailyGas,count:ledger.count,maxCount:this.cfg.maxDailyTrades});
      const fees=await c.provider.getFeeData();
      const price=key==='base'?fees.maxFeePerGas:fees.gasPrice;
      if(!price||price>c.settings.gasPriceCap)throw new Error('Network gas price is above the configured cap.');
      const feeFields=key==='base'?{type:2,maxFeePerGas:price,maxPriorityFeePerGas:fees.maxPriorityFeePerGas??0n}:{type:0,gasPrice:price};
      const estimate=await c.executor[method].estimateGas(trade,feeFields);
      const gasLimit=ceilDiv(estimate*125n,100n);
      if(gasLimit>1200000n)throw new Error('Unexpectedly high execution gas requirement.');
      const extra=key==='base'?this.cfg.baseExtraFeeCap:0n;
      if(gasLimit*price+extra>c.settings.gasCap)throw new Error('Execution gas plus extra-fee allowance exceeds the gas cap.');
      if(await c.provider.getBalance(c.signer.address)<c.settings.gasCap)throw new Error(`Wallet needs more ${c.n.native} for the reserved gas budget.`);
      const [nonce,confirmedNonce,network]=await Promise.all([c.provider.getTransactionCount(c.signer.address,'pending'),c.provider.getTransactionCount(c.signer.address,'latest'),c.provider.getNetwork()]);
      if(nonce!==confirmedNonce)throw new Error('Another transaction is pending from this wallet.');
      if(Number(network.chainId)!==c.n.chainId)throw new Error('RPC chain changed.');
      const data=c.executor.interface.encodeFunctionData(method,[trade]);
      const raw=await c.signer.signTransaction({to:c.settings.executor,data,value:0,chainId:c.n.chainId,nonce,gasLimit,...feeFields});
      if(key==='base'){
        const oracle=new Contract(c.n.gasOracle,['function getL1Fee(bytes) view returns(uint256)'],c.provider);
        const l1block=new Contract(c.n.l1Block,['function operatorFeeScalar() view returns(uint32)','function operatorFeeConstant() view returns(uint64)'],c.provider);
        const [l1Fee,scalar,constant]=await Promise.all([oracle.getL1Fee(raw),l1block.operatorFeeScalar(),l1block.operatorFeeConstant()]);
        // Jovian's formula upper-bounds the earlier Isthmus formula for non-negative scalars.
        const operatorBound=constant+gasLimit*scalar*100n;
        if(ceilDiv(l1Fee*150n,100n)+operatorBound>extra)throw new Error('Base L1/operator fee estimate exceeds the extra-fee allowance.');
      }
      if(Date.now()-report.observedAt>this.cfg.maxQuoteAge*1000)throw new Error('Quote expired while preparing the transaction.');
      if(!canTrade())return {kind:'cancelled'};
      const hash=keccak256(raw);
      ledger.count++;ledger.gasReserved=(BigInt(ledger.gasReserved)+c.settings.gasCap).toString();ledger.lastAttemptAt=Date.now();
      ledger.pending={hash,nonce,deadline:trade.deadline,sentAt:Date.now(),amount:fresh.amountIn.toString(),gasBudget:c.settings.gasCap.toString()};
      // Save the intended hash BEFORE broadcasting. Ambiguous RPC failures cannot trigger a duplicate.
      await this.store.save();
      if(!canTrade()){ledger.pending=null;await this.store.save();return {kind:'cancelled'};}
      try{
        const sent=await c.provider.broadcastTransaction(raw);
        if(!same(sent.hash,hash))throw new Error('RPC returned an unexpected transaction hash.');
      }catch{
        this.store.state.trading=false;await this.store.save();
        throw new Error('Broadcast result is uncertain. Trading is paused; check /pending and /reconcile before resuming.');
      }
      return {kind:'submitted',key,hash};
    }finally{this.busy=false;}
  }
  async reconcile(){
    if(this.reconciling||this.busy)return [];this.reconciling=true;
    const notices=[];
    try{
    for(const [key,ledger] of Object.entries(this.store.state.ledger)){
      if(!ledger.pending)continue;
      const c=await this.chain(key),receipt=await c.provider.getTransactionReceipt(ledger.pending.hash);
      if(!receipt||await receipt.confirmations()<2)continue;
      let profit=null;
      for(const log of receipt.logs){
        if(!same(log.address,c.settings.executor))continue;
        try{const parsed=c.executor.interface.parseLog(log);if(parsed?.name==='Executed')profit=parsed.args.profit;}catch{}
      }
      notices.push({key,hash:receipt.hash,status:receipt.status,profit,gasUsed:receipt.gasUsed,gasPrice:receipt.gasPrice});
      if(receipt.status!==1)this.store.state.trading=false;
      this.store.state.history??=[];
      this.store.state.history.push({key,hash:receipt.hash,status:receipt.status,profit:profit?.toString()??null,at:new Date().toISOString()});
      this.store.state.history=this.store.state.history.slice(-50);
      const previous=ledger.pending;ledger.pending=null;
      try{await this.store.save();}catch(e){ledger.pending=previous;throw e;}
    }
    return notices;
    }finally{this.reconciling=false;}
  }
  async balances(key){
    const c=await this.chain(key);
    if(!this.wallet)return 'No wallet imported.';
    const [native,quote]=await Promise.all([c.provider.getBalance(this.wallet.address),c.token.balanceOf(this.wallet.address)]);
    return `${key.toUpperCase()}: ${formatAmount(native,18)} ${c.n.native}; ${formatAmount(quote,c.n.quoteDecimals)} ${c.n.quote}`;
  }
  close(){for(const c of this.connections.values())c.provider.destroy();this.connections.clear();}
}
