import {loadConfig} from './config.mjs';
import {parseAmount} from './math.mjs';
import {StateStore} from './state.mjs';

export const SETTINGS={
  size:'TRADE_SIZE',max_size:'MAX_TRADE_SIZE',profit:'MIN_NET_PROFIT',
  slippage_bps:'SLIPPAGE_BPS',interval:'SCAN_INTERVAL_SECONDS',cooldown:'TRADE_COOLDOWN_SECONDS',
  max_daily_trades:'MAX_DAILY_TRADES',min_reserve:'MIN_POOL_QUOTE_RESERVE',reserve_share_bps:'MAX_RESERVE_SHARE_BPS',
  alert_cooldown:'ALERT_COOLDOWN_SECONDS',max_block_age:'MAX_BLOCK_AGE_SECONDS',max_quote_age:'MAX_QUOTE_AGE_SECONDS',
  base_rpc:'BASE_RPC_URL',bsc_rpc:'BSC_RPC_URL',
  base_gas_cap:'BASE_MAX_GAS_FEE_NATIVE',bsc_gas_cap:'BSC_MAX_GAS_FEE_NATIVE',
  base_daily_gas:'BASE_DAILY_GAS_BUDGET_NATIVE',bsc_daily_gas:'BSC_DAILY_GAS_BUDGET_NATIVE',
  base_gas_price:'BASE_MAX_GAS_PRICE_GWEI',bsc_gas_price:'BSC_MAX_GAS_PRICE_GWEI',
  base_extra_fees:'BASE_EXTRA_FEE_CAP_NATIVE'
};
export function runtimeEnv(env,state){
  const extra={...state.config};
  // The JSON state can change only documented trading settings, never host paths, owner or bot credentials.
  const allowed=new Set([...Object.values(SETTINGS),'TRADING_MODE','FUNDING_MODE']);
  for(const key of Object.keys(extra))if(!allowed.has(key))throw new Error('Unexpected saved bot setting.');
  const result={...env,...extra};
  for(const [key,address] of Object.entries(state.executors??{})){
    if(!['base','bsc'].includes(key))throw new Error('Unexpected executor chain.');
    result[key.toUpperCase()+'_EXECUTOR_ADDRESS']=address;
  }
  return result;
}
export function runtimeConfig(env,state){
  const cfg=loadConfig(runtimeEnv(env,state));
  if(state.amount!==null&&state.amount!==undefined){
    if(parseAmount(state.amount,6)<=0n||parseAmount(state.amount,6)>parseAmount(cfg.maxAmount,6))throw new Error('Saved trade size exceeds the configured maximum.');
  }
  return cfg;
}
export function candidateConfig(env,state,variable,value){
  return runtimeConfig(env,{...state,config:{...state.config,[variable]:value},...(variable==='TRADE_SIZE'?{amount:null}:{})});
}
export async function readRuntimeConfig(env=process.env){
  const boot=loadConfig(env),store=new StateStore(boot.stateFile);await store.load();
  return runtimeConfig(env,store.state);
}
