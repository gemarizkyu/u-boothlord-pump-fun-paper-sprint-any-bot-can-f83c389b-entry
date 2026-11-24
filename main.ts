// pump-sprint: a launch sniper for the agent-fun/replay/v2 harness
// (make.fun "Pump.fun Paper Sprint: Any Bot Can Win").
//
// Every coin is watched from its CreateEvent. The bot buys only in a coin's
// first few slots, and only launches that pass a rug filter: a small creator
// buy, few distinct non-creator buyers piling in at birth (a launch bundled
// by many wallets is usually the creator's cluster waiting to dump), no
// creator sale yet, no big early sell, and the price still near its create
// price. It takes profit fast, cuts losers fast, never holds past a short
// time limit, and leaves at once when the creator sells.
//
// Chasing momentum after a run-up loses on this data: by the time a rise
// shows in the tape the dump has usually started, and holding while a curve
// bleeds eats the stake in fees and drawdown. Buying at birth with a hard
// exit is the shape that survives the replay: small stakes, many coins, no
// position left to bleed. Tiny probe round trips keep the run above the
// guardrail pace (a round trip of at least 0.01 SOL on each of at least 20
// coins) when the sniper entries alone lag it.
//
// Deterministic by construction: no clock, no environment, no Math.random;
// iteration only over insertion-ordered maps fed by the batch stream.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (and the guardrail's round-trip floor). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this many SOL. */
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, at most (as a ratio). */
  maxSellRatio: number;
  /** Price now over the create price: window. */
  minRunup: number;
  maxRunup: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost (fraction). */
  tp: number;
  /** Exit when it is worth this much under its cost (fraction). */
  sl: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Guardrail pacing: target fills / coins over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of one probe round trip (SOL). */
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 4,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 1,
  maxRealSol: 30,
  maxDevBuy: 2.5,
  maxBuyers: 4,
  maxSellRatio: 1,
  minRunup: 0.9,
  maxRunup: 2,
  flowWindow: 10,
  minFlowSol: -0.05,
  skipDevSold: true,
  buySlipBps: 10_000,
  tp: 0.12,
  sl: 0.1,
  maxHold: 12,
  exitOnDevSell: true,
  targetCoins: 25,
  targetFills: 100,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 8,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: number;
  vt0: number;
  devBuy: number;
  trades: number;
  buyers: Set<Pubkey>;
  bought: number;
  soldByOthers: number;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  /** Close value of `tokens` on a curve at its latest reserves, fees deducted. */
  const closeValue = (tokens: number, vq: number, vt: number, tx: number): number =>
    ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;

  /** Net recorded SOL (buys minus sells) over the last flowWindow slots. */
  const flow = (c: Coin, now: number): number => {
    const from = now - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0;
    for (const t of c.recent) net += t.buy ? t.sol : -t.sol;
    return net;
  };

  /** The rug filter: is this newborn coin worth a first buy at slot `now`? */
  const entryOk = (c: Coin, now: number, curve: { real_quote_reserves: bigint; virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): boolean => {
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (c.devBuy > p.maxDevBuy) return false;
    if (c.buyers.size > p.maxBuyers) return false;
    if (c.devSold && p.skipDevSold) return false;
    if (c.bought > 0 && c.soldByOthers > c.bought * p.maxSellRatio) return false;
    const runup = (Number(curve.virtual_quote_reserves) * c.vt0) / (Number(curve.virtual_token_reserves) * c.vq0);
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    if (flow(c, now) < p.minFlowSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            vq0: Number(e.virtual_quote_reserves),
            vt0: Number(e.virtual_token_reserves),
            devBuy: 0,
            trades: 0,
            buyers: new Set(),
            bought: 0,
            soldByOthers: 0,
            devSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades++;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createdSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const pendingSell = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') return true;
        }
        return false;
      };

      // Exits first: take profit, cut losers, time limit, creator sold.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (pendingSell(mint)) continue;
        const c = coins.get(mint);
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: now, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = closeValue(Number(pos.token_amount), vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = false;
        if (cost > 0 && value >= cost * (1 + p.tp)) exit = true;
        if (cost > 0 && value <= cost * (1 - p.sl)) exit = true;
        if (now - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (c !== undefined) c.done = true;
        held.delete(mint);
      }
      // Drop held records whose position is gone and no order is pending.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !pendingByMint.has(mint)) held.delete(mint);
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: newborn coins only, inside the entry window, passing the filter.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const pos of state.positions.values()) exposure += Number(pos.cost_lamports) / LAMPORTS;
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = now - c.createdSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (slotsLeft <= 0) break;
        if (held.has(c.mint) || probes.has(c.mint) || pendingByMint.has(c.mint) || state.positions.has(c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (!entryOk(c, now, curve)) {
          // A failed filter at birth is final: the launch window is too short
          // to wait for it to improve.
          if (c.devSold || c.buyers.size > p.maxBuyers) c.done = true;
          continue;
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(c.mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        held.set(c.mint, { openedSlot: now, devSoldAtOpen: c.devSold });
        free -= amount + tx;
        exposure += amount;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the
      // pace, so the run ends with a round trip on at least 20 coins.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const e of batch.events) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (e.event !== 'TradeEvent') continue;
            const mint = e.mint;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

await runBot(createStrategy(DEFAULT_PARAMS));
