import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseAlertSpecs,
  createAlertState,
  evaluateAlerts,
  loadAlertState,
  saveAlertState,
  restoreAlertState,
  exportAlertState,
} from "../src/alerts.js";

test("parses plain and per-coin specs", () => {
  const alerts = parseAlertSpecs(["above=100", "btc:below=50"], ["bitcoin", "ethereum"]);
  assert.deepEqual(alerts, [
    { coin: "bitcoin", direction: "above", threshold: 100 },
    { coin: "ethereum", direction: "above", threshold: 100 },
    { coin: "bitcoin", direction: "below", threshold: 50 },
  ]);
});

test("rejects invalid specs", () => {
  for (const bad of ["above", "sideways=1", "above=x", "above=-1", ":above=1"]) {
    assert.throws(() => parseAlertSpecs([bad], ["bitcoin"]), /invalid alert spec/);
  }
});

test("no fire on flat line", () => {
  const state = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  assert.deepEqual(evaluateAlerts(state, { bitcoin: { usd: 100 } }), []);
  assert.deepEqual(evaluateAlerts(state, { bitcoin: { usd: 100 } }), []);
});

test("fires on strict cross", () => {
  const state = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  evaluateAlerts(state, { bitcoin: { usd: 99 } });
  const msgs = evaluateAlerts(state, { bitcoin: { usd: 101 } });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /crossed above 100/);
});

test("does not refire without re-arm", () => {
  const state = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  evaluateAlerts(state, { bitcoin: { usd: 99 } });
  evaluateAlerts(state, { bitcoin: { usd: 101 } });
  assert.deepEqual(evaluateAlerts(state, { bitcoin: { usd: 102 } }), []);
});

test("re-arms after hysteresis", () => {
  const state = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]), 1);
  evaluateAlerts(state, { bitcoin: { usd: 99 } });
  evaluateAlerts(state, { bitcoin: { usd: 101 } });
  evaluateAlerts(state, { bitcoin: { usd: 100.5 } });
  assert.equal(state[0].armed, false);
  evaluateAlerts(state, { bitcoin: { usd: 98 } });
  assert.equal(state[0].armed, true);
  const msgs = evaluateAlerts(state, { bitcoin: { usd: 101 } });
  assert.equal(msgs.length, 1);
});

test("routes per coin", () => {
  const state = createAlertState(parseAlertSpecs(["btc:above=100", "eth:above=200"], ["bitcoin", "ethereum"]));
  evaluateAlerts(state, { bitcoin: { usd: 99 }, ethereum: { usd: 199 } });
  const msgs = evaluateAlerts(state, { bitcoin: { usd: 101 }, ethereum: { usd: 199 } });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /bitcoin/);
});

test("evaluates every currency and names the one that crossed", () => {
  const state = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  evaluateAlerts(state, { bitcoin: { usd: 99, eur: 99 } }, ["usd", "eur"]);
  const msgs = evaluateAlerts(state, { bitcoin: { usd: 99, eur: 101 } }, ["usd", "eur"]);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /EUR/);
});

test("hysteresis is tracked per currency", () => {
  const state = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  const cc = ["usd", "eur"];
  evaluateAlerts(state, { bitcoin: { usd: 99, eur: 99 } }, cc);
  evaluateAlerts(state, { bitcoin: { usd: 101, eur: 99 } }, cc);
  // usd fired and disarmed; eur still armed and below — no eur fire on flat
  const msgs = evaluateAlerts(state, { bitcoin: { usd: 102, eur: 99 } }, cc);
  assert.deepEqual(msgs, []);
});

test("per-coin spec for an unrequested coin fails fast", () => {
  assert.throws(() => parseAlertSpecs(["doge:above=1"], ["bitcoin"]), /not in requested coins/);
  // ticker aliases resolve: btc is fine when bitcoin is requested
  const ok = parseAlertSpecs(["btc:above=1"], ["bitcoin"]);
  assert.equal(ok[0].coin, "bitcoin");
});


