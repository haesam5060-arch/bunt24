/**
 * 핫코인 선별 전략 백테스트
 *
 * 현행: 24시간 거래대금 상위 20개 고정 감시
 * 대안: 최근 1시간 거래량이 직전 대비 급등한 코인만 감시
 *
 * 시뮬레이션: 매 시간(12봉) 단위로 코인별 "거래량 활성도" 재평가
 * - 최근 12봉 거래량 vs 그 전 12봉 거래량 비율 계산
 * - 활성도 상위 N개 코인만 OB 매매 대상
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

// 코인별 시간대별 거래량 활성도 계산
function calcVolumeActivity(data, recentBars, prevBars) {
  // 매 recentBars 봉 단위로 활성도 기록
  const activity = {}; // { index: ratio }
  for (let i = recentBars + prevBars; i < data.length; i++) {
    let recentVol = 0, prevVol = 0;
    for (let j = i - recentBars; j < i; j++) recentVol += data[j].volume;
    for (let j = i - recentBars - prevBars; j < i - recentBars; j++) prevVol += data[j].volume;
    if (prevVol > 0) {
      activity[i] = recentVol / prevVol;
    } else {
      activity[i] = 0;
    }
  }
  return activity;
}

function runTest(allData, mode, hotTopN, volSurgeMin) {
  // 모든 코인의 OB 미리 감지
  const coinInfo = allData.map(({ coin, data }) => {
    const obs = detectOB(data).map(o => ({ ...o, used: false }));
    const activity = calcVolumeActivity(data, 12, 12); // 최근1시간 vs 직전1시간
    return { coin, data, obs, activity };
  });

  // 시간 인덱스별로 "핫코인" 선별
  // 모든 코인의 데이터 길이가 다를 수 있으므로 공통 시간 기준
  const maxLen = Math.max(...coinInfo.map(c => c.data.length));

  const timeline = {};
  const cooldowns = {};

  for (let i = 30; i < maxLen; i++) {
    // 현재 시점에서 활성도 상위 코인 선별
    let activeCoins;

    if (mode === 'all') {
      // 현행: 모든 코인
      activeCoins = coinInfo.map(c => c.coin);
    } else if (mode === 'hot_topn') {
      // 활성도 상위 N개
      const ranked = coinInfo
        .filter(c => i < c.data.length && c.activity[i])
        .map(c => ({ coin: c.coin, act: c.activity[i] }))
        .sort((a, b) => b.act - a.act);
      activeCoins = ranked.slice(0, hotTopN).map(r => r.coin);
    } else if (mode === 'hot_surge') {
      // 거래량 급등 코인만 (최근 > 직전 × N배)
      activeCoins = coinInfo
        .filter(c => i < c.data.length && c.activity[i] >= volSurgeMin)
        .map(c => c.coin);
    } else if (mode === 'hot_combined') {
      // 급등 + 상위N개
      const surged = coinInfo
        .filter(c => i < c.data.length && c.activity[i] >= volSurgeMin)
        .map(c => ({ coin: c.coin, act: c.activity[i] }))
        .sort((a, b) => b.act - a.act);
      activeCoins = surged.slice(0, hotTopN).map(r => r.coin);
    }

    // 활성 코인들에 대해 OB 터치 체크
    for (const ci of coinInfo) {
      if (!activeCoins.includes(ci.coin)) continue;
      if (i >= ci.data.length) continue;
      if (cooldowns[ci.coin] && i < cooldowns[ci.coin]) continue;

      const candle = ci.data[i];

      for (const ob of ci.obs) {
        if (ob.index >= i || i - ob.index > BASE.obMaxAge || ob.used) continue;
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;

        const entry = Math.max(candle.close, ob.bottom);
        const sl = ob.bottom * (1 - BASE.slPct / 100);
        const tp = ob.swingHigh;
        if ((tp - entry) / entry * 100 < BASE.minTpPct) continue;

        let exitP = null, exitR = null, exitI = null;
        for (let j = i + 1; j < Math.min(i + BASE.maxHoldCandles, ci.data.length); j++) {
          if (ci.data[j].low <= sl) { exitP = sl; exitR = 'SL'; exitI = j; break; }
          if (ci.data[j].high >= tp) { exitP = tp; exitR = 'TP'; exitI = j; break; }
        }
        if (!exitP) {
          exitI = Math.min(i + BASE.maxHoldCandles, ci.data.length - 1);
          exitP = ci.data[exitI].close;
          exitR = 'TIMEOUT';
        }

        const key = candle.time;
        if (!timeline[key]) timeline[key] = [];
        timeline[key].push({
          coin: ci.coin, entryIndex: i, exitIndex: exitI,
          entryTime: candle.time, exitTime: ci.data[exitI].time,
          entryPrice: entry, exitPrice: exitP, reason: exitR,
          holdMinutes: (exitI - i) * 5,
        });

        ob.used = true;
        cooldowns[ci.coin] = exitI + BASE.cooldownCandles;
        break;
      }
    }
  }

  // 포트폴리오 시뮬레이션
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
      trades.push({ coin: s.coin, pnl: Math.round(pos.amount * net), netPct: +(net * 100).toFixed(3), reason: s.reason, holdMinutes: s.holdMinutes });
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

  // 시간대별 분포
  const byHour = {};
  trades.forEach(t => {
    const h = t.coin; // 코인별 분포
    if (!byHour[h]) byHour[h] = { trades: 0, pnl: 0, wins: 0 };
    byHour[h].trades++;
    byHour[h].pnl += t.pnl;
    if (t.pnl > 0) byHour[h].wins++;
  });

  return { total: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
    tp, sl, to, totalPnl, ret: +ret.toFixed(1), avgEv: +avgEv.toFixed(3),
    avgWin: +avgWin.toFixed(3), avgLoss: +avgLoss.toFixed(3), mdd: +mdd.toFixed(2),
    avgHold: +avgHold.toFixed(0), byCoin: byHour };
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
  console.log('  핫코인 선별 전략 백테스트 — 거래량 급등 코인만 추적');
  console.log(`${'═'.repeat(90)}`);
  console.log(`  코인: ${allData.length}개 | 활성도 = 최근1시간 거래량 / 직전1시간 거래량\n`);

  const scenarios = [
    { label: '현행 (전체 17개)', mode: 'all', topN: 0, surge: 0 },
    { label: '활성도 상위 10개', mode: 'hot_topn', topN: 10, surge: 0 },
    { label: '활성도 상위 7개', mode: 'hot_topn', topN: 7, surge: 0 },
    { label: '활성도 상위 5개', mode: 'hot_topn', topN: 5, surge: 0 },
    { label: '급등 1.2x 이상만', mode: 'hot_surge', topN: 0, surge: 1.2 },
    { label: '급등 1.5x 이상만', mode: 'hot_surge', topN: 0, surge: 1.5 },
    { label: '급등 2.0x 이상만', mode: 'hot_surge', topN: 0, surge: 2.0 },
    { label: '급등1.2x + 상위10', mode: 'hot_combined', topN: 10, surge: 1.2 },
    { label: '급등1.5x + 상위7', mode: 'hot_combined', topN: 7, surge: 1.5 },
    { label: '급등1.5x + 상위5', mode: 'hot_combined', topN: 5, surge: 1.5 },
  ];

  const results = [];
  for (const s of scenarios) {
    const r = runTest(allData, s.mode, s.topN, s.surge);
    r.label = s.label;
    results.push(r);
  }

  console.log(`  ${'시나리오'.padEnd(24)} ${'거래'.padStart(5)} ${'승률'.padStart(7)} ${'TP/SL/TO'.padStart(11)} ${'총수익'.padStart(12)} ${'수익률'.padStart(9)} ${'EV/건'.padStart(8)} ${'평균승'.padStart(8)} ${'평균패'.padStart(8)} ${'MDD'.padStart(8)} ${'보유'.padStart(6)}`);
  console.log(`  ${'─'.repeat(86)}`);

  for (const r of results) {
    const best = r.avgEv === Math.max(...results.map(x => x.avgEv)) ? ' ⭐' : '';
    console.log(`  ${r.label.padEnd(24)} ${String(r.total).padStart(5)} ${(r.winRate + '%').padStart(7)} ${(r.tp + '/' + r.sl + '/' + r.to).padStart(11)} ${((r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString()).padStart(12)} ${((r.ret > 0 ? '+' : '') + r.ret + '%').padStart(9)} ${((r.avgEv > 0 ? '+' : '') + r.avgEv + '%').padStart(8)} ${('+' + r.avgWin + '%').padStart(8)} ${(r.avgLoss + '%').padStart(8)} ${('-' + r.mdd + '%').padStart(8)} ${(r.avgHold + '분').padStart(6)}${best}`);
  }

  // 최적 찾기 (거래수 50건 이상 중)
  const viable = results.filter(r => r.total >= 50);
  const bestEv = viable.reduce((a, b) => a.avgEv > b.avgEv ? a : b);
  const bestTotal = viable.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
  const baseline = results[0];

  console.log(`\n  📊 분석:`);
  console.log(`  ────────────────────────────────────────────────────`);
  console.log(`  EV 최고: ${bestEv.label} (${bestEv.avgEv}%/건, ${bestEv.total}건)`);
  console.log(`  총수익 최고: ${bestTotal.label} (+${bestTotal.totalPnl.toLocaleString()}원, ${bestTotal.total}건)`);
  console.log(`  현행 대비 EV 최고: ${(bestEv.avgEv - baseline.avgEv > 0 ? '+' : '')}${(bestEv.avgEv - baseline.avgEv).toFixed(3)}%`);
  console.log(`${'═'.repeat(90)}\n`);
}

main();
