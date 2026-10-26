// crypto-price-cli: fetch cryptocurrency prices from CoinGecko (no API key).

const API_URL = "https://api.coingecko.com/api/v3/simple/price";

// Common ticker aliases -> CoinGecko ids.
export const COIN_ALIASES = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  doge: "dogecoin",
  xrp: "ripple",
  ada: "cardano",
  ltc: "litecoin",
  bnb: "binancecoin",
  dot: "polkadot",
  matic: "matic-network",
};

export function resolveCoin(input) {
  const key = String(input || "").trim().toLowerCase();
  return COIN_ALIASES[key] || key;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retries on rate-limit (429) and transient 5xx.
 * Honors the Retry-After response header when present, otherwise
 * exponential backoff (baseMs * 2^attempt). `sleepImpl` is injectable for tests.
 */
export async function fetchWithRetry(fetchImpl, url, init, options = {}) {
  const retries = typeof options.retries === "number" ? options.retries : 3;
  const baseMs = typeof options.retryBaseMs === "number" ? options.retryBaseMs : 1000;
  const sleepImpl = options.sleepImpl || sleep;
  const maxRetryMs = typeof options.maxRetryMs === "number" ? options.maxRetryMs : 60000;
  const warn = typeof options.warn === "function" ? options.warn : null;
  const jitter = typeof options.retryJitter === "number" ? options.retryJitter : 0;
  const timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : 0;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    let timer = null;
    let timedOut = false;
    const fetchInit = { ...(init || {}) };
    let controller = null;
    if (timeoutMs > 0) {
      controller = new AbortController();
      fetchInit.signal = controller.signal;
    }
    try {
      let fetchPromise = fetchImpl(url, fetchInit);
      if (timeoutMs > 0) {
        fetchPromise = Promise.race([
          fetchPromise,
          new Promise((_, reject) => {
            timer = setTimeout(() => { timedOut = true; if (controller) controller.abort(); reject(new Error("__timeout__")); }, timeoutMs);
          }),
        ]);
      }
      res = await fetchPromise;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastError = timedOut
        ? new Error(`request timed out after ${timeoutMs}ms`)
        : err;
      if (attempt === retries) break;
      let waitMs = baseMs * 2 ** attempt;
      if (jitter > 0) waitMs = Math.round(waitMs * (1 + (Math.random() * 2 - 1) * jitter));
      await sleepImpl(waitMs);
      continue;
    }
    if (timer) clearTimeout(timer);
    if (res.ok) return res;
    lastError = new Error(scrubSecret(`CoinGecko request failed: ${res.status} ${res.statusText}`, options.apiKey));
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === retries) break;
    let waitMs = baseMs * 2 ** attempt;
    if (jitter > 0) waitMs = Math.round(waitMs * (1 + (Math.random() * 2 - 1) * jitter));
    const retryAfter = res.headers && typeof res.headers.get === "function"
      ? res.headers.get("retry-after")
      : null;
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) {
        const requested = secs * 1000;
        if (requested > maxRetryMs) {
          if (warn) warn(`Retry-After ${secs}s exceeds cap ${maxRetryMs}ms; capping.`);
          waitMs = maxRetryMs;
        } else {
          waitMs = requested;
        }
      }
    }
    await sleepImpl(waitMs);
  }
  throw lastError;
}

/**
 * Repeatedly run fetchOnce every intervalMs until the signal aborts or
 * maxTicks is reached. The schedule is a deadline, not a fixed sleep: each
 * tick sleeps only the time left until it is due, so timer drift does not
 * accumulate. When a tick starts more than one interval late (a laptop
 * suspend, a throttled container) the gap is reported once and the schedule
 * restarts from now instead of firing catch-up ticks.
 * sleepImpl and nowImpl are injectable so tests run instantly.
 */
