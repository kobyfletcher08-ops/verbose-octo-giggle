import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS } from './markets.mjs';
import { normalizePools, candidateSpreads } from './analysis.mjs';
const base = MARKETS[0];
function fake(dexId, priceUsd, liquidityUsd, lastChar) {
  return {
    chainId: 'base', dexId,
    pairAddress: `0x${lastChar.repeat(40)}`,
    baseToken: { address: base.assetAddress }, quoteToken: { address: base.quoteAddress },
    priceUsd: String(priceUsd), liquidity: { usd: liquidityUsd }, volume: { h24: 1000 }
  };
}
test('filters exact chain/token/quote, liquidity threshold, duplicates', () => {
  const a = fake('uniswap', 2000, 100000, 'a');
  const b = fake('aerodrome', 2020, 100000, 'b');
  const bad = { ...fake('evil', 3000, 100000, 'c'), quoteToken: { address: '0x' + '1'.repeat(40) } };
  const pools = normalizePools(base, [a, b, a, bad, fake('tiny', 99999, 1, 'd')], 50000);
  assert.equal(pools.length, 2);
  assert.equal(pools[0].priceUsd, 2000);
});
test('correct directional spread and gross (not net) calculation', () => {
  const pools = normalizePools(base, [fake('uniswap', 2000, 100000, 'a'), fake('aerodrome', 2020, 100000, 'b')], 50000);
  const rows = candidateSpreads(pools, 0.5, 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].buy.dex, 'uniswap');
  assert.equal(rows[0].sell.dex, 'aerodrome');
  assert.ok(Math.abs(rows[0].spreadPct - 1) < 1e-10);
  assert.ok(Math.abs(rows[0].theoreticalGrossUsd - 10) < 1e-10);
});
test('rejects same-DEX pool differences and high spread threshold', () => {
  const pools = normalizePools(base, [fake('same', 2000, 100000, 'a'), fake('same', 2020, 100000, 'b')], 50000);
  assert.equal(candidateSpreads(pools, 0.1, 1000).length, 0);
  const two = normalizePools(base, [fake('a', 2000, 100000, 'a'), fake('b', 2020, 100000, 'b')], 50000);
  assert.equal(candidateSpreads(two, 1.1, 1000).length, 0);
});
