/**
 * 최소 TP% 필터 A/B 백테스트
 * 현행 0.5% vs 1.0% vs 1.5% vs 2.0%
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005;

const BASE = {
  impulseMinPct: 2, impulseLookback: 6, volumeAvgWindow: 20,
  obMaxAge: 24, slPct: 0.8, tpMode: 'swing',
  maxHoldCandles: 60, cooldownCandles: 6,
  initialCapital: 100000, maxPositions: 2, minOrderAmount: 5000,
};

function detectOB(data) {
  const obs = [];
  for (let i = BASE.volumeAvgWindow; i < data.length - BASE.impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue;
    let maxHigh = 0;
    for (let j = i + 1; j <= i + BASE.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHigh) maxHigh = data[j].high;
    }
    const imp = (maxHigh - c.close) / c.close * 100;
    if (imp < BASE.impulseMinPct) continue;
    obs.push({ index: i, top: c.open, bottom: c.close, swingHigh: maxHigh, used: false });
  }
  return obs;
}

function runTest(allData, minTpPct) {
  const timeline = {};
  for (const { coin, data } of allData) {
    const obs = detectOB(data).map(o => ({ ...o, used: false }));
    const cooldowns = {};
    for (let i = 20; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];
      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > BASE.obMaxAge || ob.used) continue;
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;
        const entry = Math.max(candle.close, ob.bottom);
        const sl = ob.bottom * (1 - BASE.slPct / 100);
        const tp = ob.swingHigh;
        if ((tp - entry) / entry * 100 < minTpPct) continue;
        let exitP = null, exitR = null, exitI = null;
        for (let j = i + 1; j < Math.min(i + BASE.maxHoldCandles, data.length); j++) {
          if (data[j].low <= sl) { exitP = sl; exitR = 'SL'; exitI = j; break; }
          if (data[j].high >= tp) { exitP = tp; exitR = 'TP'; exitI = j; break; }
        }
        if (!exitP) { exitI = Math.min(i + BASE.maxHoldCandles, data.length - 1); exitP = data[exitI].close; exitR = 'TIMEOUT'; }
        const key = candle.time;
        if (!timeline[key]) timeline[key] = [];
        timeline[key].push({ coin, entryIndex: i, exitIndex: exitI, entryTime: candle.time, exitTime: data[exitI].time, entryPrice: entry, exitPrice: exitP, reason: exitR, holdMinutes: (exitI - i) * 5 });
        ob.used = true;
        cooldowns[coin] = exitI + BASE.cooldownCandles;
        break;
      }
    }
  }

  let cash = BASE.initialCapital;
  const trades = [], events = [];
  for (const time of Object.keys(timeline).sort()) {
    for (const sig of timeline[time]) {
      events.push({ type: 'ENTRY', time: sig.entryTime, signal: sig });
      events.push({ type: 'EXIT', time: sig.exitTime, signal: sig });
    }
  }
  events.sort((a, b) => a.time !== b.time ? a.time.localeCompare(b.time) : a.type === 'EXIT' ? -1 : 1);
  const active = new Map();
  for (const ev of events) {
    const s = ev.signal, key = `${s.coin}_${s.entryTime}`;
    if (ev.type === 'EXIT') {
      const pos = active.get(key); if (!pos) continue;
      const net = (s.exitPrice - s.entryPrice) / s.entryPrice - COMMISSION * 2;
      const pnl = pos.amount * net;
      cash += pos.amount + pnl; active.delete(key);
      trades.push({ coin: s.coin, pnl: Math.round(pnl), netPct: +(net * 100).toFixed(3), reason: s.reason, holdMinutes: s.holdMinutes });
    }
    if (ev.type === 'ENTRY') {
      if ([...active.values()].some(p => p.coin === s.coin)) continue;
      if (active.size >= BASE.maxPositions) continue;
      const alloc = Math.floor(cash / (BASE.maxPositions - active.size));
      if (alloc < BASE.minOrderAmount) continue;
      cash -= alloc; active.set(key, { coin: s.coin, amount: alloc });
    }
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgEv = trades.length > 0 ? trades.reduce((s, t) => s + t.netPct, 0) / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const tp = trades.filter(t => t.reason === 'TP').length;
  const sl = trades.filter(t => t.reason === 'SL').length;
  const to = trades.filter(t => t.reason === 'TIMEOUT').length;
  const final = totalPnl + BASE.initialCapital;
  const ret = (final / BASE.initialCapital - 1) * 100;

  let peak = BASE.initialCapital, mdd = 0, run = BASE.initialCapital;
  for (const t of trades) { run += t.pnl; if (run > peak) peak = run; const dd = (peak - run) / peak * 100; if (dd > mdd) mdd = dd; }

  return { minTpPct, total: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
    tp, sl, to, totalPnl, ret: +ret.toFixed(1), avgEv: +avgEv.toFixed(3),
    avgWin: +avgWin.toFixed(3), avgLoss: +avgLoss.toFixed(3), mdd: +mdd.toFixed(2), final };
}

function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !['BTC.json', 'ETH.json', 'USDT.json'].includes(f));
  const allData = files.map(f => {
    const coin = f.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    const data = raw.map(c => ({ time: c.time || c.candle_date_time_kst, open: c.open || c.opening_price, high: c.high || c.high_price, low: c.low || c.low_price, close: c.close || c.trade_price, volume: c.volume || c.candle_acc_trade_volume })).sort((a, b) => a.time.localeCompare(b.time));
    return data.length >= 100 ? { coin, data } : null;
  }).filter(Boolean);

  console.log(`\n${'═'.repeat(80)}`);
  console.log('  최소 TP% 필터 비교 백테스트');
  console.log(`${'═'.repeat(80)}`);

  const scenarios = [0.5, 0.8, 1.0, 1.2, 1.5, 2.0];
  const results = scenarios.map(tp => runTest(allData, tp));

  console.log(`\n  ${'최소TP'.padEnd(10)} ${'거래수'.padStart(6)} ${'승률'.padStart(7)} ${'TP/SL/TO'.padStart(12)} ${'총수익'.padStart(12)} ${'수익률'.padStart(8)} ${'EV/건'.padStart(8)} ${'평균승'.padStart(8)} ${'평균패'.padStart(8)} ${'MDD'.padStart(8)}`);
  console.log(`  ${'─'.repeat(76)}`);

  for (const r of results) {
    console.log(`  ${(r.minTpPct + '%').padEnd(10)} ${String(r.total).padStart(6)} ${(r.winRate + '%').padStart(7)} ${(r.tp + '/' + r.sl + '/' + r.to).padStart(12)} ${((r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString()).padStart(12)} ${((r.ret > 0 ? '+' : '') + r.ret + '%').padStart(8)} ${((r.avgEv > 0 ? '+' : '') + r.avgEv + '%').padStart(8)} ${('+' + r.avgWin + '%').padStart(8)} ${(r.avgLoss + '%').padStart(8)} ${('-' + r.mdd + '%').padStart(8)}`);
  }

  const best = results.reduce((a, b) => a.avgEv > b.avgEv ? a : b);
  console.log(`\n  ✅ 최적: 최소TP ${best.minTpPct}% (EV +${best.avgEv}%/건, 승률 ${best.winRate}%, 총수익 ${best.totalPnl > 0 ? '+' : ''}${best.totalPnl.toLocaleString()}원)`);
  console.log(`${'═'.repeat(80)}\n`);
}

main();
