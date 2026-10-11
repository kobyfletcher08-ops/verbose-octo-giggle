import {JsonRpcProvider,FetchRequest,Contract,keccak256} from 'ethers';
import {readFile} from 'node:fs/promises';
import {NETWORKS} from './networks.mjs';
export const TOKEN_ABI=['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)'];
export const ROUTER_ABI=['function factory() view returns(address)','function WETH() view returns(address)','function getAmountsOut(uint256,address[]) view returns(uint256[])'];
export const PAIR_ABI=['function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)'];
export const POOL_ABI=['function FLASHLOAN_PREMIUM_TOTAL() view returns(uint128)','function getConfiguration(address) view returns(uint256)'];
export const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
export async function artifact(){return JSON.parse(await readFile(new URL('../artifacts/AtomicDexArbitrage.json',import.meta.url),'utf8'));}
export function canonicalRuntime(code,refs){
  const bytes=Buffer.from(code.slice(2),'hex');
  for(const items of Object.values(refs))for(const {start,length} of items)bytes.fill(0,start,start+length);
  return keccak256(bytes);
}
export async function verifiedExecutor(c,address,wallet){
  const data=await artifact(),n=c.n;
  const code=await c.provider.getCode(address);
  if(code==='0x'||canonicalRuntime(code,data.immutableReferences)!==canonicalRuntime(data.runtime,data.immutableReferences))throw new Error('Executor bytecode does not match the included contract.');
  const executor=new Contract(address,data.abi,c.signer??c.provider);
  const [owner,q,a,p,r1,r2]=await Promise.all([executor.owner(),executor.quoteToken(),executor.assetToken(),executor.flashPool(),executor.routerA(),executor.routerB()]);
  if(!same(q,n.quoteAddress)||!same(a,n.assetAddress)||!same(p,n.flashPool)||!same(r1,n.routers[0].address)||!same(r2,n.routers[1].address))throw new Error('Executor is configured for different tokens, pool or routers.');
  if(wallet&&!same(owner,wallet.address))throw new Error('Imported wallet is not the executor owner.');
  return executor;
}
export async function connectChain(cfg,key,wallet=null){
  const n=NETWORKS[key],settings=cfg.perChain[key];
  if(!settings.rpc)throw new Error(`${key.toUpperCase()}_RPC_URL is not configured.`);
  const request=new FetchRequest(settings.rpc);request.timeout=15000;
  const provider=new JsonRpcProvider(request,undefined,{batchMaxCount:1,cacheTimeout:-1});
  try {
    if(Number((await provider.getNetwork()).chainId)!==n.chainId)throw new Error(`RPC is connected to the wrong chain for ${key}.`);
    const token=new Contract(n.quoteAddress,TOKEN_ABI,provider);
    if(Number(await token.decimals())!==n.quoteDecimals)throw new Error('Unexpected quote-token decimals.');
    const asset=new Contract(n.assetAddress,TOKEN_ABI,provider);
    if(Number(await asset.decimals())!==18)throw new Error('Unexpected wrapped native-token decimals.');
    const routers=await Promise.all(n.routers.map(async def=>{
      const router=new Contract(def.address,ROUTER_ABI,provider);
      if(!same(await router.factory(),def.factory)||!same(await router.WETH(),n.assetAddress))throw new Error('DEX router/factory verification failed.');
      return {...def,contract:router};
    }));
    const signer=wallet?.connect(provider)??null;
    let executor=null;
    if(settings.executor){
      executor=await verifiedExecutor({n,provider,signer},settings.executor,wallet);
    }
    return {n,settings,provider,token,routers,signer,executor,pool:new Contract(n.flashPool,POOL_ABI,provider)};
  }catch(e){provider.destroy();throw e;}
}
