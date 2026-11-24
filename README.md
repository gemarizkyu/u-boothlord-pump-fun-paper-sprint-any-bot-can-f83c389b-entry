# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/gemarizkyu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/gemarizkyu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A launch-sniper paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. The bot paper-trades pump.fun bonding curves on a 6-hour replay; highest net PnL wins. No real money, no entry fee.

## Strategy

- **Entry:** every coin is watched from its CreateEvent. The bot buys only in a coin's first few slots, and only launches that pass a rug filter: a small creator buy, few distinct non-creator buyers piling in at birth (a launch bundled by many wallets is usually the creator's cluster waiting to dump), no creator sale yet, no big early sell, and the price still near its create price.
- **Exits:** take profit fast, cut losers fast, never hold past a short time limit, and leave at once when the creator sells.
- **Why this shape:** chasing momentum after a run-up loses on the replay — by the time a rise shows in the tape the dump has usually started, and holding while a curve bleeds eats the stake in fees and drawdown. Buying at birth with a hard exit keeps stakes small, coins many, and no position left to bleed.
- **Guardrail pacing:** tiny probe round trips (0.02 SOL) keep the run above the minimum bar — a round trip of at least 0.01 SOL on each of at least 20 coins — when the sniper entries alone lag the pace.

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
