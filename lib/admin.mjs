import {randomBytes} from 'node:crypto';
import {ContractFactory,getAddress,getCreateAddress,ZeroAddress} from 'ethers';
import {artifact,verifiedExecutor,same} from './chain.mjs';
import {prepareTransaction,signPrepared} from './cli.mjs';
import {parseAmount,formatAmount} from './math.mjs';

export class AdminService {
  constructor({cfg,store,engine}){this.cfg=cfg;this.store=store;this.engine=engine;this.plans=new Map();this.reconciling=false;}
  invalidate(){this.plans.clear();}
  assertIdle({unlocked=true}={}){
    if(this.engine.busy||this.engine.reconciling||this.reconciling||this.engine.hasPending())throw new Error('A transaction is busy or unresolved. Use /pending and /reconcile first.');
    if(!this.engine.wallet)throw new Error('Import or create a wallet using /wallet first.');
    if(unlocked&&!this.engine.isUnlocked())throw new Error('Unlock the wallet using /unlock first.');
  }
  async pause(){this.store.state.trading=false;await this.store.save();}
  async request(kind,key,params={}){
    if(!['base','bsc'].includes(key))throw new Error('Choose base or bsc.');
    this.assertIdle();await this.pause();this.engine.busy=true;
    try{
      const c=await this.engine.chain(key);
      if(kind==='approve')params={...params,amount:formatAmount(parseAmount(params.amount,c.n.quoteDecimals),c.n.quoteDecimals,c.n.quoteDecimals)};
      if(kind==='withdraw')params={...params,amount:formatAmount(parseAmount(params.amount,['native',c.n.native.toLowerCase()].includes(params.token.toLowerCase())?18:c.n.quoteDecimals),['native',c.n.native.toLowerCase()].includes(params.token.toLowerCase())?18:c.n.quoteDecimals,18)};
      const built=await this.build(kind,c,params);
      if(built.done)return {done:true,text:built.description};
      const budget=kind==='deploy'?c.settings.gasCap*10n:c.settings.gasCap;
      const prepared=await prepareTransaction(c,built.request,this.cfg,budget);
      if(await c.provider.getBalance(c.signer.address)<prepared.reserve+BigInt(built.request.value??0))throw new Error('Fund this wallet with native gas before continuing. Use /deposit.');
      const id=randomBytes(8).toString('hex');
      this.plans.clear();
      this.plans.set(id,{id,kind,key,params,request:built.request,owner:c.signer.address,nonce:prepared.transaction.nonce,expires:Date.now()+120000,budget});
      const predicted=kind==='deploy'?getCreateAddress({from:c.signer.address,nonce:prepared.transaction.nonce}):null;
      return {id,text:[
        `${kind.toUpperCase()} preview — ${c.n.name} (chain ${c.n.chainId})`,
        built.description,`Wallet: ${c.signer.address}`,
        ...(predicted?[`Executor address: ${predicted}`]:[]),
        `Estimated fee reserve: ${formatAmount(prepared.reserve,18,10)} ${c.n.native}`,
        `Maximum permitted fee: ${formatAmount(budget,18,10)} ${c.n.native}`,
        'This sends a REAL transaction, including when trading mode is paper.',
        'Review the chain, amount and full addresses. Confirm within 2 minutes. Automatic trading is paused.'
      ].join('\n')};
    }finally{this.engine.busy=false;}
  }
  async build(kind,c,params){
    const {n}=c;
    if(kind==='deploy'){
      if(c.settings.executor||this.cfg.perChain[n.key].executor)throw new Error('An executor is already configured. Use /check.');
      const data=await artifact(),factory=new ContractFactory(data.abi,data.bytecode,c.signer);
      return {request:await factory.getDeployTransaction(c.signer.address,n.quoteAddress,n.assetAddress,n.flashPool,...n.routers.map(r=>r.address)),description:'Deploy the included atomic DEX executor owned by your wallet.'};
    }
    if(kind==='approve'){
      if(!c.executor)throw new Error('Deploy or attach the executor first.');
      const wanted=parseAmount(params.amount,n.quoteDecimals);
      if(wanted>parseAmount(this.cfg.maxAmount,n.quoteDecimals))throw new Error('Approval exceeds the maximum trade size.');
      const current=await c.token.allowance(c.signer.address,c.settings.executor);
      if(current===wanted)return {done:true,description:'The token allowance already matches the requested amount.'};
      const reset=current!==0n&&wanted!==0n;
      const value=reset?0n:wanted;
      return {request:{to:n.quoteAddress,data:c.token.interface.encodeFunctionData('approve',[c.settings.executor,value])},
        reset,wanted,description:[
          `Token: ${n.quote} (${n.quoteAddress})`,
          `Spender: ${c.settings.executor}`,
          `Allowance: ${formatAmount(current,n.quoteDecimals,n.quoteDecimals)} → ${formatAmount(value,n.quoteDecimals,n.quoteDecimals)} ${n.quote}`,
          ...(reset?[`A zero reset is required. After it confirms, separately approve ${params.amount} ${n.quote} using the Finish approval button.`]:[])
        ].join('\n')};
    }
    if(kind==='withdraw'){
      let recipient;try{recipient=getAddress(params.to);}catch{throw new Error('Enter a valid recipient address.');}
      if(same(recipient,ZeroAddress)||same(recipient,c.signer.address)||c.settings.executor&&same(recipient,c.settings.executor))throw new Error('Choose an external recipient wallet address.');
      const native=['native',n.native.toLowerCase()].includes(params.token.toLowerCase());
      const quote=['quote',n.quote.toLowerCase()].includes(params.token.toLowerCase());
      if(!native&&!quote)throw new Error(`Supported withdrawals: ${n.native} or ${n.quote}.`);
      const amount=parseAmount(params.amount,native?18:n.quoteDecimals);
      if(amount<=0n)throw new Error('Withdrawal amount must be above zero.');
      if(native&&await c.provider.getBalance(c.signer.address)<amount)throw new Error('Insufficient native-token balance.');
      if(quote&&await c.token.balanceOf(c.signer.address)<amount)throw new Error('Insufficient quote-token balance.');
      const request=native?{to:recipient,value:amount,data:'0x'}:{to:n.quoteAddress,data:c.token.interface.encodeFunctionData('transfer',[recipient,amount])};
      return {request,description:`Send ${params.amount} ${native?n.native:n.quote}\nRecipient: ${recipient}`};
    }
    throw new Error('Unsupported setup transaction.');
  }
  async confirm(id){
    const plan=this.plans.get(id);this.plans.delete(id);
    if(!plan||plan.expires<Date.now())throw new Error('This preview expired or was already used. Request a new preview.');
    this.assertIdle();await this.pause();this.engine.busy=true;
    try{
      const c=await this.engine.chain(plan.key);
      if(!same(c.signer.address,plan.owner))throw new Error('Wallet changed. Request a new preview.');
      const built=await this.build(plan.kind,c,plan.params);
      if(built.done||!same(built.request.to??ZeroAddress,plan.request.to??ZeroAddress)||built.request.data!==plan.request.data||BigInt(built.request.value??0)!==BigInt(plan.request.value??0))throw new Error('Transaction details changed. Request a new preview.');
      const prepared=await prepareTransaction(c,built.request,this.cfg,plan.budget);
      if(prepared.transaction.nonce!==plan.nonce)throw new Error('Wallet nonce changed. Request a new preview.');
      const {raw,hash}=await signPrepared(c,prepared,this.cfg);
      const operation={kind:plan.kind,key:plan.key,owner:plan.owner,pending:{hash,nonce:plan.nonce,sentAt:Date.now()},
        ...(plan.kind==='deploy'?{address:getCreateAddress({from:plan.owner,nonce:plan.nonce})}:{}),
        ...(built.reset?{nextApproval:plan.params.amount}:{}),
        feeReserve:prepared.reserve.toString()};
      this.store.state.operations??={};this.store.state.operations[plan.key]=operation;
      // Persist the intended hash before attempting a broadcast. A timeout never causes a retry.
      await this.store.save();
      try{const result=await c.provider.broadcastTransaction(raw);if(!same(result.hash,hash))throw new Error();}
      catch{this.store.state.trading=false;await this.store.save();throw new Error('Broadcast result is uncertain. The intended hash is saved. Use /pending and /reconcile; do not repeat this action.');}
      return {key:plan.key,kind:plan.kind,hash};
    }finally{this.engine.busy=false;}
  }
  cancel(id){this.plans.delete(id);}
  async attach(key,address){
    if(!['base','bsc'].includes(key))throw new Error('Choose base or bsc.');
    this.assertIdle({unlocked:false});await this.pause();this.engine.busy=true;
    try{const c=await this.engine.chain(key);const executor=await verifiedExecutor(c,getAddress(address),this.engine.wallet);await this.recordExecutor(key,address,c,executor);}
    finally{this.engine.busy=false;}
  }
  async recordExecutor(key,address,c,executor){
    this.store.state.executors??={};this.store.state.executors[key]=getAddress(address);await this.store.save();
    this.cfg.perChain[key].executor=getAddress(address);c.settings.executor=getAddress(address);c.executor=executor;
  }
  async reconcile(){
    if(this.reconciling||this.engine.busy)return [];this.reconciling=true;
    const notices=[];
    try{
      for(const [key,op] of Object.entries(this.store.state.operations??{})){
        if(!op.pending)continue;
        const c=await this.engine.chain(key),receipt=await c.provider.getTransactionReceipt(op.pending.hash);
        if(!receipt||await receipt.confirmations()<2)continue;
        if(receipt.status===1&&op.kind==='deploy'){
          if(!receipt.contractAddress||!same(receipt.contractAddress,op.address))throw new Error('Deployment receipt address mismatch. The pending record is retained.');
          const executor=await verifiedExecutor(c,op.address,this.engine.wallet);
          await this.recordExecutor(key,op.address,c,executor);
        }
        const notice={key,hash:op.pending.hash,status:receipt.status,kind:op.kind,address:op.address,nextApproval:receipt.status===1?op.nextApproval:null};
        const previousHistory=this.store.state.history??[];
        this.store.state.history=[...previousHistory,{key,hash:notice.hash,status:receipt.status,kind:op.kind,at:new Date().toISOString()}].slice(-50);
        const previousPending=op.pending;op.pending=null;
        try{await this.store.save();}
        catch(e){op.pending=previousPending;this.store.state.history=previousHistory;throw e;}
        notices.push(notice);
      }
      return notices;
    }finally{this.reconciling=false;}
  }
}
