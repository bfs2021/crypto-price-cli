import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchPrices, formatPrices, formatJson, clearCache, fetchHistoricalPrice, resolveCoin, fetchWithRetry, watchPrices, timestampHeader, validateFlags, parsePositiveInt, readHistoryCache, writeHistoryCache, listHistoryCache } from "../src/index.js";

test("watchPrices respects jitter=false", async () => {
  const sleeps = [];
  let now = 0;
  await watchPrices({ fetchOnce: async () => {}, intervalMs: 1000, maxTicks: 2, nowImpl: () => now, sleepImpl: (ms) => { sleeps.push(ms); now += ms; return Promise.resolve(); }, jitter: false });
  assert.deepEqual(sleeps, [1000]);
});

test("watchPrices with jitter stays within range", async () => {
  const sleeps = [];
  let now = 0;
  await watchPrices({ fetchOnce: async () => {}, intervalMs: 1000, maxTicks: 3, nowImpl: () => now, sleepImpl: (ms) => { sleeps.push(ms); now += ms; return Promise.resolve(); }, jitter: true });
  assert.equal(sleeps.length, 2);
  for (const s of sleeps) assert.ok(s >= 800 && s <= 1200, `out of range: ${s}`);
});

test("watchPrices keeps a deadline with an injected clock", async () => {
  let now = 0;
  const sleeps = [];
  const ticks = [];
  await watchPrices({
    fetchOnce: async () => {},
    intervalMs: 1000,
    maxTicks: 4,
    jitter: false,
    nowImpl: () => now,
    sleepImpl: async (ms) => { sleeps.push(ms); now += ms; },
    onTick: (tick, info) => ticks.push([tick, info.oversleptMs]),
  });
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  assert.deepEqual(ticks, [[1, 0], [2, 0], [3, 0], [4, 0]]);
});

test("watchPrices reports an oversleep once and fires no catch-up ticks", async () => {
  let now = 0;
  let suspendOnce = true;
  const sleeps = [];
  const ticks = [];
  const logged = [];
  const originalError = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    await watchPrices({
      fetchOnce: async () => {},
      intervalMs: 1000,
      maxTicks: 3,
      jitter: false,
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        now += ms + (suspendOnce ? 5000 : 0);
        suspendOnce = false;
      },
      onTick: (tick, info) => ticks.push([tick, info.oversleptMs]),
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(ticks, [[1, 0], [2, 5000], [3, 0]]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[watch\] overslept 5s \(system suspend\?\)/);
  // The next sleep is a full interval again: no burst of catch-up ticks.
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("timestampHeader can note an overslept tick", () => {
  assert.equal(timestampHeader(new Date("2026-10-24T15:04:05Z")), "[2026-10-24 15:04:05]");
  assert.equal(timestampHeader(new Date("2026-10-24T15:04:05Z"), 5000), "[2026-10-24 15:04:05] (+5s overslept)");
});

test("fetchWithRetry caps Retry-After and warns", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, statusText: "Too Many", headers: { get: () => "120" }, json: async () => ({}) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };
  const warns = [];
  const sleeps = [];
  await fetchWithRetry(fetchImpl, "u", {}, { sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); }, maxRetryMs: 30000, warn: (m) => warns.push(m) });
  assert.deepEqual(sleeps, [30000]);
  assert.equal(warns.length, 1);
});

test("fetchWithRetry respects maxRetryMs without cap warning", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, statusText: "Too Many", headers: { get: () => "2" }, json: async () => ({}) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };
  const warns = [];
  const sleeps = [];
  await fetchWithRetry(fetchImpl, "u", {}, { sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); }, maxRetryMs: 30000, warn: (m) => warns.push(m) });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(warns.length, 0);
});

test("formatJson compact mode", () => {
  const data = { a: 1 };
  assert.equal(formatJson(data, false), '{"a":1}');
  assert.match(formatJson(data, true), /\n/);
});

test("formatPrices marks missing currencies as n/a", () => {
  assert.equal(formatPrices({ bitcoin: { usd: 42000 } }, ["usd", "eur"]), "bitcoin: USD: 42000  EUR: n/a");
});

test("fetchPrices normalizes currency case", async () => {
  let urlSeen = "";
  const fetchImpl = async (url) => {
    urlSeen = url;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ bitcoin: { usd: 42000 } }) };
  };
  clearCache();
  const data = await fetchPrices(["bitcoin"], ["USD", "Eur"], fetchImpl);
  assert.ok(urlSeen.includes("vs_currencies=USD%2CEur") === false || urlSeen.toLowerCase().includes("vs_currencies=usd%2ceur") || urlSeen.toLowerCase().includes("vs_currencies=usd,eur"));
});

