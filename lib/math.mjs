export const ceilDiv = (a,b) => (a+b-1n)/b;
export const max = (a,b) => a>b?a:b;
export function parseAmount(text,decimals) {
  if (typeof text!=='string' || !/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Use a positive decimal amount.');
  const [whole,fraction='']=text.split('.');
  if(fraction.length>decimals) throw new Error(`At most ${decimals} decimal places are allowed.`);
  return BigInt(whole)*10n**BigInt(decimals)+BigInt((fraction+'0'.repeat(decimals)).slice(0,decimals)||'0');
}
export function formatAmount(n,decimals,places=6) {
  const sign=n<0n?'-':''; if(n<0n)n=-n;
  const base=10n**BigInt(decimals);
  const fraction=(n%base).toString().padStart(decimals,'0').slice(0,places).replace(/0+$/,'');
  return `${sign}${n/base}${fraction?'.'+fraction:''}`;
}
export function tradeBounds({amountIn,assetOut,quoteOut,premium,gasInQuote,minNetProfit,slippageBps}) {
  const minProfit=minNetProfit+gasInQuote;
  return {
    minAssetOut:assetOut*BigInt(10000-slippageBps)/10000n,
    minQuoteOut:max(quoteOut*BigInt(10000-slippageBps)/10000n,amountIn+premium+minProfit),
    minProfit,
    estimatedNet:quoteOut-amountIn-premium-gasInQuote
  };
}
export function validateBudget({cost,perTrade,dailySpent,dailyLimit,count,maxCount}) {
  if(cost>perTrade) throw new Error('Transaction exceeds the configured gas-fee cap.');
  if(dailySpent+cost>dailyLimit) throw new Error('Daily gas budget exhausted.');
  if(count>=maxCount) throw new Error('Daily transaction limit reached.');
}
