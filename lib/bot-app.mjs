import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Wallet,VoidSigner} from 'ethers';
import {parseAmount,formatAmount} from './math.mjs';
import {NETWORKS} from './networks.mjs';
import {todayLedger} from './state.mjs';
import {safeError} from './errors.mjs';
import {walletAddress,saveWallet,decryptWallet,encryptedWallet} from './wallet.mjs';
import {SETTINGS,candidateConfig} from './settings.mjs';
import {AdminService} from './admin.mjs';

export function parseCommand(text,username=''){
  const m=/^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text?.trim()??'');
  if(!m||m[2]&&username&&m[2].toLowerCase()!==username.toLowerCase())return null;
  return {name:m[1].toLowerCase(),args:(m[3]??'').trim()};
}
export function parseChains(text){
  if(text==='both')return ['base','bsc'];
  if(text==='base'||text==='bsc')return [text];
  throw new Error('Use base, bsc or both.');
}
export function formatReport(report){
  const {n,rows,block,pools,notes}=report;
  const lines=[`${n.name}: ${n.quote} -> ${n.asset} -> ${n.quote}`,`Block ${block.number} | ${new Date(block.timestamp*1000).toISOString()}`,`${pools.length}/2 qualifying direct V2 pools`];
  for(const row of rows){
    lines.push('',`${row.buy.name} -> ${row.sell.name}`,`Input: ${formatAmount(row.amountIn,n.quoteDecimals)} ${n.quote}`,
      `Return quote: ${formatAmount(row.quoteOut,n.quoteDecimals)} ${n.quote}`,
      `Loan fee budget: ${formatAmount(row.premium,n.quoteDecimals)} ${n.quote}`,
      `Gas budget valuation: ${formatAmount(row.gasInQuote,n.quoteDecimals)} ${n.quote}`,
      `Estimated net: ${formatAmount(row.estimatedNet,n.quoteDecimals)} ${n.quote} ${row.profitable?'(passes quote filter)':'(below profit floor)'}`,
      `Buy: https://dexscreener.com/${report.key}/${row.buy.pairAddress}`,
      `Sell: https://dexscreener.com/${report.key}/${row.sell.pairAddress}`);
  }
  if(!rows.length)lines.push('No executable route met the configured pool filters.');
  if(notes.length)lines.push('',...notes.slice(0,4));
  lines.push('','Quotes include DEX fees and price impact. A full contract simulation is required before execution.');
  return lines.join('\n').slice(0,3900);
}
export class BotApp {
  constructor({cfg,store,engine,telegram,env=process.env,admin,username='',pairCode=randomBytes(6).toString('hex')}){
    this.cfg=cfg;this.store=store;this.engine=engine;this.tg=telegram;this.username=username;
    this.env=env;this.admin=admin??new AdminService({cfg,store,engine});this.changing=false;this.prompts=new Map();this.configActions=new Map();
    this.pairCode=pairCode;this.tickBusy=false;this.scanJobs=new Map();this.scanCache=new Map();this.lastErrorAt=0;this.publicReplies=new Map();
  }
  authorized(id){return String(id)===this.store.state.ownerId;}
  keyboard(){return {inline_keyboard:[
    [{text:'Scan both',callback_data:'scan both'},{text:'Base',callback_data:'scan base'},{text:'BSC',callback_data:'scan bsc'}],
    [{text:'Alerts on',callback_data:'watch on'},{text:'Alerts off',callback_data:'watch off'}],
    [{text:this.cfg.mode==='live'?'Start trading':'Run paper mode',callback_data:'trade on'},{text:'Pause all',callback_data:'pause'}],
    [{text:'Setup',callback_data:'setup'},{text:'Status',callback_data:'status'}],
    [{text:'Settings',callback_data:'settings'},{text:'Wallet',callback_data:'wallet'}]
  ]};}
  send(text,buttons=true){return this.tg.send(this.store.state.ownerId,text,buttons?this.keyboard():undefined);}
  canTrade(){const s=this.store.state;return s.trading&&s.activationMode===this.cfg.mode;}
  async handle(update){
    const callback=update.callback_query;
    const msg=callback?.message??update.message;
    const sender=callback?.from??msg?.from;
    if(!msg||!sender||msg.chat?.type!=='private'||String(msg.chat.id)!==String(sender.id)){
      if(callback)await this.tg.call('answerCallbackQuery',{callback_query_id:callback.id,text:'Use the bot in its private chat.'});
      return;
    }
    if(sender.is_bot)return;
    let cmd=callback?parseCommand('/'+callback.data):parseCommand(msg.text,this.username);
    if(!this.authorized(sender.id)){
      if(callback){await this.tg.call('answerCallbackQuery',{callback_query_id:callback.id,text:'This bot is private.'});return;}
      if(!this.store.state.ownerId&&cmd?.name==='start'&&cmd.args&&Buffer.byteLength(cmd.args)===Buffer.byteLength(this.pairCode)&&timingSafeEqual(Buffer.from(cmd.args),Buffer.from(this.pairCode))){
        this.store.state.ownerId=String(sender.id);this.pairCode='';await this.store.save();
        await this.tg.call('deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}).catch(()=>{});
        await this.send('Paired successfully. Use /setup to configure everything from this chat.\n'+this.help());return;
      }
      if(!['id','start','help'].includes(cmd?.name))return;
      if(Date.now()-(this.publicReplies.get(String(sender.id))??0)<30000)return;
      if(this.publicReplies.size>=1000)this.publicReplies.clear();
      this.publicReplies.set(String(sender.id),Date.now());
      const text=cmd.name==='id'?`Your Telegram user ID: ${sender.id}`:'This bot is private. The owner can pair it with /start followed by the one-time code shown in the host terminal.';
      await this.tg.send(msg.chat.id,text);return;
    }
    if(callback)await this.tg.call('answerCallbackQuery',{callback_query_id:callback.id});
    if(cmd&&((['seed','import','privatekey'].includes(cmd.name)&&cmd.args)||[12,15,18,21,24].includes(cmd.args.split(/\s+/).length)||/^0x[a-fA-F0-9]{64}$/.test(cmd.args))){
      await this.tg.call('deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}).catch(()=>{});
      await this.walletForm('Enter the seed using the wallet form inside this bot. A plaintext chat message exposes it to Telegram; deletion does not undo that exposure.');return;
    }
    // Chat text is never persisted or logged. Secrets use the encrypted Mini App channel.
    if(!cmd){
      const words=(msg.text??'').trim().split(/\s+/);
      if([12,15,18,21,24].includes(words.length)||/^0x[a-fA-F0-9]{64}$/.test((msg.text??'').trim())){
        await this.tg.call('deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}).catch(()=>{});
        await this.walletForm('Use this wallet form to import a seed. It opens inside Telegram and keeps the phrase out of chat messages.');return;
      }
      const prompt=this.prompts.get(String(sender.id));this.prompts.delete(String(sender.id));
      if(prompt&&prompt.expires>Date.now()){
        if(prompt.key.endsWith('_rpc'))await this.tg.call('deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}).catch(()=>{});
        try{await this.changeSetting(prompt.key,(msg.text??'').trim());await this.send('Setting saved. Automatic trading is paused.\n'+this.settings());}catch(e){await this.send(safeError(e));}return;
      }
      await this.send('Use the controls or /help. Tap Wallet to import or create a wallet inside the bot.');return;
    }
    if(cmd.name==='set'&&/^\S*_rpc\b/.test(cmd.args))await this.tg.call('deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}).catch(()=>{});
    try{await this.command(cmd);}catch(e){await this.send(safeError(e));}
  }
  help(){return [
    `Base + BSC DEX arbitrage bot | ${this.cfg.mode.toUpperCase()} mode`,
    '/scan [base|bsc|both] - on-chain round-trip quotes',
    '/watch on|off - opportunity alerts',
    '/trade on|off - automatic simulation or live execution',
    '/pause - stop all automatic activity',
    '/setup - full setup guide and buttons',
    '/wallet, /import, /unlock, /lock, /deposit, /backup',
    '/deploy base|bsc - preview and confirm deployment',
    '/approve base|bsc [amount], /revoke base|bsc',
    '/mode paper|live, /funding flashloan|funded',
    '/settings, /configure, /set name value',
    '/check [base|bsc|both], /status, /pending, /reconcile, /history',
    '/withdraw chain token amount recipient - review before sending',
    '/size 100 - trade size in chain quote-token units',
    '/chains base|bsc|both - choose chains',
    '',
    'Wallet import/create/unlock opens a form inside Telegram. Never paste a seed or password into chat. The seed stays on your device; encrypted derived key data goes to your bot server. Uniswap V2/PancakeSwap V2 trades stay on one chain.',
    'Reverted transactions still use gas. Quote estimates do not guarantee profit.'
  ].join('\n');}
  settings(){return [
    `Mode: ${this.cfg.mode} | Funding: ${this.cfg.funding}`,
    `Chains: ${this.store.state.chains.join(', ')}`,
    `Trade size: ${this.engine.amount()} USDC on Base / USDT on BSC`,
    `Maximum size: ${this.cfg.maxAmount}`,
    `Minimum net quote-token profit: ${this.cfg.minProfit}`,
    `Slippage: ${this.cfg.slippageBps/100}% | Scan interval: ${this.cfg.interval}s`,
    `Minimum pool quote reserve: ${this.cfg.minReserve} | Reserve-share cap: ${this.cfg.maxReserveShareBps/100}%`,
    `Daily transaction cap: ${this.cfg.maxDailyTrades} per chain | Cooldown: ${this.cfg.cooldown}s`,
    ...Object.entries(this.cfg.perChain).map(([k,c])=>`${k}: gas cap ${formatAmount(c.gasCap,18)} ${NETWORKS[k].native}; daily ${formatAmount(c.dailyGas,18)}; max price ${formatAmount(c.gasPriceCap,9)} gwei`),
    `Base extra-fee allowance: ${formatAmount(this.cfg.baseExtraFeeCap,18)} ETH | Max block age ${this.cfg.maxBlockAge}s / quote age ${this.cfg.maxQuoteAge}s`,
    '/mode changes paper/live; /funding changes capital source; /configure lists editable limits. All changes pause trading.'
  ].join('\n');}
  walletKeyboard(){return {inline_keyboard:[
    ...(this.cfg.appUrl?[[{text:'Import / create / unlock wallet',web_app:{url:this.cfg.appUrl}}]]:[]),
    [{text:'Deposit address',callback_data:'deposit'},{text:'Lock wallet',callback_data:'lock'}],
    [{text:'Encrypted backup',callback_data:'backup'}],
    [{text:'Setup',callback_data:'setup'},{text:'Back to controls',callback_data:'start'}]
  ]};}
  async walletForm(text='Import a seed phrase, create a new wallet, unlock it, or download its encrypted backup using the form below.'){
    await this.tg.send(this.store.state.ownerId,text+(this.cfg.appUrl?'':'\nThe hosting setup needs APP_PUBLIC_URL pointing to this bot’s HTTPS server before the wallet form can open.'),this.walletKeyboard());
  }
  async walletStatus(){const address=await walletAddress(this.cfg);return {hasWallet:Boolean(address),address,unlocked:this.engine.isUnlocked?.()??false};}
  async mutate(fn,{allowPending=false}={}){
    if(this.changing||this.tickBusy||this.scanJobs.size||this.admin.reconciling||this.engine.reconciling||this.engine.busy)throw new Error('A scan or transaction is busy. Use /pause, wait for it to finish, then try again.');
    if(!allowPending&&this.engine.hasPending())throw new Error('Resolve /pending before changing the setup.');
    this.changing=true;
    try{
      this.store.state.trading=false;await this.store.save();this.admin.invalidate();this.configActions.clear();
      return await fn();
    }finally{this.changing=false;}
  }
  async changeWallet(action,data){
    const address=await this.mutate(async()=>{
      let wallet;
      if(action==='import'){
        if(await walletAddress(this.cfg))throw new Error('A wallet already exists. Unlock it using this form; existing keystores are never overwritten.');
        if(data.password.length<12)throw new Error('Choose an encryption password with at least 12 characters.');
        try{wallet=new Wallet(data.privateKey);}catch{throw new Error('Invalid wallet key.');}
        await saveWallet(wallet,data.password,this.cfg.walletFile);
      }else if(action==='unlock')wallet=await decryptWallet(this.cfg,data.password);
      else throw new Error('Unsupported wallet action.');
      await this.engine.refresh(wallet);this.scanCache.clear();return wallet.address;
    },{allowPending:action==='unlock'});
    await this.send(`Wallet ${action==='import'?'saved and ':''}unlocked: ${address}\nUse /setup for funding, deployment and trading. Automatic trading is paused.`).catch(()=>{});
    return address;
  }
  async changeSetting(key,value){
    const variable=Object.hasOwn(SETTINGS,key)?SETTINGS[key]:['mode','funding'].includes(key)?key==='mode'?'TRADING_MODE':'FUNDING_MODE':null;
    if(!variable)throw new Error('Unknown setting. Use /configure.');
    return this.mutate(async()=>{
      const next=candidateConfig(this.env,this.store.state,variable,value);
      const oldConfig=this.store.state.config,oldAmount=this.store.state.amount;
      this.store.state.config={...oldConfig,[variable]:value};if(key==='size')this.store.state.amount=value;
      try{await this.store.save();}catch(e){this.store.state.config=oldConfig;this.store.state.amount=oldAmount;throw e;}
      Object.assign(this.cfg,next);await this.engine.refresh?.();this.scanCache.clear();
    });
  }
  async setup(){
    const address=this.engine.wallet?.address;
    await this.tg.send(this.store.state.ownerId,[
      'Telegram setup',`1. Wallet: ${address??'import a seed or create a wallet using Wallet below'}`,
      `2. Signing: ${this.engine.isUnlocked?.()?'unlocked':'locked — use the wallet form'}`,
      '3. Deposit native gas: ETH on Base / BNB on BSC. Flash loans do not cover gas.',
      ...this.store.state.chains.map(key=>`4. ${key} executor: ${this.cfg.perChain[key].executor||'use Deploy '+key+' below'}`),
      `5. Capital: ${this.cfg.funding}${this.cfg.funding==='funded'?' — deposit quote tokens and use Approve':' — loan availability is checked on-chain'}`,
      `6. Check → paper simulation → live mode → Start trading. Current mode: ${this.cfg.mode}.`,
      'Each deployment/approval/withdrawal needs its own preview confirmation. Start trading enables automatic trades within your saved limits.'
    ].join('\n'),{inline_keyboard:[
      [{text:'Wallet setup',callback_data:'wallet'},{text:'Deposit',callback_data:'deposit'}],
      [{text:'Base',callback_data:'chains base'},{text:'BSC',callback_data:'chains bsc'},{text:'Both',callback_data:'chains both'}],
      [{text:'Deploy Base',callback_data:'deploy base'},{text:'Deploy BSC',callback_data:'deploy bsc'}],
      [{text:'Approve Base',callback_data:'approve base'},{text:'Approve BSC',callback_data:'approve bsc'}],
      [{text:'Paper mode',callback_data:'mode paper'},{text:'Live mode',callback_data:'mode live'}],
      [{text:'Check setup',callback_data:'check'},{text:'Start trading',callback_data:'trade on'}],
      [{text:'Settings',callback_data:'settings'},{text:'Pause',callback_data:'pause'}]
    ]});
  }
  async preview(kind,key,params){
    if(this.changing)throw new Error('Setup is busy. Try again shortly.');
    const plan=await this.admin.request(kind,key,params);
    if(plan.done){await this.send(plan.text);return;}
    await this.tg.send(this.store.state.ownerId,plan.text,{inline_keyboard:[[{text:'Confirm '+kind,callback_data:'confirm '+plan.id},{text:'Cancel',callback_data:'cancel '+plan.id}]]});
  }
  async scan(key){
    const cached=this.scanCache.get(key);
    if(cached&&Date.now()-cached.observedAt<15000)return cached;
    if(this.scanJobs.has(key))return this.scanJobs.get(key);
    const job=this.engine.scanChain(key).then(r=>{this.scanCache.set(key,r);return r;}).finally(()=>this.scanJobs.delete(key));
    this.scanJobs.set(key,job);return job;
  }
  async command({name,args}){
    const s=this.store.state;
    if(name==='help'||name==='start'){await this.send(this.help());return;}
    if(name==='id'){await this.send(`Your Telegram user ID: ${s.ownerId}`);return;}
    if(name==='setup'){await this.setup();return;}
    if(name==='settings'){
      await this.tg.send(s.ownerId,this.settings(),{inline_keyboard:[
        [{text:'Trade size',callback_data:'prompt size'},{text:'Profit floor',callback_data:'prompt profit'}],
        [{text:'Slippage (bps)',callback_data:'prompt slippage_bps'},{text:'Daily trade limit',callback_data:'prompt max_daily_trades'}],
        [{text:'Flash loans',callback_data:'funding flashloan'},{text:'Wallet funds',callback_data:'funding funded'}],
        [{text:'Paper',callback_data:'mode paper'},{text:'Live',callback_data:'mode live'}],
        [{text:'All settings',callback_data:'configure'},{text:'Controls',callback_data:'start'}]
      ]});return;
    }
    if(name==='configure'){await this.send('Use /set name value. Saved changes take effect immediately and pause trading.\nExamples: /set profit 2, /set slippage_bps 30, /set base_rpc https://your-rpc-host\n\n'+Object.keys(SETTINGS).join(', '));return;}
    if(name==='prompt'){
      if(!Object.hasOwn(SETTINGS,args))throw new Error('Unknown setting.');
      this.prompts.set(s.ownerId,{key:args,expires:Date.now()+300000});await this.send(`Send the new value for ${args}, or /cancel.`,false);return;
    }
    if(name==='set'){
      const m=/^(\S+)\s+(.+)$/.exec(args);if(!m)throw new Error('Use /set name value.');
      if(!Object.hasOwn(SETTINGS,m[1]))throw new Error('Unknown setting. Use /configure; mode and funding have their own commands.');
      await this.changeSetting(m[1],m[2]);await this.send('Setting saved. Automatic trading is paused.\n'+this.settings());return;
    }
    if(name==='funding'){await this.changeSetting('funding',args);await this.send(`Funding set to ${this.cfg.funding}. Automatic trading is paused.${this.cfg.funding==='funded'?' Deposit quote tokens and use /approve before starting.':''}`);return;}
    if(name==='mode'){
      if(!['paper','live'].includes(args))throw new Error('Use /mode paper or /mode live.');
      if(args==='paper'){await this.changeSetting('mode',args);await this.send('Paper mode saved. Trades only simulate; use /trade on to start.');return;}
      const id=randomBytes(8).toString('hex');this.configActions.clear();this.configActions.set(id,{expires:Date.now()+120000});
      await this.tg.send(s.ownerId,'Switch to LIVE mode? Live mode permits spending wallet funds and gas after you separately press Start trading. Reverted trades also cost gas. The contract is unaudited.\nConfirm within 2 minutes.',{inline_keyboard:[[{text:'Confirm live mode',callback_data:'liveconfirm '+id},{text:'Cancel',callback_data:'cancel '+id}]]});return;
    }
    if(name==='liveconfirm'){
      const action=this.configActions.get(args);this.configActions.delete(args);
      if(!action||action.expires<Date.now())throw new Error('Live-mode preview expired or was already used.');
      await this.changeSetting('mode','live');await this.send('LIVE mode saved. Automatic trading is paused. Unlock the wallet, review /settings and /check, then use /trade on.');return;
    }
    if(name==='cancel'){this.prompts.clear();this.configActions.delete(args);this.admin.cancel(args);await this.send('Cancelled.');return;}
    if(['deploy','approve','revoke','withdraw'].includes(name)){
      const parts=args.split(/\s+/),key=parts[0];
      if(name==='deploy'){if(parts.length!==1)throw new Error('Use /deploy base or /deploy bsc.');await this.preview('deploy',key,{});return;}
      if(name==='approve'||name==='revoke'){
        if(parts.length>2||name==='revoke'&&parts.length!==1)throw new Error('Use /approve chain amount or /revoke chain.');
        await this.preview('approve',key,{amount:name==='revoke'?'0':parts[1]??this.cfg.maxAmount});return;
      }
      if(parts.length!==4)throw new Error('Use /withdraw base ETH 0.01 0xRecipient or /withdraw bsc USDT 100 0xRecipient.');
      await this.preview('withdraw',key,{token:parts[1],amount:parts[2],to:parts[3]});return;
    }
    if(name==='confirm'){
      const result=await this.admin.confirm(args);await this.send(`${result.kind} submitted on ${result.key}. The bot waits for 2 confirmations before any further transaction.\n${NETWORKS[result.key].explorer}/tx/${result.hash}`);return;
    }
    if(name==='executor'){
      const [key,address,...extra]=args.split(/\s+/);if(extra.length||!address)throw new Error('Use /executor chain 0xAddress to attach an existing included executor.');
      if(this.changing)throw new Error('Setup is busy.');
      await this.admin.attach(key,address);this.scanCache.clear();await this.send(`${key} executor verified and saved. Automatic trading is paused.`);return;
    }
    if(name==='check'){
      for(const key of args?parseChains(args):s.chains){
        try{
          const c=await this.engine.chain(key),report=await this.scan(key),row=report.rows.find(r=>r.profitable);
          let simulation='No qualifying opportunity to simulate.';
          if(row&&c.executor&&c.signer){await this.engine.simulate(report,row);simulation='Full contract simulation passed for the current qualifying quote.';}
          await this.send(`${key}: chain, tokens and DEX routers verified.\nExecutor: ${c.executor?'bytecode, owner and immutable configuration verified':'deploy or attach it'}\n${simulation}\nSigning: ${this.engine.isUnlocked?.()?'unlocked':'locked'} | mode: ${this.cfg.mode}`);
        }catch(e){await this.send(`${key}: ${safeError(e)}`);}
      }return;
    }
    if(name==='scan'){
      const keys=args?parseChains(args):s.chains;
      for(const key of keys){try{await this.send(formatReport(await this.scan(key)));}catch(e){await this.send(`${key}: ${safeError(e)}`);}}return;
    }
    if(name==='watch'){
      if(!['on','off',''].includes(args))throw new Error('Use /watch on or /watch off.');
      s.watching=args!=='off';await this.store.save();await this.send(`Alerts ${s.watching?'enabled':'disabled'}. Automatic execution: ${this.canTrade()?'on':'off'}.`);return;
    }
    if(name==='trade'){
      if(!['on','off'].includes(args))throw new Error('Use /trade on or /trade off.');
      if(args==='off'){s.trading=false;await this.store.save();await this.send('Automatic execution disabled.');return;}
      if(this.changing||this.engine.busy)throw new Error('Setup or a transaction is busy. Try again shortly.');
      if(this.engine.hasPending())throw new Error('Resolve /pending before enabling trading.');
      if(this.cfg.mode==='live'&&!this.engine.isUnlocked?.())throw new Error('Unlock the wallet using /unlock before starting LIVE trading.');
      for(const key of s.chains){const c=await this.engine.chain(key);if(!c.executor||!c.signer)throw new Error(`${key}: import a wallet and configure a deployed executor first.`);}
      s.trading=true;s.activationMode=this.cfg.mode;await this.store.save();
      await this.send(this.cfg.mode==='live'?'Automatic LIVE execution enabled for opportunities that pass quotes, simulation and configured limits.':'Automatic PAPER simulation enabled. No transactions are broadcast in paper mode.');return;
    }
    if(name==='pause'){s.trading=false;s.watching=false;await this.store.save();await this.send('All automatic activity paused.');return;}
    if(name==='size'){
      const n=parseAmount(args,6);
      if(n<=0n||n>parseAmount(this.cfg.maxAmount,6))throw new Error(`Use a trade size above zero and at most ${this.cfg.maxAmount}, with at most 6 decimals.`);
      if(this.engine.busy||this.engine.hasPending())throw new Error('Pause and resolve the transaction before changing trade size.');
      await this.changeSetting('size',args);await this.send(`Trade size set to ${args} quote-token units. Automatic trading is paused.`);return;
    }
    if(name==='chains'){
      if(this.engine.busy||this.engine.hasPending())throw new Error('Resolve the transaction before changing chains.');
      await this.mutate(async()=>{s.chains=parseChains(args);await this.store.save();});await this.send(`Selected ${s.chains.join(', ')}. Use /trade on to start execution for this selection.`);return;
    }
    if(name==='wallet'){
      const lines=[this.engine.wallet?`Wallet: ${this.engine.wallet.address}`:'No wallet imported. Use the wallet form below.',`Signing: ${this.engine.isUnlocked?.()?'unlocked':'locked'}`];
      if(this.engine.wallet)for(const key of s.chains){try{lines.push(await this.engine.balances(key));}catch(e){lines.push(`${key}: ${safeError(e)}`);}}
      await this.walletForm(lines.join('\n'));return;
    }
    if(['seed','import','privatekey','unlock'].includes(name)){await this.walletForm();return;}
    if(name==='backup'){
      const content=await encryptedWallet(this.cfg);
      await this.tg.document(s.ownerId,'trading-wallet-encrypted.json',content,'Encrypted wallet backup. Your encryption password is required. The seed and plaintext key are not included.');return;
    }
    if(name==='lock'){
      await this.mutate(async()=>{const address=this.engine.wallet?.address??await walletAddress(this.cfg);await this.engine.refresh(address?new VoidSigner(address):null);this.scanCache.clear();},{allowPending:true});
      await this.send('Wallet locked and automatic trading paused. Quotes, balances and pending-transaction tracking remain available.');return;
    }
    if(name==='deposit'){
      if(!this.engine.wallet)throw new Error('Import or create a wallet using /wallet first.');
      await this.send(`Deposit address: ${this.engine.wallet.address}\nBase: native ETH for gas, USDC for funded mode.\nBSC: native BNB for gas, USDT for funded mode.\nDeposit to the wallet address on the correct network. Flash-loan mode only needs native gas. Deposits are made from your existing wallet or exchange.`);return;
    }
    if(name==='history'){
      const rows=(s.history??[]).slice(-10).reverse();await this.send(rows.length?rows.map(r=>`${r.key} ${r.kind??'arbitrage'}: ${r.status===1?'confirmed':'reverted'}\n${NETWORKS[r.key].explorer}/tx/${r.hash}`).join('\n\n'):'No confirmed transactions recorded.');return;
    }
    if(name==='pending'){await this.send(this.pending());return;}
    if(name==='reconcile'){const notices=[...await this.admin.reconcile(),...await this.engine.reconcile()];await this.confirmations(notices);await this.send(notices.length?'Transaction state updated.':this.pending());return;}
    if(name==='status'){
      const lines=[`Mode: ${this.cfg.mode} (${this.cfg.funding})`,`Automatic execution: ${this.canTrade()?'on':'off'} | Alerts: ${s.watching?'on':'off'}`];
      for(const key of s.chains){const r=todayLedger(s,key);lines.push(`${key}: ${r.count}/${this.cfg.maxDailyTrades} attempts today (UTC); reserved gas ${formatAmount(BigInt(r.gasReserved),18)} ${NETWORKS[key].native}`);}
      lines.push(this.pending());await this.send(lines.join('\n'));return;
    }
    await this.send('Unknown command. Use /help.');
  }
  pending(){
    const lines=[];
    for(const [key,l] of Object.entries(this.store.state.ledger))if(l.pending)lines.push(`${key}: unresolved transaction\n${NETWORKS[key].explorer}/tx/${l.pending.hash}`);
    for(const [key,op] of Object.entries(this.store.state.operations??{}))if(op.pending)lines.push(`${key}: unresolved ${op.kind}\n${NETWORKS[key].explorer}/tx/${op.pending.hash}`);
    return lines.length?lines.join('\n')+'\nExecution waits until this transaction is reconciled.':'No unresolved transactions.';
  }
  async confirmations(notices){
    for(const notice of notices){const n=NETWORKS[notice.key];
      if(notice.kind){
        const text=[`${notice.kind} on ${notice.key}: ${notice.status===1?'confirmed (2+ blocks)':'REVERTED'}`,
          ...(notice.kind==='deploy'&&notice.status===1?[`Executor verified and automatically saved: ${notice.address}`]:[]),
          ...(notice.nextApproval?[`The zero reset confirmed. Finish the bounded ${notice.nextApproval} ${n.quote} approval below.`]:[]),
          `${n.explorer}/tx/${notice.hash}`].join('\n');
        await this.tg.send(this.store.state.ownerId,text,notice.nextApproval?{inline_keyboard:[[{text:'Finish approval',callback_data:`approve ${notice.key} ${notice.nextApproval}`}]]}:this.keyboard());continue;
      }
      await this.send([
      `${notice.key}: ${notice.status===1?'confirmed (2+ blocks)':'REVERTED; automatic execution paused'}`,
      ...(notice.profit===null?[]:[`Token profit after loan fee, before native gas: ${formatAmount(notice.profit,n.quoteDecimals)} ${n.quote}`]),
      `${n.explorer}/tx/${notice.hash}`
    ].join('\n'));}
  }
  async tick(){
    if(this.tickBusy||this.changing)return;this.tickBusy=true;
    try{
      await this.confirmations([...await this.admin.reconcile(),...await this.engine.reconcile()]);
      const s=this.store.state;if(!s.ownerId||(!s.watching&&!this.canTrade()))return;
      for(const key of [...s.chains]){
        if(!s.watching&&!this.canTrade())break;
        try{
          const report=await this.scan(key),row=report.rows.find(r=>r.profitable);
          if(!row)continue;
          const alertKey=`${key}:${row.buy.address}:${row.sell.address}`;
          const due=Date.now()-(s.lastAlerts[alertKey]??0)>=this.cfg.alertCooldown*1000;
          if(s.watching&&due){await this.send('Opportunity quote\n'+formatReport(report));s.lastAlerts[alertKey]=Date.now();await this.store.save();}
          if(this.canTrade()&&!this.engine.hasPending()){
            const ledger=todayLedger(s,key);
            if(Date.now()-ledger.lastAttemptAt<this.cfg.cooldown*1000)continue;
            const result=await this.engine.execute(key,row,()=>this.canTrade()&&s.chains.includes(key));
            if(result.kind==='paper'){ledger.lastAttemptAt=Date.now();await this.store.save();await this.send(`PAPER simulation passed on ${key}. Estimated net after gas budget: ${formatAmount(result.net,report.n.quoteDecimals)} ${report.n.quote}.`);}
            if(result.kind==='submitted')await this.send(`Submitted on ${key}\n${report.n.explorer}/tx/${result.hash}`);
          }
        }catch(e){
          if(Date.now()-this.lastErrorAt>=this.cfg.alertCooldown*1000){this.lastErrorAt=Date.now();await this.send(`${key}: ${safeError(e)}`);}
        }
      }
    }finally{this.tickBusy=false;}
  }
}
