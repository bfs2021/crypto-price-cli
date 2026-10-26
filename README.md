# crypto-price-cli

Lightweight CLI to fetch cryptocurrency prices from CoinGecko (no API key).

## Usage

```bash
npx @yunaremaia/crypto-price-cli bitcoin,ethereum usd,eur
# or after install
crypto-price bitcoin usd
```

Tickers work as aliases (`btc`, `eth`, `sol`, `doge`, `xrp`, `ada`, `ltc`, `bnb`, `dot`, `matic`).

```bash
# Historical price (YYYY-MM-DD), single or multiple coins
crypto-price bitcoin usd --date=2024-01-15
crypto-price btc,eth usd --date=2024-01-15
# Machine-readable output
crypto-price bitcoin usd --json
```

### Watching with `--watch`

A refresh that fails (DNS blip, CoinGecko 502, sleep/wake) is reported on stderr as
`[watch] tick N failed: <message>` and the loop keeps running on the normal interval, so one
bad tick does not end hours of watching. Use `--max-errors=N` to give up after N consecutive
failed refreshes. The exit code is `1` when the last refresh failed and `0` otherwise, so a
cron wrapper can tell a dead feed from a live one.

## Development

```bash
npm test
npm run lint
```

## License

MIT
