import test from "node:test";
import assert from "node:assert/strict";
import { parseAlertSpecs, createAlertState, evaluateAlerts } from "../src/alerts.js";

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