export async function watchPrices({ fetchOnce, onTick, onError, intervalMs = 30000, signal, maxTicks = Infinity, sleepImpl = sleep, nowImpl = Date.now, jitter = true, maxErrors = Infinity }) {
  if (typeof fetchOnce !== "function") {
    throw new Error("fetchOnce must be a function");
  }
  if (!(intervalMs > 0)) {
    throw new Error("intervalMs must be positive");
  }
  if (!(maxErrors > 0)) {
    throw new Error("maxErrors must be positive");
  }
  let tick = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let lastTickFailed = false;
  let deadline = nowImpl();
  let oversleepReported = false;
  while (!signal?.aborted && tick < maxTicks) {
    const now = nowImpl();
    const oversleptMs = Math.max(0, now - deadline);
    if (now < deadline) {
      deadline = now;
    }
    tick++;
    const info = { oversleptMs };
    try {
      await fetchOnce(tick, info);
      consecutiveFailures = 0;
      lastTickFailed = false;
      if (onTick) onTick(tick, info);
    } catch (err) {
      failures++;
      consecutiveFailures++;
      lastTickFailed = true;
      if (typeof onError === "function") {
        onError(err, tick);
      } else {
        const reason = err && err.message ? err.message : String(err);
        console.error(`[watch] tick ${tick} failed: ${reason}`);
      }
      if (consecutiveFailures >= maxErrors) break;
    }
    if (tick >= maxTicks || signal?.aborted) break;
    let wait = intervalMs;
    if (jitter) {
      wait = Math.round(intervalMs * (0.8 + Math.random() * 0.4));
    }
    if (nowImpl() < deadline) {
      deadline = nowImpl();
    }
    deadline += wait;
    if (oversleptMs > intervalMs) {
      if (!oversleepReported) {
        console.error(`[watch] overslept ${Math.round(oversleptMs / 1000)}s (system suspend?)`);
        oversleepReported = true;
      }
      deadline = nowImpl() + wait;
    } else {
      oversleepReported = false;
    }
    const delay = Math.max(0, Math.ceil(deadline - nowImpl()));
    await sleepImpl(delay);
  }
  return { ticks: tick, failures, consecutiveFailures, lastTickFailed };
}

const cache = new Map();

function cacheKey(ids, vs) {
  return `${ids.join(",")}|${vs.join(",")}`;
}

/**
 * Fetch prices for the given coin ids in the given fiat currencies.
 * Results are cached in-memory for `cacheTtlMs` (default 60s) to reduce
 * CoinGecko rate-limit hits.
 * @param {string[]} ids - CoinGecko coin ids (e.g. ["bitcoin","ethereum"])
 * @param {string[]} vs - target currencies (e.g. ["usd","eur"])
 * @param {Function} fetchImpl - fetch implementation (injectable for tests)
 * @param {object} [options]
 * @param {number} [options.cacheTtlMs=60000]
 * @returns {Promise<Record<string, Record<string, number>>>}
 */
/**
 * Replace every occurrence of a configured secret with [REDACTED].
 * No-op when the secret is empty/unset; never throws on non-string input.
 */
export function scrubSecret(text, secret) {
  if (typeof text !== "string") return text;
  if (typeof secret !== "string" || secret === "") return text;
  return text.split(secret).join("[REDACTED]");
}

export async function fetchPrices(ids, vs = ["usd"], fetchImpl = fetch, options = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("ids must be a non-empty array");
  }
  ids = ids.map(resolveCoin);
  vs = vs.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  if (vs.length === 0) vs = ["usd"];
  const ttl = typeof options.cacheTtlMs === "number" ? options.cacheTtlMs : 60000;
  const key = cacheKey(ids, vs);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }
  const params = new URLSearchParams({
    ids: ids.join(","),
    vs_currencies: vs.join(","),
  });
  const url = `${API_URL}?${params.toString()}`;
  const headers = { accept: "application/json" };
  if (options.apiKey) headers["x-cg-demo-api-key"] = options.apiKey;
  const res = await fetchWithRetry(fetchImpl, url, { headers }, options);
  if (!res.ok) {
    throw new Error(scrubSecret(`CoinGecko request failed: ${res.status} ${res.statusText}`, options.apiKey));
  }
  const maxBytes = typeof options.maxResponseBytes === "number" ? options.maxResponseBytes : 1024 * 1024;
  const text = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json());
  if (text.length > maxBytes) throw new Error("CoinGecko response too large");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object") {
    throw new Error("Unexpected response from CoinGecko");
  }
  const missing = ids.filter((id) => data[id] === undefined);
  if (missing.length > 0) {
    throw new Error(`unknown coin id(s): ${missing.join(", ")}`);
  }
  cache.set(key, { ts: Date.now(), data });
  return data;
}

export function clearCache() {
  cache.clear();
}

export function formatPrices(data, vs = ["usd"]) {
  const lines = [];
  for (const [coin, prices] of Object.entries(data)) {
    const parts = vs.map((c) => {
      const key = String(c).toLowerCase();
      const val = prices && prices[key] !== undefined ? prices[key] : "n/a";
      return `${String(c).toUpperCase()}: ${val}`;
    }).join("  ");
    lines.push(`${coin}: ${parts}`);
  }
  return lines.join("\n");
}

