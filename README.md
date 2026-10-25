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

## Development

```bash
npm test
npm run lint
```

## License

MIT