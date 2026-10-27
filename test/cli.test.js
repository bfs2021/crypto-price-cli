import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/crypto-price.js", import.meta.url));
const mockFetchPath = fileURLToPath(new URL("../mock-fetch.cjs", import.meta.url));

function runCli(...args) {
  return spawnSync(
    process.execPath,
    ["--require", mockFetchPath, cliPath, ...args],
    { encoding: "utf8", timeout: 10000 },
  );
}

test("--jsonl emits one compact JSON object for a one-shot request", () => {
  const result = runCli("--jsonl");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"bitcoin":{"usd":42}}\n');
});

test("--jsonl composes with --compact and uses the default coin", () => {
  const result = runCli("--jsonl", "--compact");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"bitcoin":{"usd":42}}\n');
});

test("--jsonl emits one compact JSON object per counted watch tick", () => {
  const result = runCli("bitcoin", "--jsonl", "--watch=1", "--count=2");

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line, JSON.stringify(JSON.parse(line)));
    assert.deepEqual(JSON.parse(line), { bitcoin: { usd: 42 } });
  }
});

test("--help documents --jsonl", () => {
  const result = runCli("--help");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--jsonl\s+One compact JSON object per line/i);
});