export function formatJson(data, pretty = true) {
  return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/**
 * Parse a positive-int CLI value, falling back to def on garbage.
 */
export function parsePositiveInt(raw, def) {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/**
 * Validate CLI flag combinations. Returns an error message or null.
 */
export function validateFlags({ watchSecs = 0, date = null } = {}) {
  if (watchSecs > 0 && date) {
    return "--watch and --date cannot be combined: historical prices are static, nothing to refresh.";
  }
  return null;
}

/**
 * Disk cache for historical prices (immutable, so no TTL). Files live at
 * <dir>/<coin>-<YYYY-MM-DD>.json. Returns null on miss or corrupt entry.
 */
export function historyCacheFile(dir, coin, dateStr) {
  const safeCoin = String(coin).replace(/[^a-z0-9-]/gi, "_").toLowerCase();
  return `${dir}/${safeCoin}-${dateStr}.json`;
}

export async function readHistoryCache(dir, coin, dateStr) {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(historyCacheFile(dir, coin, dateStr), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

export async function writeHistoryCache(dir, coin, dateStr, prices) {
  const { mkdir, writeFile, lstat } = await import("node:fs/promises");
  // Defense in depth: never follow a symlinked cache path.
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) throw new Error("refusing to write through a symlinked cache dir");
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  await mkdir(dir, { recursive: true });
  const st2 = await lstat(dir);
  if (st2.isSymbolicLink()) throw new Error("refusing to write through a symlinked cache dir");
  await writeFile(historyCacheFile(dir, coin, dateStr), JSON.stringify(prices));
}

export function defaultHistoryCacheDir() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const base = process.env.XDG_CACHE_HOME || `${home}/.cache`;
  return `${base}/crypto-price-cli/history`;
}

/**
 * List history cache entries: [{coin, date, currencies[]}]. Missing dir → [].
 */
export async function listHistoryCache(dir) {
  const { readdir, readFile } = await import("node:fs/promises");
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    const m = /^(.+)-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    try {
      const data = JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      out.push({ coin: m[1], date: m[2], currencies: Object.keys(data).sort() });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Render a UTC timestamp header for --watch refreshes.
 * @param {Date} [now=new Date()]
 */
export function timestampHeader(now = new Date(), oversleptMs = 0) {
  const iso = now.toISOString();
  const header = `[${iso.slice(0, 10)} ${iso.slice(11, 19)}]`;
  return oversleptMs > 0 ? `${header} (+${Math.round(oversleptMs / 1000)}s overslept)` : header;
}

/**
 * Fetch the historical price of a coin on a given date.
 * @param {string} coin - CoinGecko coin id (e.g. "bitcoin")
 * @param {string} dateStr - date as YYYY-MM-DD
 * @param {string[]} vs - target currencies (e.g. ["usd"])
 * @param {Function} fetchImpl - fetch implementation (injectable for tests)
 * @returns {Promise<Record<string, number>>} map of currency -> price
 */
export async function fetchHistoricalPrice(coin, dateStr, vs = ["usd"], fetchImpl = fetch, options = {}) {
  if (!coin || typeof coin !== "string") {
    throw new Error("coin must be a non-empty string");
  }
  coin = resolveCoin(coin);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const apiDate = `${m[3]}-${m[2]}-${m[1]}`;
  const cacheDir = options && options.cacheDir !== undefined ? options.cacheDir : defaultHistoryCacheDir();
  let union = null;
  if (cacheDir) {
    union = await readHistoryCache(cacheDir, coin, dateStr);
    if (union && vs.every((c) => union[c] !== undefined)) {
      const out = {};
      for (const c of vs) out[c] = union[c];
      return out;
    }
  }
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin)}/history?date=${apiDate}&localization=false`;
  const headers = { accept: "application/json" };
  if (options && options.apiKey) headers["x-cg-demo-api-key"] = options.apiKey;
  const res = await fetchWithRetry(fetchImpl, url, { headers }, options || {});
  if (!res.ok) {
    throw new Error(scrubSecret(`CoinGecko request failed: ${res.status} ${res.statusText}`, options && options.apiKey));
  }
  const maxBytes = typeof (options && options.maxResponseBytes) === "number" ? (options && options.maxResponseBytes) : 1024 * 1024;
  const text2 = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json());
  if (text2.length > maxBytes) throw new Error("CoinGecko response too large");
  const data = JSON.parse(text2);
  const prices = data && data.market_data && data.market_data.current_price;
  if (!prices || typeof prices !== "object") {
    throw new Error("No market data for that date");
  }
  const out = {};
  for (const c of vs) {
    if (prices[c] !== undefined) out[c] = prices[c];
  }
  if (cacheDir) {
    await writeHistoryCache(cacheDir, coin, dateStr, { ...(union || {}), ...out });
  }
  return out;
}
