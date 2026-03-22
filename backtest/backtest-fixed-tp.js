/**
 * 고정 TP% 백테스트
 * 현행 swing high TP vs 고정 2%, 3%, 4%, 5% TP 비교
 * + 거래량 활성도 필터 + 1H 추세 필터 포함 (현행 봇과 동일 조건)
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

// 거래량 활성도: 최근 12봉 vs 직전 12봉
function checkVolActivity(data, idx) {
  if (idx < 24) return false;
  let recent = 0, prev = 0;
  for (let j = idx - 12; j < idx; j++) recent += data[j].volume;
  for (let j = idx - 24; j < idx - 12; j++) prev += data[j].volume;
  if (prev <= 0) return true;
  return recent / prev >= 1.2;
}

// 1H 추세 시뮬레이션: 12봉(=1시간) 단위로 MA(6시간=72봉) 체크
function check1HTrend(data, idx) {
  if (idx < 72) return true;
  let maSum = 0;
  for (let j = idx - 72; j < idx; j++) maSum += data[j].close;
  const ma72 = maSum / 72;
  if (data[idx].close < ma72) return false;
  // 최근 3시간 고점 연속 하락 체크
  const h1 = Math.max(...data.slice(Math.max(idx-12,0), idx).map(c => c.high));
  const h2 = Math.max(...data.slice(Math.max(idx-24,0), idx-12).map(c => c.high));
  const h3 = Math.max(...data.slice(Math.max(idx-36,0), idx-24).map(c => c.high));
  if (h1 < h2 && h2 < h3) return false;
  return true;
}

function runTest(allData, tpMode, fixedTpPct) {
  const timeline = {};
  for (const { coin, data } of allData) {
    const obs = detectOB(data).map(o => ({ ...o, used: false }));
    const cooldowns = {};
    for (let i = 72; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];
      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > BASE.obMaxAge || ob.used) continue;
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;
        const entry = Math.max(candle.close, ob.bottom);
        const sl = ob.bottom * (1 - BASE.slPct / 100);

        // TP 결정
        let tp;
        if (tpMode === 'swing') {
          tp = ob.swingHigh;
        } else {
          tp = entry * (1 + fixedTpPct / 100);
        }

        if ((tp - entry) / entry * 100 < BASE.minTpPct) continue;

        // 거래량 활성도 필터
        if (!checkVolActivity(data, i)) continue;
        // 1H 추세 필터
        if (!check1HTrend(data, i)) continue;

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

  return { total: trades.length, wins: wins.length, losses: losses.length,
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

  console.log(`\n${'═'.repeat(90)}`);
  console.log('  고정 TP% 백테스트 — swing high vs 고정 TP (필터 포함)');
  console.log(`${'═'.repeat(90)}`);
  console.log(`  코인: ${allData.length}개 | SL: ${BASE.slPct}% | 필터: 거래량1.2x + 1H추세\n`);

  const scenarios = [
    { label: '현행 swing high', mode: 'swing', pct: 0 },
    { label: '고정 1.5%', mode: 'fixed', pct: 1.5 },
    { label: '고정 2.0%', mode: 'fixed', pct: 2.0 },
    { label: '고정 2.5%', mode: 'fixed', pct: 2.5 },
    { label: '고정 3.0%', mode: 'fixed', pct: 3.0 },
    { label: '고정 3.5%', mode: 'fixed', pct: 3.5 },
    { label: '고정 4.0%', mode: 'fixed', pct: 4.0 },
    { label: '고정 5.0%', mode: 'fixed', pct: 5.0 },
  ];

  const results = scenarios.map(s => {
    const r = runTest(allData, s.mode, s.pct);
    r.label = s.label;
    return r;
  });

  console.log(`  ${'시나리오'.padEnd(20)} ${'거래'.padStart(5)} ${'승률'.padStart(7)} ${'TP/SL/TO'.padStart(11)} ${'총수익'.padStart(12)} ${'수익률'.padStart(9)} ${'EV/건'.padStart(8)} ${'평균승'.padStart(8)} ${'평균패'.padStart(8)} ${'MDD'.padStart(8)} ${'보유'.padStart(6)}`);
  console.log(`  ${'─'.repeat(86)}`);

  for (const r of results) {
    const best = r.avgEv === Math.max(...results.map(x => x.avgEv)) ? ' ⭐' : '';
    console.log(`  ${r.label.padEnd(20)} ${String(r.total).padStart(5)} ${(r.winRate + '%').padStart(7)} ${(r.tp + '/' + r.sl + '/' + r.to).padStart(11)} ${((r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString()).padStart(12)} ${((r.ret > 0 ? '+' : '') + r.ret + '%').padStart(9)} ${((r.avgEv > 0 ? '+' : '') + r.avgEv + '%').padStart(8)} ${('+' + r.avgWin + '%').padStart(8)} ${(r.avgLoss + '%').padStart(8)} ${('-' + r.mdd + '%').padStart(8)} ${(r.avgHold + '분').padStart(6)}${best}`);
  }

  const best = results.reduce((a, b) => a.avgEv > b.avgEv ? a : b);
  const baseline = results[0];
  console.log(`\n  📊 분석:`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  EV 최고: ${best.label} (${best.avgEv}%/건, ${best.total}건)`);
  console.log(`  현행 swing: EV ${baseline.avgEv}%/건, 평균승 ${baseline.avgWin}%, 평균패 ${baseline.avgLoss}%`);
  console.log(`  차이: EV ${(best.avgEv - baseline.avgEv > 0 ? '+' : '')}${(best.avgEv - baseline.avgEv).toFixed(3)}%`);

  // 건당 기대수익 (5만원 기준)
  console.log(`\n  💰 건당 기대수익 (5만원 투자 기준):`);
  for (const r of results) {
    const perTrade = Math.round(50000 * r.avgEv / 100);
    console.log(`  ${r.label.padEnd(20)} ${(perTrade > 0 ? '+' : '') + perTrade}원/건`);
  }
  console.log(`${'═'.repeat(90)}\n`);
}

main();
