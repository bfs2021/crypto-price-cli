import test from "node:test";
import assert from "node:assert/strict";
import { parseAlertSpecs, createAlertState, evaluateAlerts } from "../src/alerts.js";

test("parses plain and per-coin specs", () => {
  const alerts = parseAlertSpecs(["above=100", "btc:below=50"], ["bitcoin", "ethereum"]);
  assert.deepEqual(alerts, [
    { coin: "bitcoin", direction: "above", threshold: 100 },
    { coin: "ethereum", direction: "above", threshold: 100 },
    { coin: "btc", direction: "below", threshold: 50 },
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
  const state = createAlertState(parseAlertSpecs(["btc:above=100", "eth:above=200"], ["bitcoin"]));
  evaluateAlerts(state, { btc: { usd: 99 }, eth: { usd: 199 } });
  const msgs = evaluateAlerts(state, { btc: { usd: 101 }, eth: { usd: 199 } });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /btc/);
});
