/**
 * 거래 빈도 증가 백테스트
 * 임펄스 기준, OB 수명, 감시 코인 수 조합 비교
 * 필터 포함: 거래량1.2x + 1H추세 + minTP 0.8%
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005;

function detectOB(data, impulseMinPct, impulseLookback, volumeAvgWindow) {
  const obs = [];
  for (let i = volumeAvgWindow; i < data.length - impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue;
    let maxHigh = 0;
    for (let j = i + 1; j <= i + impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHigh) maxHigh = data[j].high;
    }
    const imp = (maxHigh - c.close) / c.close * 100;
    if (imp < impulseMinPct) continue;
    obs.push({ index: i, top: c.open, bottom: c.close, swingHigh: maxHigh, used: false });
  }
  return obs;
}

function checkVolActivity(data, idx) {
  if (idx < 24) return false;
  let recent = 0, prev = 0;
  for (let j = idx - 12; j < idx; j++) recent += data[j].volume;
  for (let j = idx - 24; j < idx - 12; j++) prev += data[j].volume;
  if (prev <= 0) return true;
  return recent / prev >= 1.2;
}

function check1HTrend(data, idx) {
  if (idx < 72) return true;
  let maSum = 0;
  for (let j = idx - 72; j < idx; j++) maSum += data[j].close;
  const ma72 = maSum / 72;
  if (data[idx].close < ma72) return false;
  const h1 = Math.max(...data.slice(Math.max(idx-12,0), idx).map(c => c.high));
  const h2 = Math.max(...data.slice(Math.max(idx-24,0), idx-12).map(c => c.high));
  const h3 = Math.max(...data.slice(Math.max(idx-36,0), idx-24).map(c => c.high));
  if (h1 < h2 && h2 < h3) return false;
  return true;
}

function runTest(allData, params) {
  const { impulseMinPct, obMaxAge, slPct, maxPositions, minTpPct } = params;
  const timeline = {};
  for (const { coin, data } of allData) {
    const obs = detectOB(data, impulseMinPct, 6, 20).map(o => ({ ...o, used: false }));
    const cooldowns = {};
    for (let i = 72; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];
      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > obMaxAge || ob.used) continue;
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;
        const entry = Math.max(candle.close, ob.bottom);
        const sl = ob.bottom * (1 - slPct / 100);
        const tp = ob.swingHigh;
        if ((tp - entry) / entry * 100 < minTpPct) continue;
        if (!checkVolActivity(data, i)) continue;
        if (!check1HTrend(data, i)) continue;

        let exitP = null, exitR = null, exitI = null;
        for (let j = i + 1; j < Math.min(i + 60, data.length); j++) {
          if (data[j].low <= sl) { exitP = sl; exitR = 'SL'; exitI = j; break; }
          if (data[j].high >= tp) { exitP = tp; exitR = 'TP'; exitI = j; break; }
        }
        if (!exitP) { exitI = Math.min(i + 60, data.length - 1); exitP = data[exitI].close; exitR = 'TIMEOUT'; }
        const key = candle.time;
        if (!timeline[key]) timeline[key] = [];
        timeline[key].push({ coin, entryIndex: i, exitIndex: exitI, entryTime: candle.time, exitTime: data[exitI].time, entryPrice: entry, exitPrice: exitP, reason: exitR, holdMinutes: (exitI - i) * 5 });
        ob.used = true;
        cooldowns[coin] = exitI + 6;
        break;
      }
    }
  }

  const initialCapital = 100000;
  let cash = initialCapital;
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
      if (active.size >= maxPositions) continue;
      const alloc = Math.floor(cash / (maxPositions - active.size));
      if (alloc < 5000) continue;
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
  const ret = (totalPnl / initialCapital) * 100;
  let peak = initialCapital, mdd = 0, run = initialCapital;
  for (const t of trades) { run += t.pnl; if (run > peak) peak = run; const dd = (peak - run) / peak * 100; if (dd > mdd) mdd = dd; }
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0;

  // 데이터 기간 추정 (일수)
  const allTimes = allData.flatMap(d => [d.data[0].time, d.data[d.data.length-1].time]).sort();
  const firstTime = new Date(allTimes[0]);
  const lastTime = new Date(allTimes[allTimes.length-1]);
  const days = Math.max(1, (lastTime - firstTime) / (1000*60*60*24));
  const tradesPerDay = trades.length / days;

  return { total: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
    tp, sl, to, totalPnl, ret: +ret.toFixed(1), avgEv: +avgEv.toFixed(3),
    avgWin: +avgWin.toFixed(3), avgLoss: +avgLoss.toFixed(3), mdd: +mdd.toFixed(2),
    avgHold: +avgHold.toFixed(0), tradesPerDay: +tradesPerDay.toFixed(1) };
}

function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !['BTC.json', 'ETH.json', 'USDT.json'].includes(f));
  const allData = files.map(f => {
    const coin = f.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    const data = raw.map(c => ({ time: c.time || c.candle_date_time_kst, open: c.open || c.opening_price, high: c.high || c.high_price, low: c.low || c.low_price, close: c.close || c.trade_price, volume: c.volume || c.candle_acc_trade_volume })).sort((a, b) => a.time.localeCompare(b.time));
    return data.length >= 100 ? { coin, data } : null;
  }).filter(Boolean);

  console.log(`\n${'═'.repeat(100)}`);
  console.log('  거래 빈도 증가 백테스트 — 임펄스/OB수명/포지션 조합');
  console.log(`${'═'.repeat(100)}`);
  console.log(`  코인: ${allData.length}개 | 필터: 거래량1.2x + 1H추세 + minTP 0.8%\n`);

  const scenarios = [
    // 현행
    { label: '현행 (2%/24봉/2pos)', impulseMinPct: 2, obMaxAge: 24, slPct: 0.8, maxPositions: 2, minTpPct: 0.8 },
    // 임펄스 완화
    { label: '임펄스 1.5%', impulseMinPct: 1.5, obMaxAge: 24, slPct: 0.8, maxPositions: 2, minTpPct: 0.8 },
    { label: '임펄스 1.2%', impulseMinPct: 1.2, obMaxAge: 24, slPct: 0.8, maxPositions: 2, minTpPct: 0.8 },
    // OB 수명 연장
    { label: 'OB수명 36봉(3시간)', impulseMinPct: 2, obMaxAge: 36, slPct: 0.8, maxPositions: 2, minTpPct: 0.8 },
    { label: 'OB수명 48봉(4시간)', impulseMinPct: 2, obMaxAge: 48, slPct: 0.8, maxPositions: 2, minTpPct: 0.8 },
    // 포지션 늘리기
    { label: '3포지션', impulseMinPct: 2, obMaxAge: 24, slPct: 0.8, maxPositions: 3, minTpPct: 0.8 },
    { label: '4포지션', impulseMinPct: 2, obMaxAge: 24, slPct: 0.8, maxPositions: 4, minTpPct: 0.8 },
    // 복합: 임펄스 완화 + OB 수명 연장
    { label: '1.5% + 36봉', impulseMinPct: 1.5, obMaxAge: 36, slPct: 0.8, maxPositions: 2, minTpPct: 0.8 },
    { label: '1.5% + 36봉 + 3pos', impulseMinPct: 1.5, obMaxAge: 36, slPct: 0.8, maxPositions: 3, minTpPct: 0.8 },
    // SL 조정
    { label: 'SL 1.0%', impulseMinPct: 2, obMaxAge: 24, slPct: 1.0, maxPositions: 2, minTpPct: 0.8 },
    { label: 'SL 1.5%', impulseMinPct: 2, obMaxAge: 24, slPct: 1.5, maxPositions: 2, minTpPct: 0.8 },
    // 최적 후보: 약간 완화 + 수명 연장
    { label: '1.5% + 36봉 + SL1.0%', impulseMinPct: 1.5, obMaxAge: 36, slPct: 1.0, maxPositions: 2, minTpPct: 0.8 },
  ];

  const results = scenarios.map(s => {
    const r = runTest(allData, s);
    r.label = s.label;
    return r;
  });

  console.log(`  ${'시나리오'.padEnd(26)} ${'거래'.padStart(5)} ${'일평균'.padStart(6)} ${'승률'.padStart(7)} ${'TP/SL/TO'.padStart(11)} ${'총수익'.padStart(12)} ${'EV/건'.padStart(8)} ${'평균승'.padStart(8)} ${'평균패'.padStart(8)} ${'MDD'.padStart(8)} ${'보유'.padStart(6)}`);
  console.log(`  ${'─'.repeat(94)}`);

  for (const r of results) {
    const best = r.totalPnl === Math.max(...results.map(x => x.totalPnl)) ? ' 💰' :
                 r.avgEv === Math.max(...results.map(x => x.avgEv)) ? ' ⭐' : '';
    console.log(`  ${r.label.padEnd(26)} ${String(r.total).padStart(5)} ${(r.tradesPerDay + '건').padStart(6)} ${(r.winRate + '%').padStart(7)} ${(r.tp + '/' + r.sl + '/' + r.to).padStart(11)} ${((r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString()).padStart(12)} ${((r.avgEv > 0 ? '+' : '') + r.avgEv + '%').padStart(8)} ${('+' + r.avgWin + '%').padStart(8)} ${(r.avgLoss + '%').padStart(8)} ${('-' + r.mdd + '%').padStart(8)} ${(r.avgHold + '분').padStart(6)}${best}`);
  }

  // 일일 기대수익 계산
  console.log(`\n  💰 일일 기대수익 (시드 10만원 기준):`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const r of results) {
    const dailyPnl = Math.round(r.totalPnl / Math.max(1, r.total) * r.tradesPerDay);
    const monthlyPnl = dailyPnl * 30;
    console.log(`  ${r.label.padEnd(26)} 일 ${(dailyPnl > 0 ? '+' : '') + dailyPnl.toLocaleString()}원 | 월 ${(monthlyPnl > 0 ? '+' : '') + monthlyPnl.toLocaleString()}원`);
  }

  const bestTotal = results.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
  const bestEv = results.reduce((a, b) => a.avgEv > b.avgEv ? a : b);
  const baseline = results[0];
  console.log(`\n  📊 결론:`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  총수익 최고: ${bestTotal.label} (+${bestTotal.totalPnl.toLocaleString()}원, ${bestTotal.total}건)`);
  console.log(`  EV 최고: ${bestEv.label} (${bestEv.avgEv}%/건)`);
  console.log(`  현행: ${baseline.total}건, EV ${baseline.avgEv}%, 총수익 +${baseline.totalPnl.toLocaleString()}원`);
  console.log(`${'═'.repeat(100)}\n`);
}

main();
