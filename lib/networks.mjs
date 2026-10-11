// Deployment sources and review date are recorded in SOURCES.md. Addresses are fixed.
export const NETWORKS = {
  base: {
    key:'base',chainId:8453,name:'Base',native:'ETH',quote:'USDC',quoteDecimals:6,
    asset:'WETH',assetAddress:'0x4200000000000000000000000000000000000006',
    quoteAddress:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    flashPool:'0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
    explorer:'https://basescan.org',
    routers:[
      {name:'Uniswap V2',address:'0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',factory:'0x8909dc15e40173ff4699343b6eb8132c65e18ec6'},
      {name:'PancakeSwap V2',address:'0x8cfe327cec66d1c090dd72bd0ff11d690c33a2eb',factory:'0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e'}
    ],gasOracle:'0x420000000000000000000000000000000000000f',l1Block:'0x4200000000000000000000000000000000000015'
  },
  bsc: {
    key:'bsc',chainId:56,name:'BNB Smart Chain',native:'BNB',quote:'USDT',quoteDecimals:18,
    asset:'WBNB',assetAddress:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    quoteAddress:'0x55d398326f99059ff775485246999027b3197955',
    flashPool:'0x6807dc923806fe8fd134338eabca509979a7e0cb',
    explorer:'https://bscscan.com',
    routers:[
      {name:'Uniswap V2',address:'0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',factory:'0x8909dc15e40173ff4699343b6eb8132c65e18ec6'},
      {name:'PancakeSwap V2',address:'0x10ed43c718714eb63d5aa57b78b54704e256024e',factory:'0xca143ce32fe78f1f7019d7d551a6402fc5350c73'}
    ]
  }
};
