# Interactive Brokers for Gloomberb

Account and position sync for [Gloomberb](https://github.com/gloom-sh/gloomberb) over the IBKR Flex Web Service.

Requires Gloomberb 0.14.0 or later.

```bash
gloomberb install gloom-sh/gloom-ibkr
```

Then add an Interactive Brokers profile from the Brokers pane and paste a Flex token and query id.

## Flex and Gateway

Interactive Brokers is one broker with two connection modes, and they have very different requirements:

| | Transport | Runs on |
|---|---|---|
| **Flex** (this plugin) | HTTPS to a hosted statement service | anywhere |
| **[Gateway](https://github.com/gloom-sh/gloom-ibkr-gateway)** | raw TCP to a local TWS process | terminal and desktop only |

This plugin owns the broker id and the whole profile schema, including the Gateway fields, so you have a single "Interactive Brokers" profile either way and your stored credentials work with both.

Install `gloom-ibkr-gateway` to use a Gateway or TWS profile, live market data, or the trading console. Without it, a Gateway-mode profile says so instead of failing quietly.

## Bond positions

For `assetCategory="BOND"`, the Flex adapter declares `priceBasis: "percent-of-par"`. It preserves nominal quantity, raw cost and mark prices, source monetary value/P&L, currency and contract multiplier. The host computes nominal × price ÷ 100 and displays face quantity and percentage-of-par prices; it does not apply the multiplier again. Bond ETFs remain ordinary ETF shares. Resync older stored BOND positions to obtain this declaration.

This accepted adapter contract is supported by IBKR's [public October 2021 activity sample](https://www.ibkrguides.com/reportingreference/reportguide/daily_concatenated_sample.html): a Treasury position has 1,000 nominal, cost price 87.7420 and cost basis 877.42, with security multiplier 1. The [reporting integration reference](https://www.interactivebrokers.com/campus/ibkr-reporting/reporting-integration/) specifies the bond-price division by 100. The exact Flex XML aliases are the existing accepted parser mappings; an upstream raw XML specimen has not been verified. Accrued interest, coupon, dirty-price adjustments and investment yields are not inferred. This declaration does not establish an independent live quote or historical series convention.

## Portfolio history

The adapter accepts `cumulativeReturn`, `timeWeightedReturnCumulative`, and `twrCumulative` as cumulative returns in percentage points: `0.5` means 0.5%, `1` means 1%, and `150` means 150%. It converts these values to the host's decimal-fraction representation. This defines the accepted adapter contract; an exact upstream XML mapping for these aliases has not been verified.

IBKR's [Change in NAV reference](https://www.ibkrguides.com/reportingreference/reportguide/changeinnav_fq.htm) describes TWR as a percentage for the statement period. Its [cumulative performance reference](https://www.ibkrguides.com/reportingreference/reportguide/cumulativeperformancestatistics.htm) distinguishes cumulative TWR from MWR calculated over the entire report period. Consequently, period `twr` and `mwr` fields are not used as cumulative-return fallbacks. The adapter does not compound them or infer investment returns from NAV changes, deposits, withdrawals, or dividends. Independently supplied NAV remains usable when a cumulative return is unavailable. Cached performance from the previous interpretation is invalidated and must be refreshed.

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
