# selectarank-mcp

MCP server (stdio) for the [SelectaRank Data Gateway](https://selectarank-data.vercel.app), a pay-per-call API that uses the [x402](https://x402.org) protocol with USDC on Base. It lets an AI agent discover the gateway's paid endpoints as MCP tools and, if you give it a wallet key, pay for them automatically.

MCP Registry name: `io.github.selectarank/selectarank-mcp`

## Tools

Tools are generated from the gateway's `/openapi.json` at startup (a built-in copy of the list is used if it cannot be fetched).

| Tool | Endpoint | Price per call (USDC) | Data source |
|---|---|---|---|
| `selectarank_earthquakes` | `GET /v1/earthquakes/{feed}` | 0.002 | USGS |
| `selectarank_weather` | `GET /v1/weather/{lat}/{lon}` (US only) | 0.003 | NOAA/NWS |
| `selectarank_worldbank` | `GET /v1/worldbank/{country}/{indicator}` | 0.002 | World Bank |
| `selectarank_preflight` | `GET /v1/preflight?url=` | 0.010 | Checks another x402 endpoint's 402 challenge (one unauthenticated GET, no funds move) |

The earthquake, weather and World Bank tools return public-domain upstream data wrapped with source and license metadata. The gateway is a passthrough; it does not produce its own data.

## Payment

- Network: Base mainnet (`eip155:8453`), scheme `exact`
- Asset: USDC, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Recipient (payTo): `0x57a0c0b413516BbF3Fcdb88408D59B7809e3efd0`

Always verify these against the live 402 response; the server returns the gateway's actual PaymentRequirements.

## Install

Requires Node.js 18+.

```json
{
  "mcpServers": {
    "selectarank": {
      "command": "npx",
      "args": ["-y", "@selectarank/selectarank-mcp"],
      "env": { "EVM_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Omit `env` to run without paying (see below).

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `EVM_PRIVATE_KEY` | no | Private key of a wallet holding USDC on Base. With it, tool calls pay automatically via `@x402/fetch`. Use a dedicated low-balance wallet. Never committed or logged by this package. |
| `SELECTARANK_MAX_PRICE_USDC` | no | Refuse to auto-pay above this amount per call. Default `0.05`. |
| `SELECTARANK_BASE_URL` | no | Override the gateway URL. Default `https://selectarank-data.vercel.app`. |

## Behavior without a key

Without `EVM_PRIVATE_KEY` the server still starts and lists all tools. Calling a tool makes one unpaid request and returns the 402 PaymentRequirements (amount, asset, payTo, network) plus instructions for paying. Nothing is spent.

## Status and limits

- Sales to date: 0. This is a new service.
- The data comes from USGS, NOAA/NWS and the World Bank; freshness and accuracy are theirs. No SLA.
- You are responsible for the funds in the wallet you configure.

## Development

```
npm install
npm run build
npm run typecheck
```

## License

MIT
