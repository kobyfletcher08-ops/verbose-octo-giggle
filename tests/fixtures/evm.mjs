import ganache from 'ganache';
import {BrowserProvider,Contract,ContractFactory,Wallet} from 'ethers';
import {readFile} from 'node:fs/promises';
import {compile} from '../../scripts/compile.mjs';
import {ROUTER_ABI,TOKEN_ABI,POOL_ABI} from '../../lib/chain.mjs';
let compiled;
export async function fixture(key='bsc'){
  compiled??=await compile({'Mocks.sol':{content:await readFile(new URL('Mocks.sol',import.meta.url),'utf8')}});
  const rpc=ganache.provider({logging:{quiet:true},chain:{chainId:key==='base'?8453:56,hardfork:'shanghai'},wallet:{totalAccounts:2,defaultBalance:1000}});
  const provider=new BrowserProvider(rpc,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
  const accounts=Object.values(rpc.getInitialAccounts());
  const owner=new Wallet(accounts[0].secretKey,provider),other=new Wallet(accounts[1].secretKey,provider);
  const deploy=async(name,args=[])=>{
    const data=compiled[name==='AtomicDexArbitrage'?'AtomicDexArbitrage.sol':'Mocks.sol'][name];
    const contract=await new ContractFactory(data.abi,'0x'+data.evm.bytecode.object,owner).deploy(...args);
    await contract.waitForDeployment();return contract;
  };
  const quote=await deploy('MockToken',[6]),asset=await deploy('MockToken',[18]);
  const pool=await deploy('MockFlashPool');
  const gasOracle=await deploy('MockGasOracle');
  const defs=[];
  for(const [i,qReserve] of [1000000n*10n**6n,1100000n*10n**6n].entries()){
    const aReserve=500n*10n**18n;
    const pair=await deploy('MockPair',[quote.target,asset.target,qReserve,aReserve]);
    const factory=await deploy('MockFactory',[pair.target]);
    const router=await deploy('MockRouter',[factory.target,asset.target,pair.target]);
    await(await quote.mint(router.target,qReserve)).wait();await(await asset.mint(router.target,aReserve)).wait();
    defs.push({name:i?'DEX B':'DEX A',address:router.target,factory:factory.target,router,pair,
      contract:new Contract(router.target,ROUTER_ABI,provider)});
  }
  await(await quote.mint(pool.target,1000000n*10n**6n)).wait();
  const executor=await deploy('AtomicDexArbitrage',[owner.address,quote.target,asset.target,pool.target,...defs.map(r=>r.address)]);
  const n={key,chainId:key==='base'?8453:56,name:'Local test chain',native:key==='base'?'ETH':'BNB',quote:key==='base'?'USDC':'USDT',quoteDecimals:6,asset:key==='base'?'WETH':'WBNB',
    quoteAddress:quote.target,assetAddress:asset.target,flashPool:pool.target,routers:defs,explorer:'https://bscscan.com',gasOracle:gasOracle.target,l1Block:gasOracle.target};
  const c={n,settings:{executor:executor.target,gasCap:2000000000000000n,dailyGas:10000000000000000n,gasPriceCap:10000000000n},
    provider,token:new Contract(quote.target,TOKEN_ABI,provider),routers:defs,signer:owner,executor,
    pool:new Contract(pool.target,POOL_ABI,provider)};
  async function trade({minProfit=1000000n,minQuoteOut=1n,minAssetOut=1n}={}){
    return {buyRouter:defs[0].address,sellRouter:defs[1].address,amountIn:100n*10n**6n,minAssetOut,minQuoteOut,minProfit,
      deadline:(await provider.getBlock('latest')).timestamp+60};
  }
  async function close(){provider.destroy();await rpc.disconnect();}
  return {rpc,provider,owner,other,quote,asset,pool,gasOracle,defs,executor,c,trade,close};
}
