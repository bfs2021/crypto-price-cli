globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => JSON.stringify({ bitcoin: { usd: 42 } }),
});
