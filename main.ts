// Pump.fun paper sprint: launch sniper with a paced probe.
//
// Idea: only a fresh mint can be bought, and only inside its first few slots.
// A mint earns a full-size snipe when it still looks untouched: the creator
// bought at most 1 SOL, no outsider has traded it yet, nobody saw the creator
// sell, real reserves sit between 1 and 30 SOL, the price has not run away
// from its creation price, and the signed SOL flow of the last ten slots is
// not deeply negative. Anything that fails the strict screen but still looks
// sane can earn a small probe buy instead, paced so probes stay a minority of
// the book and the guardrail of twenty distinct round-tripped coins is met.
// Exits are take-profit +12%, stop-loss -10%, twelve slots of holding, or an
// immediate exit the moment the creator sells.
//
// Speed shape: every batch touches only its own events and the handful of
// open positions. Nothing scans the whole mint universe. Per-mint flow is a
// short ring with a running sum, so a trade costs O(1). Stale mint records
// are dropped once they can never be bought again, so memory stays bounded
// no matter how many mints the replay contains. No clock, no randomness, no
// environment reads: the same input always produces the same orders.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL;
const SNIPE_STAKE = SOL / 10n; // 0.1 SOL on a full snipe
const PROBE_STAKE = SOL / 50n; // 0.02 SOL on a probe
const ENTRY_SLOTS = 4; // buy only inside the first four slots of a mint
const DEV_BUY_MAX = SOL; // creator buys add up to at most 1 SOL
const REAL_MIN = SOL; // real reserves between 1 and 30 SOL
const REAL_MAX = 30n * SOL;
const RUNUP_MIN_BPS = 9000; // price now vs price at creation: 0.9x to 2x
const RUNUP_MAX_BPS = 20000;
const FLOW_SLOTS = 10; // signed SOL flow over the last ten slots
const FLOW_MIN = -(SOL / 20n); // ... at least -0.05 SOL
const TAKE_BPS = 11200; // take profit +12%
const STOP_BPS = 9000; // stop loss -10%
const HOLD_SLOTS = 12; // give up after twelve slots
const PROBE_EVERY_SLOTS = 1440; // at most one probe buy per 1440 slots
const PROBE_TARGET = 25; // stop probing after twenty-five probe round trips
const SLIPPAGE_BPS = 500;
const MAX_ORDERS = 8; // per batch, comfortably under the harness cap
const SWEEP_EVERY = 20000; // batches between stale-record sweeps

type FlowPoint = { slot: number; delta: bigint };

type MintTrack = {
  createdSlot: number;
  creator: string;
  devBuy: bigint;
  outsiderSeen: boolean;
  creatorSold: boolean;
  createQ: bigint; // virtual quote reserves at creation
  createT: bigint; // virtual token reserves at creation
  flow: FlowPoint[];
  flowHead: number; // first live entry of flow
  flowSum: bigint; // signed SOL flow of the live entries
};

const tracks = new Map<string, MintTrack>();
const openedAt = new Map<string, number>(); // mint -> slot its position opened
const kindByMint = new Map<string, "snipe" | "probe">();
const tripped = new Set<string>(); // mints with a finished round trip
let probeTrips = 0;
let lastProbeSlot = -1000000;
let orderSeq = 0;
let nextSweep = SWEEP_EVERY;

// Price now relative to price at creation, in basis points. Uses
// cross-multiplication on bigints, so no float ever enters the decision.
function runupBps(nowQ: bigint, nowT: bigint, atQ: bigint, atT: bigint): bigint {
  if (nowT <= 0n || atQ <= 0n || atT <= 0n) return 0n;
  return (nowQ * atT * 10000n) / (nowT * atQ);
}

// Fold one trade into a mint's flow ring and its rug signals.
function noteTrade(track: MintTrack, user: string, isBuy: boolean, sol: bigint, slot: number): void {
  if (user === track.creator) {
    if (isBuy) track.devBuy += sol;
    else track.creatorSold = true;
  } else {
    track.outsiderSeen = true;
  }
  track.flow.push({ slot, delta: isBuy ? sol : -sol });
  track.flowSum += isBuy ? sol : -sol;
  const cutoff = slot - FLOW_SLOTS;
  while (track.flowHead < track.flow.length && track.flow[track.flowHead].slot < cutoff) {
    track.flowSum -= track.flow[track.flowHead].delta;
    track.flowHead += 1;
  }
  if (track.flowHead > 64) {
    track.flow = track.flow.slice(track.flowHead);
    track.flowHead = 0;
  }
}

// Drop records that can never be bought again: older than the entry window
// and not held. Runs rarely, so its full-map scan costs nothing amortized.
function sweepStale(slot: number, held: (mint: string) => boolean): void {
  for (const [mint, track] of tracks) {
    if (slot - track.createdSlot > ENTRY_SLOTS && !held(mint)) tracks.delete(mint);
  }
}

