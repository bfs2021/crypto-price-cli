#!/usr/bin/env node
import { fetchPrices, formatPrices, formatJson, fetchHistoricalPrice, parsePositiveInt, listHistoryCache, defaultHistoryCacheDir } from "../src/index.js";

const args = process.argv.slice(2);
const apiKey = process.env.COINGECKO_API_KEY || process.env.CG_API_KEY || "";
const opts = apiKey ? { apiKey } : {};

if (args.includes("-h") || args.includes("--help") || args.includes("help")) {
  console.log(`crypto-price — fetch cryptocurrency prices from CoinGecko (no API key required)

Usage:
  crypto-price [coins] [currencies] [options]

Arguments:
  coins        Comma-separated coin ids or tickers (btc,eth,sol,...). Default: bitcoin
  currencies   Comma-separated fiat currencies. Default: usd

Options:
  --date=YYYY-MM-DD   Historical price on that date (loops over coins)
  --watch[=SECS]      Refresh continuously (default every 30s, Ctrl+C stops)
  --interval=SECS     Alias for --watch=SECS
  --count=N           Stop after N refreshes (for scripts/cron)
  --dump-cache        List cached historical prices and exit
  --json              Machine-readable JSON output
  --compact           Compact JSON (no indentation)
  -h, --help          Show this help

Environment:
  COINGECKO_API_KEY / CG_API_KEY   Optional demo API key (sent as x-cg-demo-api-key)

Examples:
  crypto-price
  crypto-price bitcoin,ethereum usd,eur
  crypto-price btc eth usd
  crypto-price bitcoin usd --date=2024-01-15
  crypto-price bitcoin usd --json
`);
  process.exit(0);
}

const json = args.includes("--json");
const compact = args.includes("--compact");
const dateArg = args.find((a) => a.startsWith("--date="));
const date = dateArg ? dateArg.slice("--date=".length) : null;
const watchArg = args.find((a) => a === "--watch" || a.startsWith("--watch=") || a === "--interval" || a.startsWith("--interval="));
const watchSecs = watchArg ? parsePositiveInt(watchArg.split("=")[1] || "30", 30) : 0;
const countArg = args.find((a) => a.startsWith("--count="));
const maxTicks = countArg ? parsePositiveInt(countArg.split("=")[1], 0) : 0;
const filtered = args.filter((a) => a !== "--json" && !a.startsWith("--date=") && a !== "--watch" && !a.startsWith("--watch=") && a !== "--interval" && !a.startsWith("--interval=") && !a.startsWith("--count=") && a !== "--dump-cache");
const coins = (filtered[0] || "bitcoin").split(",").map((s) => s.trim()).filter(Boolean);
const vs = (filtered[1] || "usd").split(",").map((s) => s.trim()).filter(Boolean);

async function showOnce() {
  if (date) {
    const data = {};
    for (const coin of coins) {
      data[coin] = await fetchHistoricalPrice(coin, date, vs, fetch, opts);
    }
    if (json) {
      console.log(formatJson(data, !compact));
    } else {
      for (const [coin, prices] of Object.entries(data)) {
        console.log(`${coin} on ${date}: ` + vs.map((c) => `${c.toUpperCase()}: ${prices[c] ?? "n/a"}`).join("  "));
      }
    }
  } else {
    const data = await fetchPrices(coins, vs, fetch, opts);
    console.log(json ? formatJson(data, !compact) : formatPrices(data, vs));
  }
}

try {
  if (args.includes("--dump-cache")) {
    const entries = await listHistoryCache(defaultHistoryCacheDir());
    if (json) {
      console.log(formatJson(entries, !compact));
    } else if (entries.length === 0) {
      console.log("history cache is empty");
    } else {
      for (const e of entries) console.log(`${e.coin} on ${e.date}: ${e.currencies.join(", ").toUpperCase()}`);
    }
    process.exit(0);
  }
  if (watchArg && !(watchSecs > 0)) {
    console.error("error: --watch needs a positive number of seconds");
    process.exit(1);
  }
  const { validateFlags: checkFlags } = await import("../src/index.js");
  const flagError = checkFlags({ watchSecs, date });
  if (flagError) {
    console.error(`error: ${flagError}`);
    process.exit(1);
  }
  if (watchSecs > 0) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const { watchPrices, timestampHeader } = await import("../src/index.js");
    await watchPrices({
      fetchOnce: (_tick, info = {}) => {
        if (!json) console.log(timestampHeader(new Date(), info.oversleptMs));
        return showOnce();
      },
      intervalMs: watchSecs * 1000,
      signal: controller.signal,
      ...(maxTicks > 0 ? { maxTicks } : {}),
    });
  } else {
    await showOnce();
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
