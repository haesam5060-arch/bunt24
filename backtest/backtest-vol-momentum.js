/**
 * 거래량 활성도 필터 백테스트
 *
 * 기준: 매수 시점 최근 N봉 평균 거래량 vs 전체 20봉 평균 거래량
 * "최근 거래량이 평균 대비 활발한가?" 를 판단
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005;

const BASE = {
  impulseMinPct: 2, impulseLookback: 6, volumeAvgWindow: 20,
  obMaxAge: 24, slPct: 0.8, maxHoldCandles: 60, cooldownCandles: 6,
  initialCapital: 100000, maxPositions: 2, minOrderAmount: 5000, minTpPct: 0.8,
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

function calcAvgVol(data, idx, window) {
  if (idx < window) return 0;
  let sum = 0;
  for (let j = idx - window; j < idx; j++) sum += data[j].volume;
  return sum / window;
}

function runTest(allData, recentWindow, minRatio) {
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
        if ((tp - entry) / entry * 100 < BASE.minTpPct) continue;

        // 거래량 활성도 필터
        if (minRatio > 0) {
          const recentAvgVol = calcAvgVol(data, i, recentWindow);
          const longAvgVol = calcAvgVol(data, i, 20);
          if (longAvgVol > 0 && recentAvgVol < longAvgVol * minRatio) continue;
        }

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
      cash += pos.amount + pos.amount * net; active.delete(key);
      trades.push({ pnl: Math.round(pos.amount * net), netPct: +(net * 100).toFixed(3), reason: s.reason, holdMinutes: s.holdMinutes });
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
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0;

  return { recentWindow, minRatio, total: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
    tp, sl, to, totalPnl, ret: +ret.toFixed(1), avgEv: +avgEv.toFixed(3),
    avgWin: +avgWin.toFixed(3), avgLoss: +avgLoss.toFixed(3), mdd: +mdd.toFixed(2), avgHold: +avgHold.toFixed(0) };
}

function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !['BTC.json', 'ETH.json', 'USDT.json'].includes(f));
  const allData = files.map(f => {
    const coin = f.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    const data = raw.map(c => ({ time: c.time || c.candle_date_time_kst, open: c.open || c.opening_price, high: c.high || c.high_price, low: c.low || c.low_price, close: c.close || c.trade_price, volume: c.volume || c.candle_acc_trade_volume })).sort((a, b) => a.time.localeCompare(b.time));
    return data.length >= 100 ? { coin, data } : null;
  }).filter(Boolean);

  console.log(`\n${'═'.repeat(85)}`);
  console.log('  거래량 활성도 필터 백테스트 — 최근 N봉 평균 vs 20봉 평균');
  console.log(`${'═'.repeat(85)}`);

  // 테스트 시나리오: (최근 N봉, 최소 비율)
  const scenarios = [
    { label: '필터 없음 (현행)', window: 0, ratio: 0 },
    { label: '최근3봉 ≥ 0.5x 평균', window: 3, ratio: 0.5 },
    { label: '최근3봉 ≥ 0.8x 평균', window: 3, ratio: 0.8 },
    { label: '최근3봉 ≥ 1.0x 평균', window: 3, ratio: 1.0 },
    { label: '최근3봉 ≥ 1.5x 평균', window: 3, ratio: 1.5 },
    { label: '최근5봉 ≥ 0.5x 평균', window: 5, ratio: 0.5 },
    { label: '최근5봉 ≥ 0.8x 평균', window: 5, ratio: 0.8 },
    { label: '최근5봉 ≥ 1.0x 평균', window: 5, ratio: 1.0 },
    { label: '최근5봉 ≥ 1.5x 평균', window: 5, ratio: 1.5 },
  ];

  const results = scenarios.map(s => {
    const r = runTest(allData, s.window, s.ratio);
    r.label = s.label;
    return r;
  });

  console.log(`\n  ${'시나리오'.padEnd(24)} ${'거래'.padStart(5)} ${'승률'.padStart(7)} ${'TP/SL/TO'.padStart(11)} ${'총수익'.padStart(12)} ${'수익률'.padStart(8)} ${'EV/건'.padStart(8)} ${'평균승'.padStart(8)} ${'평균패'.padStart(8)} ${'MDD'.padStart(8)} ${'보유'.padStart(6)}`);
  console.log(`  ${'─'.repeat(81)}`);

  for (const r of results) {
    const marker = r.avgEv === Math.max(...results.map(x => x.avgEv)) ? ' ⭐' : '';
    console.log(`  ${r.label.padEnd(24)} ${String(r.total).padStart(5)} ${(r.winRate + '%').padStart(7)} ${(r.tp + '/' + r.sl + '/' + r.to).padStart(11)} ${((r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString()).padStart(12)} ${((r.ret > 0 ? '+' : '') + r.ret + '%').padStart(8)} ${((r.avgEv > 0 ? '+' : '') + r.avgEv + '%').padStart(8)} ${('+' + r.avgWin + '%').padStart(8)} ${(r.avgLoss + '%').padStart(8)} ${('-' + r.mdd + '%').padStart(8)} ${(r.avgHold + '분').padStart(6)}${marker}`);
  }

  const best = results.reduce((a, b) => a.avgEv > b.avgEv ? a : b);
  const baseline = results[0];
  console.log(`\n  ✅ 최적: ${best.label}`);
  console.log(`     EV ${best.avgEv}%/건 (현행 ${baseline.avgEv}%) | 승률 ${best.winRate}% | 총수익 ${best.totalPnl > 0 ? '+' : ''}${best.totalPnl.toLocaleString()}원`);
  if (best.label !== baseline.label) {
    console.log(`     vs 현행: EV ${(best.avgEv - baseline.avgEv > 0 ? '+' : '')}${(best.avgEv - baseline.avgEv).toFixed(3)}%, 거래수 ${best.total - baseline.total}건`);
  }
  console.log(`${'═'.repeat(85)}\n`);
}

main();