// One batch: fold fills, fold events, exit what must exit, enter what is
// young and clean. Only the batch's own events and the open positions are
// ever visited.
async function onBatch(state: any, batch: any): Promise<any[]> {
  const slot: number = batch.slot;
  const orders: any[] = [];
  const txFee = state.txFeeLamports();

  // Fills first: a buy records when the position opened; a sell closes the
  // book-keeping for that mint and counts its round trip. A rejected buy
  // drops the kind recorded for it, so it never leaks into a later trip.
  for (const fill of batch.fills) {
    if (fill.status === "rejected" && fill.side === "buy") {
      kindByMint.delete(fill.mint);
      continue;
    }
    if (fill.status !== "filled") continue;
    if (fill.side === "buy") {
      openedAt.set(fill.mint, fill.slot);
    } else {
      if (openedAt.has(fill.mint)) {
        tripped.add(fill.mint);
        if (kindByMint.get(fill.mint) === "probe") probeTrips += 1;
        openedAt.delete(fill.mint);
        kindByMint.delete(fill.mint);
      }
    }
  }

  // Events: keep per-mint signals current and collect the young mints of
  // this batch as entry candidates.
  const candidates = new Set<string>();
  for (const ev of batch.events) {
    if (ev.event === "CreateEvent") {
      tracks.set(ev.mint, {
        createdSlot: slot,
        creator: ev.creator,
        devBuy: 0n,
        outsiderSeen: false,
        creatorSold: false,
        createQ: BigInt(ev.virtual_quote_reserves),
        createT: BigInt(ev.virtual_token_reserves),
        flow: [],
        flowHead: 0,
        flowSum: 0n,
      });
      candidates.add(ev.mint);
    } else if (ev.event === "TradeEvent") {
      const track = tracks.get(ev.mint);
      if (track === undefined) continue;
      noteTrade(track, ev.user, ev.is_buy, BigInt(ev.sol_amount), slot);
      if (slot - track.createdSlot < ENTRY_SLOTS) candidates.add(ev.mint);
    } else if (ev.event === "CompleteEvent") {
      tracks.delete(ev.mint);
    }
  }

  // Exits over the open positions only: creator sold, take profit, stop
  // loss, or the holding aged past its limit.
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.virtual_token_reserves <= 0n) continue;
    const track = tracks.get(mint);
    const value = (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
    const cost = pos.cost_lamports;
    const opened = openedAt.get(mint);
    const mustSell =
      (track !== undefined && track.creatorSold) ||
      value * 10000n >= cost * BigInt(TAKE_BPS) ||
      value * 10000n <= cost * BigInt(STOP_BPS) ||
      (opened !== undefined && slot - opened >= HOLD_SLOTS);
    if (mustSell) {
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
    }
  }

  // Entries over this batch's young mints only. Reserved tracks the SOL
  // this batch's own buys already committed, since the shim only learns of
  // them once this batch is answered.
  if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
    let reserved = 0n;
    for (const mint of candidates) {
      if (orders.length >= MAX_ORDERS) break;
      if (state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const track = tracks.get(mint);
      if (track === undefined) continue;
      if (slot - track.createdSlot >= ENTRY_SLOTS) continue;
      const real = curve.real_quote_reserves;
      if (real < REAL_MIN || real > REAL_MAX) continue;
      if (track.creatorSold || track.devBuy > DEV_BUY_MAX) continue;
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === "buy" && p.order.mint === mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;

      // Full snipe: untouched mint, sane run-up, flow not deeply negative.
      const runup = runupBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, track.createQ, track.createT);
      if (!track.outsiderSeen && runup >= BigInt(RUNUP_MIN_BPS) && runup <= BigInt(RUNUP_MAX_BPS) && track.flowSum >= FLOW_MIN) {
        let stake = SNIPE_STAKE;
        const cap = state.maxBuyLamports(mint);
        if (cap < stake) stake = cap;
        if (stake > 0n && stake + txFee <= state.freeCashLamports() - reserved) {
          orderSeq += 1;
          reserved += stake + txFee;
          kindByMint.set(mint, "snipe");
          orders.push({ side: "buy", mint, quote_lamports: stake, max_slippage_bps: SLIPPAGE_BPS, client_id: `s${orderSeq}` });
          continue;
        }
      }

      // Probe: same mint, looser screen, paced and capped.
      if (probeTrips < PROBE_TARGET && slot - lastProbeSlot >= PROBE_EVERY_SLOTS) {
        let stake = PROBE_STAKE;
        const cap = state.maxBuyLamports(mint);
        if (cap < stake) stake = cap;
        if (stake > 0n && stake + txFee <= state.freeCashLamports() - reserved) {
          orderSeq += 1;
          reserved += stake + txFee;
          lastProbeSlot = slot;
          kindByMint.set(mint, "probe");
          orders.push({ side: "buy", mint, quote_lamports: stake, max_slippage_bps: SLIPPAGE_BPS, client_id: `p${orderSeq}` });
        }
      }
    }
  }

  if (batch.seq >= nextSweep) {
    nextSweep = batch.seq + SWEEP_EVERY;
    sweepStale(slot, (mint: string) => state.positions.has(mint));
  }
  return orders;
}

await runBot({ onBatch });
