# Interactive Brokers for Gloomberb

Account and position sync for [Gloomberb](https://github.com/gloom-sh/gloomberb) over the IBKR Flex Web Service.

This branch uses the shared pane UI in [Gloomberb #743](https://github.com/gloom-sh/gloomberb/pull/743), targeting Gloomberb 0.14.0. That release is pending; released 0.13.3 is not supported.

```bash
gloomberb install gloom-sh/gloomberb-ibkr
```

Then add an Interactive Brokers profile from the Brokers pane and paste a Flex token and query id.

## Flex and Gateway

Interactive Brokers is one broker with two connection modes, and they have very different requirements:

| | Transport | Runs on |
|---|---|---|
| **Flex** (this plugin) | HTTPS to a hosted statement service | anywhere |
| **[Gateway](https://github.com/gloom-sh/gloomberb-ibkr-gateway)** | raw TCP to a local TWS process | terminal and desktop only |

This plugin owns the broker id and the whole profile schema, including the Gateway fields, so you have a single "Interactive Brokers" profile either way and your stored credentials work with both.

Install `gloomberb-ibkr-gateway` to use a Gateway or TWS profile, live market data, or the trading console. Without it, a Gateway-mode profile says so instead of failing quietly.

## Development

`gloomberb` and `react` are peer dependencies, never real ones — Gloomberb links its own copies into every plugin directory so there is exactly one instance of each in the process.

```bash
bun install
git clone --depth 1 https://github.com/gloom-sh/gloomberb.git /tmp/gloomberb
bun install --cwd /tmp/gloomberb
ln -sfn /tmp/gloomberb node_modules/gloomberb
ln -sfn /tmp/gloomberb/node_modules/react node_modules/react
bun run typecheck && bun test
```

## License

MIT
