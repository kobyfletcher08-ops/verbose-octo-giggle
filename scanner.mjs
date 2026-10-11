#!/usr/bin/env node
import { MARKETS } from './markets.mjs';
import { normalizePools, candidateSpreads } from './analysis.mjs';

const DEFAULTS = { interval: 30, minLiquidity: 50000, minSpread: 0.8, notional: 1000, once: false };

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === '--once') { cfg.once = true; continue; }
    if (arg === '--help' || arg === '-h') { cfg.help = true; continue; }
    const [key, textValue] = arg.split('=');
    const map = { '--interval': 'interval', '--min-liquidity': 'minLiquidity', '--min-spread': 'minSpread', '--notional': 'notional' };
    if (!(key in map) || textValue === undefined) throw new Error(`Unknown option: ${arg}`);
    const value = Number(textValue);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${key}: ${textValue}`);
    cfg[map[key]] = value;
  }
  if (cfg.interval < 15) throw new Error('Please keep --interval at least 15 seconds.');
  return cfg;
}

async function fetchPairs(market) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${market.chain}/${market.assetAddress}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${market.chain}`);
    return await res.json();
  } finally { clearTimeout(id); }
}

function money(value) { return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }

async function scan(market, cfg) {
  const raw = await fetchPairs(market);
  const pools = normalizePools(market, raw, cfg.minLiquidity);
  const candidates = candidateSpreads(pools, cfg.minSpread, cfg.notional);
  console.log(`\n${market.pair} on ${market.chain.toUpperCase()} (chain ID ${market.chainId}): ${pools.length} qualifying pools`);
  if (!candidates.length) {
    console.log(`  No indicative spread at or above ${cfg.minSpread}% across different DEXes.`);
    return;
  }
  for (const [index, row] of candidates.slice(0, 5).entries()) {
    console.log(`  ${index + 1}. ${row.buy.dex} -> ${row.sell.dex}: ${row.spreadPct.toFixed(3)}% spot gap`);
    console.log(`     ${money(row.buy.priceUsd)} -> ${money(row.sell.priceUsd)} | theoretical gross on ${money(cfg.notional)}: ${money(row.theoreticalGrossUsd)}`);
    console.log(`     Buy pool:  ${row.buy.address} (reported liquidity ${money(row.buy.liquidityUsd)})`);
    console.log(`     Sell pool: ${row.sell.address} (reported liquidity ${money(row.sell.liquidityUsd)})`);
  }
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) {
    console.log('Usage: node scanner.mjs [--once] [--interval=30] [--min-liquidity=50000] [--min-spread=0.8] [--notional=1000]');
    return;
  }
  console.log('Base + BSC DEX spread scanner (READ ONLY; no keys, wallets, trades or flash loans).');
  console.log('WARNING: SPOT-PRICE GAPS ARE NOT EXECUTABLE PROFITS. Prices may be stale.');
  console.log('No swap fees, price impact, flash-loan costs, MEV, or gas are included in gross figures.');
  do {
    console.log(`\n=== ${new Date().toISOString()} ===`);
    for (const market of MARKETS) {
      try { await scan(market, cfg); }
      catch (err) { console.error(`${market.chain.toUpperCase()} scan error: ${err.message}`); }
    }
    if (!cfg.once) await new Promise(resolve => setTimeout(resolve, cfg.interval * 1000));
  } while (!cfg.once);
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
