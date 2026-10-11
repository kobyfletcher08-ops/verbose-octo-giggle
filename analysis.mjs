export function normalizePools(market, raw, minLiquidityUsd) {
  if (!Array.isArray(raw)) throw new TypeError(`Invalid response for ${market.chain}: expected an array`);
  const seen = new Set();
  const wantedAsset = market.assetAddress.toLowerCase();
  const wantedQuote = market.quoteAddress.toLowerCase();
  const output = [];

  for (const pool of raw) {
    if (pool.chainId?.toLowerCase() !== market.chain) continue;
    if (pool.baseToken?.address?.toLowerCase() !== wantedAsset) continue;
    if (pool.quoteToken?.address?.toLowerCase() !== wantedQuote) continue;
    const priceUsd = Number(pool.priceUsd);
    const liquidityUsd = Number(pool.liquidity?.usd);
    const volume24hUsd = Number(pool.volume?.h24 ?? 0);
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) continue;
    if (!(liquidityUsd >= minLiquidityUsd) || !Number.isFinite(liquidityUsd)) continue;
    const dex = String(pool.dexId ?? '').trim();
    const addr = String(pool.pairAddress ?? '').trim();
    if (!dex || !/^0x[a-fA-F0-9]{40}$/.test(addr)) continue;
    const key = `${dex}:${addr.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ dex, address: addr, priceUsd, liquidityUsd, volume24hUsd, url: pool.url ?? '' });
  }
  return output;
}

export function candidateSpreads(pools, minSpreadPct, sampleNotionalUsd) {
  const results = [];
  for (const buy of pools) {
    for (const sell of pools) {
      if (buy.dex === sell.dex || buy.address.toLowerCase() === sell.address.toLowerCase()) continue;
      if (buy.priceUsd >= sell.priceUsd) continue;
      const spreadPct = ((sell.priceUsd / buy.priceUsd) - 1) * 100;
      if (spreadPct < minSpreadPct) continue;
      results.push({
        buy,
        sell,
        spreadPct,
        // This is NOT expected take-home profit: spot-price gap only.
        theoreticalGrossUsd: sampleNotionalUsd * spreadPct / 100
      });
    }
  }
  return results.sort((a, b) => b.spreadPct - a.spreadPct);
}