test("alert state atomic round-trip persist and load", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-alerts-"));
  const file = path.join(dir, "alerts-state.json");
  const state = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  evaluateAlerts(state, { bitcoin: { usd: 90 } });
  evaluateAlerts(state, { bitcoin: { usd: 105 } });
  assert.equal(state[0].armed, false);

  const exported = exportAlertState(state, 1000);
  await saveAlertState(file, exported, 1000);

  const loaded = await loadAlertState(file, 24, 1000);
  assert.deepEqual(loaded, {
    "bitcoin:usd": {
      lastPrice: 105,
      armed: false,
      updatedAt: 1000,
    },
  });

  const freshState = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  restoreAlertState(freshState, loaded);
  assert.equal(freshState[0].armed, false);
  assert.equal(freshState[0].lastPrices.usd, 105);
});

test("alert state TTL expiry treats stale entries as fresh", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-alerts-ttl-"));
  const file = path.join(dir, "alerts-state.json");
  const now = Date.now();
  const past = now - (25 * 3600 * 1000); // 25 hours ago

  await saveAlertState(file, {
    "bitcoin:usd": {
      lastPrice: 90,
      armed: false,
      updatedAt: past,
    },
  }, past);

  // default 24h TTL ignores 25h old entry
  const loaded = await loadAlertState(file, 24, now);
  assert.deepEqual(loaded, {});

  // TTL=0 disables persisted state
  const loadedZero = await loadAlertState(file, 0, past);
  assert.deepEqual(loadedZero, {});

  // larger TTL includes it
  const loadedLonger = await loadAlertState(file, 48, now);
  assert.equal(loadedLonger["bitcoin:usd"]?.lastPrice, 90);
});

test("alert state handles corrupt state file gracefully without crashing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-alerts-corrupt-"));
  const file = path.join(dir, "alerts-state.json");
  await fs.writeFile(file, "not a json string");

  const logged = [];
  const origError = console.error;
  console.error = (msg) => logged.push(msg);
  try {
    const loaded = await loadAlertState(file, 24);
    assert.deepEqual(loaded, {});
    assert.ok(logged.some((m) => m.includes("corrupt alert state")));
  } finally {
    console.error = origError;
  }
});

test("no fire after restart without re-arm when previous state is restored", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-price-alerts-rearm-"));
  const file = path.join(dir, "alerts-state.json");

  // Run 1: cross above 100 and trigger alert
  const state1 = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  evaluateAlerts(state1, { bitcoin: { usd: 90 } });
  const msgs1 = evaluateAlerts(state1, { bitcoin: { usd: 105 } });
  assert.equal(msgs1.length, 1);
  assert.equal(state1[0].armed, false);

  // Save state after tick
  const exported = exportAlertState(state1, 1000);
  await saveAlertState(file, exported, 1000);

  // Run 2: process restarts, loads state
  const state2 = createAlertState(parseAlertSpecs(["above=100"], ["bitcoin"]));
  const loaded = await loadAlertState(file, 24, 2000);
  restoreAlertState(state2, loaded);
  assert.equal(state2[0].armed, false);
  assert.equal(state2[0].lastPrices.usd, 105);

  // Still above 100 without re-arm: must NOT refire
  const msgs2 = evaluateAlerts(state2, { bitcoin: { usd: 106 } });
  assert.deepEqual(msgs2, []);

  // Drops below hysteresis threshold (100 * 0.99 = 99) -> re-arms
  evaluateAlerts(state2, { bitcoin: { usd: 98 } });
  assert.equal(state2[0].armed, true);

  // Crosses above 100 again -> fires
  const msgs3 = evaluateAlerts(state2, { bitcoin: { usd: 102 } });
  assert.equal(msgs3.length, 1);
  assert.match(msgs3[0], /crossed above 100/);
});
