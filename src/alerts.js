import { resolveCoin } from "./index.js";

export function parseAlertSpecs(specs, defaultCoins = []) {
  const alerts = [];
  for (const spec of specs) {
    const raw = String(spec).trim();
    if (!raw) throw new Error(`invalid alert spec: "${spec}"`);
    let coinPart = null;
    let rest = raw;
    const colon = raw.indexOf(":");
    if (colon !== -1) {
      coinPart = raw.slice(0, colon).trim();
      rest = raw.slice(colon + 1).trim();
      if (!coinPart) throw new Error(`invalid alert spec: "${spec}"`);
    }
    const eq = rest.indexOf("=");
    if (eq === -1) throw new Error(`invalid alert spec: "${spec}"`);
    const direction = rest.slice(0, eq).trim().toLowerCase();
    const thresholdRaw = rest.slice(eq + 1).trim();
    if (direction !== "above" && direction !== "below") throw new Error(`invalid alert spec: "${spec}"`);
    const threshold = Number(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error(`invalid alert spec: "${spec}"`);
    let coins = coinPart ? [resolveCoin(coinPart)] : defaultCoins;
    if (coins.length === 0) throw new Error(`invalid alert spec: "${spec}"`);
    if (coinPart) {
      const wanted = defaultCoins.map((c) => resolveCoin(c));
      for (const coin of coins) {
        if (wanted.length > 0 && !wanted.includes(coin)) {
          throw new Error(`invalid alert spec: "${spec}" (coin not in requested coins: ${defaultCoins.join(", ")})`);
        }
      }
    }
    for (const coin of coins) alerts.push({ coin, direction, threshold });
  }
  return alerts;
}

export function createAlertState(alerts, hysteresisPct = 1) {
  return alerts.map((a) => ({ ...a, armed: true, lastPrice: null, hysteresisPct }));
}

export function defaultAlertStateFile() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const base = process.env.XDG_CACHE_HOME || `${home}/.cache`;
  return `${base}/crypto-price-cli/alerts-state.json`;
}

export async function loadAlertState(filePath = defaultAlertStateFile(), ttlHours = 24, now = Date.now()) {
  const { readFile } = await import("node:fs/promises");
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    console.error(`[alerts] warning: failed to read alert state from ${filePath}: ${err.message}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[alerts] warning: corrupt alert state file ${filePath}: ${err.message}`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`[alerts] warning: corrupt alert state in ${filePath} (not an object)`);
    return {};
  }
  const ttlMs = ttlHours * 3600 * 1000;
  const result = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (ttlHours === 0) continue;
    if (typeof entry.updatedAt === "number" && now - entry.updatedAt > ttlMs) {
      continue;
    }
    result[key] = {
      lastPrice: typeof entry.lastPrice === "number" && Number.isFinite(entry.lastPrice) ? entry.lastPrice : null,
      armed: typeof entry.armed === "boolean" ? entry.armed : true,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
    };
  }
  return result;
}

export async function saveAlertState(filePath = defaultAlertStateFile(), stateMap = {}, now = Date.now()) {
  const { mkdir, writeFile, rename, lstat } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const dir = dirname(filePath);
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) throw new Error("refusing to write through a symlinked cache dir");
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  await mkdir(dir, { recursive: true });
  const st2 = await lstat(dir);
  if (st2.isSymbolicLink()) throw new Error("refusing to write through a symlinked cache dir");
  const tmpFile = join(dir, `.alerts-state-${process.pid}-${now}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmpFile, JSON.stringify(stateMap, null, 2), "utf8");
  await rename(tmpFile, filePath);
}

export function restoreAlertState(state, persistedMap = {}) {
  for (const alert of state) {
    if (typeof alert.lastPrices !== "object" || alert.lastPrices === null) {
      alert.lastPrices = {};
    }
    let anyArmed = true;
    for (const [key, record] of Object.entries(persistedMap)) {
      const colonIdx = key.indexOf(":");
      if (colonIdx === -1) continue;
      const coin = key.slice(0, colonIdx);
      const currency = key.slice(colonIdx + 1);
      if (coin === alert.coin) {
        if (record.lastPrice !== null) {
          alert.lastPrices[currency] = record.lastPrice;
          alert.lastPrice = record.lastPrice;
        }
        if (record.armed === false) {
          anyArmed = false;
        }
      }
    }
    if (!anyArmed) {
      alert.armed = false;
    }
  }
}

export function exportAlertState(state, now = Date.now(), existingMap = {}) {
  const map = { ...existingMap };
  for (const alert of state) {
    if (alert.lastPrices && typeof alert.lastPrices === "object") {
      for (const [currency, price] of Object.entries(alert.lastPrices)) {
        if (typeof price === "number" && Number.isFinite(price)) {
          const key = `${alert.coin}:${currency.toLowerCase()}`;
          map[key] = {
            lastPrice: price,
            armed: alert.armed,
            updatedAt: now,
          };
        }
      }
    }
  }
  return map;
}

export function evaluateAlerts(state, prices, currencies = "usd") {
  const messages = [];
  const currencyList = Array.isArray(currencies) ? currencies : [currencies];
  for (const alert of state) {
    if (typeof alert.lastPrices !== "object" || alert.lastPrices === null) {
      alert.lastPrices = {};
    }
    for (const currency of currencyList) {
      const price = prices?.[alert.coin]?.[currency];
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      const prev = alert.lastPrices[currency] ?? null;
      if (alert.armed && prev !== null) {
        const crossed = alert.direction === "above"
          ? prev <= alert.threshold && price > alert.threshold
          : prev >= alert.threshold && price < alert.threshold;
        if (crossed) {
          alert.armed = false;
          messages.push(`[ALERT] ${alert.coin} crossed ${alert.direction} ${alert.threshold} ${String(currency).toUpperCase()} (now ${price})`);
        }
      }
      if (!alert.armed) {
        const h = alert.hysteresisPct / 100;
        const rearm = alert.direction === "above"
          ? price <= alert.threshold * (1 - h)
          : price >= alert.threshold * (1 + h);
        if (rearm) alert.armed = true;
      }
      alert.lastPrices[currency] = price;
    }
  }
  return messages;
}
