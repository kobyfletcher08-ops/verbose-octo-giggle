import {resolve} from 'node:path';
import {parseAmount} from './math.mjs';
const number=(env,key,def,min,max)=>{
  const n=Number(env[key]??def);
  if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  return n;
};
export function loadConfig(env=process.env) {
  const mode=env.TRADING_MODE??'paper';
  const funding=env.FUNDING_MODE??'flashloan';
  if(!['paper','live'].includes(mode))throw new Error('TRADING_MODE must be paper or live.');
  if(!['flashloan','funded'].includes(funding))throw new Error('FUNDING_MODE must be flashloan or funded.');
  const owner=env.OWNER_TELEGRAM_ID??'';
  if(owner&&!/^[1-9]\d{0,15}$/.test(owner))throw new Error('OWNER_TELEGRAM_ID must be a positive Telegram user ID.');
  const amount=env.TRADE_SIZE??'100'; const maxAmount=env.MAX_TRADE_SIZE??'1000';
  const minProfit=env.MIN_NET_PROFIT??'1';
  if(parseAmount(amount,6)<=0n||parseAmount(amount,6)>parseAmount(maxAmount,6))throw new Error('TRADE_SIZE exceeds MAX_TRADE_SIZE or is zero.');
  if(parseAmount(minProfit,6)<=0n)throw new Error('MIN_NET_PROFIT must be positive.');
  const perChain={};
  for(const [key,nativeCap,dailyCap,gwei] of [['base','0.0002','0.001','3'],['bsc','0.002','0.01','10']]) {
    const prefix=key.toUpperCase(); const rpc=env[`${prefix}_RPC_URL`]??(key==='base'?'https://mainnet.base.org':'https://bsc-dataseed.bnbchain.org');
    if(rpc){ const u=new URL(rpc);if(!['http:','https:'].includes(u.protocol))throw new Error(`${prefix}_RPC_URL must use HTTP or HTTPS.`); }
    const executor=env[`${prefix}_EXECUTOR_ADDRESS`]??'';
    if(executor&&!/^0x[0-9a-fA-F]{40}$/.test(executor))throw new Error(`${prefix}_EXECUTOR_ADDRESS is invalid.`);
    const gasCap=parseAmount(env[`${prefix}_MAX_GAS_FEE_NATIVE`]??nativeCap,18);
    const dailyGas=parseAmount(env[`${prefix}_DAILY_GAS_BUDGET_NATIVE`]??dailyCap,18);
    const gasPriceCap=parseAmount(env[`${prefix}_MAX_GAS_PRICE_GWEI`]??gwei,9);
    if(gasCap<=0n||dailyGas<gasCap||gasPriceCap<=0n)throw new Error(`${prefix} gas budgets are invalid.`);
    perChain[key]={rpc,executor,gasCap,dailyGas,gasPriceCap};
  }
  // Render supplies an HTTPS origin automatically; an explicit APP_PUBLIC_URL takes precedence.
  const publicUrl=env.APP_PUBLIC_URL||env.RENDER_EXTERNAL_URL||'';
  if(publicUrl){const u=new URL(publicUrl);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('APP_PUBLIC_URL must be an HTTPS origin, such as https://bot.example.com.');}
  if(parseAmount(env.MIN_POOL_QUOTE_RESERVE??'25000',6)<=0n)throw new Error('MIN_POOL_QUOTE_RESERVE must be positive.');
  const baseExtraFeeCap=parseAmount(env.BASE_EXTRA_FEE_CAP_NATIVE??'0.00005',18);
  if(baseExtraFeeCap<0n||baseExtraFeeCap>=perChain.base.gasCap)throw new Error('Base extra-fee allowance must be below the Base gas cap.');
  return {
    token:env.BOT_TOKEN??'',ownerId:owner,mode,funding,amount,maxAmount,minProfit,perChain,
    interval:number(env,'SCAN_INTERVAL_SECONDS',30,15,3600),
    slippageBps:number(env,'SLIPPAGE_BPS',30,1,200),
    maxDailyTrades:number(env,'MAX_DAILY_TRADES',5,1,100),
    cooldown:number(env,'TRADE_COOLDOWN_SECONDS',120,30,86400),
    minReserve:env.MIN_POOL_QUOTE_RESERVE??'25000',
    maxReserveShareBps:number(env,'MAX_RESERVE_SHARE_BPS',100,1,500),
    maxBlockAge:number(env,'MAX_BLOCK_AGE_SECONDS',30,5,300),
    maxQuoteAge:number(env,'MAX_QUOTE_AGE_SECONDS',10,2,30),
    alertCooldown:number(env,'ALERT_COOLDOWN_SECONDS',600,30,86400),
    baseExtraFeeCap,
    appUrl:publicUrl?new URL(publicUrl).origin:'',
    appHost:env.APP_BIND_HOST??'127.0.0.1',
    appPort:number(env,'APP_PORT',3000,1,65535),
    walletFile:resolve(env.WALLET_FILE??'data/wallet.json'),
    passwordFile:env.WALLET_PASSWORD_FILE?resolve(env.WALLET_PASSWORD_FILE):'',
    stateFile:resolve(env.STATE_FILE??'data/bot-state.json')
  };
}