test("listHistoryCache skips non-object JSON payloads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-shape-"));
  await writeHistoryCache(dir, "bitcoin", "2026-10-26", { usd: 42000 });
  await fs.writeFile(`${dir}/ethereum-2026-10-26.json`, "[1,2,3]");
  await fs.writeFile(`${dir}/dogecoin-2026-10-26.json`, '"just a string"');
  const entries = await listHistoryCache(dir);
  assert.deepEqual(entries, [
    { coin: "bitcoin", date: "2026-10-26", currencies: ["usd"] },
  ]);
});

test("listHistoryCache enumerates stored entries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-list-"));
  assert.deepEqual(await listHistoryCache(dir), []);
  await writeHistoryCache(dir, "bitcoin", "2024-01-15", { usd: 42000, eur: 38000 });
  assert.deepEqual(await listHistoryCache(dir), [
    { coin: "bitcoin", date: "2024-01-15", currencies: ["eur", "usd"] },
  ]);
});

test("fetchHistoricalPrice merges vs currencies in disk cache", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-vs-"));
  await writeHistoryCache(dir, "bitcoin", "2024-01-15", { usd: 42000 });
  let calls = 0;
  const mock = async () => {
    calls++;
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ market_data: { current_price: { usd: 42000, eur: 38000 } } }),
    };
  };
  const opts = { cacheDir: dir };
  assert.deepEqual(await fetchHistoricalPrice("bitcoin", "2024-01-15", ["usd", "eur"], mock, opts), { usd: 42000, eur: 38000 });
  assert.equal(calls, 1);
  // Now fully cached: no fetch, subset returned.
  assert.deepEqual(await fetchHistoricalPrice("bitcoin", "2024-01-15", ["usd"], mock, opts), { usd: 42000 });
  assert.equal(calls, 1);
});

test("history disk cache round-trips", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-"));
  assert.equal(await readHistoryCache(dir, "bitcoin", "2024-01-15"), null);
  await writeHistoryCache(dir, "bitcoin", "2024-01-15", { usd: 42000 });
  assert.deepEqual(await readHistoryCache(dir, "bitcoin", "2024-01-15"), { usd: 42000 });
});

test("parsePositiveInt falls back on garbage", () => {
  assert.equal(parsePositiveInt("10", 30), 10);
  assert.equal(parsePositiveInt(undefined, 30), 30);
  assert.equal(parsePositiveInt("abc", 30), 30);
  assert.equal(parsePositiveInt("0", 30), 30);
  assert.equal(parsePositiveInt("-5", 30), 30);
});

test("validateFlags rejects watch combined with date", () => {
  assert.equal(validateFlags({ watchSecs: 30, date: "2024-01-15" }), "--watch and --date cannot be combined: historical prices are static, nothing to refresh.");
  assert.equal(validateFlags({ watchSecs: 0, date: "2024-01-15" }), null);
  assert.equal(validateFlags({ watchSecs: 30, date: null }), null);
});

test("timestampHeader formats UTC time", () => {
  assert.equal(timestampHeader(new Date("2026-10-24T15:04:05Z")), "[2026-10-24 15:04:05]");
});

test("fetchPrices validates input", async () => {
  await assert.rejects(() => fetchPrices([]), /non-empty array/);
});

test("fetchPrices parses response", async () => {
  const mock = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ bitcoin: { usd: 100 } }),
  });
  const data = await fetchPrices(["bitcoin"], ["usd"], mock);
  assert.deepEqual(data, { bitcoin: { usd: 100 } });
});

test("fetchPrices throws on non-ok", async () => {
  clearCache();
  const mock = async () => ({ ok: false, status: 429, statusText: "Too Many Requests", headers: { get: () => null }, json: async () => ({}) });
  await assert.rejects(() => fetchPrices(["bitcoin"], ["usd"], mock, { retryBaseMs: 1, sleepImpl: () => Promise.resolve() }), /429/);
});

test("formatPrices formats output", () => {
  const out = formatPrices({ bitcoin: { usd: 100, eur: 90 } }, ["usd", "eur"]);
  assert.equal(out, "bitcoin: USD: 100  EUR: 90");
});

