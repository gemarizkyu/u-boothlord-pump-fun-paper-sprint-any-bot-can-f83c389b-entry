# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/gemarizkyu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/gemarizkyu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. The bot paper-trades pump.fun bonding curves on a 6-hour replay; highest net PnL wins. No real money, no entry fee.

## Strategy

- **Entry:** a curve becomes a buy once it is mature (past a minimum age since its CreateEvent, so bundled launches that dump early are skipped) and its recent tape shows accelerating buy pressure: net SOL flowing in over the window, several distinct buyers, a rising price sitting near its window high, and more net inflow in the newer half of the window than in the older half.
- **Sizing:** the first buy is small (0.15 SOL); the position pyramids into strength only, adding while the price is above the last buy and net SOL still flows in, up to 0.6 SOL per coin and 8 SOL of exposure at once.
- **Exits:** a position is sold whole on the first of a stop loss against cost, a trailing stop from its best close value, fading net flow, or a time limit.
- **Guardrail pacing:** tiny probe round trips (0.02 SOL) keep the run above the minimum bar — a round trip of at least 0.01 SOL on each of at least 20 coins — when the momentum entries alone lag the pace.

Deterministic by construction: no clock, no environment, no unseeded randomness, so the two harness executions produce identical action logs.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout via the vendored shim in `vendor/makefun-bot.ts` (the kit's SDK, byte for byte). Grade it locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
