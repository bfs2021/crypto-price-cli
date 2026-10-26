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
    const coins = coinPart ? [coinPart] : defaultCoins;
    if (coins.length === 0) throw new Error(`invalid alert spec: "${spec}"`);
    for (const coin of coins) alerts.push({ coin, direction, threshold });
  }
  return alerts;
}

export function createAlertState(alerts, hysteresisPct = 1) {
  return alerts.map((a) => ({ ...a, armed: true, lastPrice: null, hysteresisPct }));
}

export function evaluateAlerts(state, prices, currency = "usd") {
  const messages = [];
  for (const alert of state) {
    const price = prices?.[alert.coin]?.[currency];
    if (typeof price !== "number" || !Number.isFinite(price)) continue;
    const prev = alert.lastPrice;
    if (alert.armed && prev !== null) {
      const crossed = alert.direction === "above"
        ? prev <= alert.threshold && price > alert.threshold
        : prev >= alert.threshold && price < alert.threshold;
      if (crossed) {
        alert.armed = false;
        messages.push(`[ALERT] ${alert.coin} crossed ${alert.direction} ${alert.threshold} (now ${price})`);
      }
    }
    if (!alert.armed) {
      const h = alert.hysteresisPct / 100;
      const rearm = alert.direction === "above"
        ? price <= alert.threshold * (1 - h)
        : price >= alert.threshold * (1 + h);
      if (rearm) alert.armed = true;
    }
    alert.lastPrice = price;
  }
  return messages;
}