test("fetchPrices caches results", async () => {
  clearCache();
  let calls = 0;
  const mock = async () => {
    calls += 1;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ bitcoin: { usd: 100 } }) };
  };
  const a = await fetchPrices(["bitcoin"], ["usd"], mock, { cacheTtlMs: 10000 });
  const b = await fetchPrices(["bitcoin"], ["usd"], mock, { cacheTtlMs: 10000 });
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  clearCache();
});

test("formatJson formats output", () => {
  const out = formatJson({ bitcoin: { usd: 100 } });
  assert.equal(out, JSON.stringify({ bitcoin: { usd: 100 } }, null, 2));
});

test("resolveCoin maps tickers and passes ids through", () => {
  assert.equal(resolveCoin("btc"), "bitcoin");
  assert.equal(resolveCoin("ETH"), "ethereum");
  assert.equal(resolveCoin("bitcoin"), "bitcoin");
});

test("fetchPrices resolves aliases in request URL", async () => {
  clearCache();
  let seen = "";
  const mock = async (url) => {
    seen = String(url);
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ bitcoin: { usd: 1 } }) };
  };
  await fetchPrices(["btc"], ["usd"], mock, { cacheTtlMs: 0 });
  assert.match(seen, /ids=bitcoin/);
  clearCache();
});

test("fetchWithRetry retries 429 then succeeds", async () => {
  let calls = 0;
  const waits = [];
  const fail = () => ({ ok: false, status: 429, statusText: "Too Many Requests", headers: { get: () => null } });
  const mock = async () => (++calls === 1 ? fail() : { ok: true, status: 200, statusText: "OK" });
  const res = await fetchWithRetry(mock, "https://x", {}, { retries: 3, retryBaseMs: 10, sleepImpl: (ms) => { waits.push(ms); return Promise.resolve(); } });
  assert.ok(res.ok);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [10]);
});

test("fetchWithRetry gives up after retries", async () => {
  const mock = async () => ({ ok: false, status: 429, statusText: "Too Many Requests", headers: { get: () => null } });
  await assert.rejects(
    () => fetchWithRetry(mock, "https://x", {}, { retries: 1, retryBaseMs: 1, sleepImpl: () => Promise.resolve() }),
    /429/
  );
});

test("fetchWithRetry does not retry 400", async () => {
  let calls = 0;
  const mock = async () => { calls++; return { ok: false, status: 400, statusText: "Bad", headers: { get: () => null } }; };
  await assert.rejects(() => fetchWithRetry(mock, "https://x", {}, { sleepImpl: () => Promise.resolve() }), /400/);
  assert.equal(calls, 1);
});

test("watchPrices ticks until maxTicks", async () => {
  let calls = 0;
  const ticks = [];
  await watchPrices({
    fetchOnce: async () => { calls++; },
    onTick: (n) => { ticks.push(n); },
    intervalMs: 5,
    maxTicks: 3,
    sleepImpl: () => Promise.resolve(),
  });
  assert.equal(calls, 3);
  assert.deepEqual(ticks, [1, 2, 3]);
});

test("watchPrices stops on abort", async () => {
  const controller = new AbortController();
  let calls = 0;
  const done = watchPrices({
    fetchOnce: async () => { calls++; controller.abort(); },
    intervalMs: 5,
    signal: controller.signal,
    sleepImpl: () => Promise.resolve(),
  });
  await done;
  assert.equal(calls, 1);
});

test("fetchHistoricalPrice validates date", async () => {
  await assert.rejects(() => fetchHistoricalPrice("bitcoin", "not-a-date"), /YYYY-MM-DD/);
});

test("fetchHistoricalPrice parses response", async () => {
  const mock = async (url) => {
    assert.match(url, /date=15-01-2024/);
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ market_data: { current_price: { usd: 42000, eur: 38000 } } }),
    };
  };
  const out = await fetchHistoricalPrice("bitcoin", "2024-01-15", ["usd"], mock, { cacheDir: null });
  assert.deepEqual(out, { usd: 42000 });
});

test("fetchHistoricalPrice uses disk cache on second call", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-hist-"));
  let calls = 0;
  const mock = async () => {
    calls++;
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ market_data: { current_price: { usd: 42000 } } }),
    };
  };
  const opts = { cacheDir: dir };
  assert.deepEqual(await fetchHistoricalPrice("bitcoin", "2024-01-15", ["usd"], mock, opts), { usd: 42000 });
  assert.deepEqual(await fetchHistoricalPrice("bitcoin", "2024-01-15", ["usd"], mock, opts), { usd: 42000 });
  assert.equal(calls, 1);
});
