/**
 * 멀티타임프레임(MTF) OB 크로스체크 백테스트
 *
 * 현행: 5분봉 OB만 보고 진입
 * MTF:  5분봉 OB 터치 + 1시간봉 조건 확인 후 진입
 *
 * 1시간봉 조건 시나리오:
 * A) 1H OB 위에 있을 때만 (1H 지지 존 확인)
 * B) 1H 추세 상승일 때만 (최근 종가 > N봉 MA)
 * C) 1H가 하락 추세가 아닐 때 (최근 고점이 직전 고점 이상)
 * D) A+B 결합
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

// 5분봉 → 1시간봉 변환 (12개씩 묶기)
function aggregate1H(data5m) {
  const candles1H = [];
  for (let i = 0; i < data5m.length; i += 12) {
    const chunk = data5m.slice(i, i + 12);
    if (chunk.length < 12) break;
    candles1H.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
      startIdx: i,       // 5분봉 인덱스 매핑
      endIdx: i + 11,
    });
  }
  return candles1H;
}

function detectOB_5m(data) {
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

// 1시간봉 OB 감지 (더 넓은 파라미터)
function detectOB_1H(data1H) {
  const obs = [];
  const impMin = 1.5;  // 1H는 임펄스 기준 낮춤
  const lookback = 3;  // 3봉 = 3시간

  for (let i = 5; i < data1H.length - lookback; i++) {
    const c = data1H[i];
    if (c.close >= c.open) continue; // 음봉

    let maxHigh = 0;
    for (let j = i + 1; j <= i + lookback && j < data1H.length; j++) {
      if (data1H[j].high > maxHigh) maxHigh = data1H[j].high;
    }
    const imp = (maxHigh - c.close) / c.close * 100;
    if (imp < impMin) continue;

    obs.push({
      index: i,
      top: c.open,
      bottom: c.close,
      swingHigh: maxHigh,
      startIdx: data1H[i].startIdx,  // 5분봉 매핑
      endIdx: data1H[i].endIdx,
      time: c.time,
    });
  }
  return obs;
}

// 1시간봉 MA 계산
function calcMA_1H(data1H, period) {
  const ma = [];
  for (let i = 0; i < data1H.length; i++) {
    if (i < period - 1) { ma.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data1H[j].close;
    ma.push(sum / period);
  }
  return ma;
}

// 5분봉 인덱스 → 해당 시점의 1시간봉 인덱스
function get1HIndex(data1H, idx5m) {
  for (let i = data1H.length - 1; i >= 0; i--) {
    if (data1H[i].startIdx <= idx5m) return i;
  }
  return 0;
}

function runTest(allData, mode) {
  const timeline = {};

  for (const { coin, data5m, obs5m, data1H, obs1H, ma1H } of allData) {
    const cooldowns = {};

    for (let i = 30; i < data5m.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data5m[i];

      for (const ob of obs5m) {
        if (ob.index >= i || i - ob.index > BASE.obMaxAge || ob.used) continue;
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;

        const entry = Math.max(candle.close, ob.bottom);
        const sl = ob.bottom * (1 - BASE.slPct / 100);
        const tp = ob.swingHigh;
        if ((tp - entry) / entry * 100 < BASE.minTpPct) continue;

        // ── MTF 필터 ──
        const h1Idx = get1HIndex(data1H, i);

        if (mode === 'mtf_ob_support') {
          // A) 현재 가격이 1H OB 위에 있는지
          let hasSupport = false;
          for (const ob1h of obs1H) {
            if (ob1h.index >= h1Idx) continue; // 미래 OB 제외
            if (h1Idx - ob1h.index > 48) continue; // 48시간 이내
            if (entry >= ob1h.bottom && entry <= ob1h.swingHigh) {
              hasSupport = true;
              break;
            }
          }
          if (!hasSupport) continue;
        }

        else if (mode === 'mtf_trend_up') {
          // B) 1H MA 위에 있을 때만 (상승 추세)
          if (h1Idx < 6 || !ma1H[h1Idx]) continue;
          if (data1H[h1Idx].close < ma1H[h1Idx]) continue;
        }

        else if (mode === 'mtf_not_downtrend') {
          // C) 1H가 하락 추세가 아닐 때
          // 최근 3봉의 고점이 점점 낮아지면 하락 추세
          if (h1Idx < 3) continue;
          const h1 = data1H[h1Idx].high;
          const h2 = data1H[h1Idx - 1].high;
          const h3 = data1H[h1Idx - 2].high;
          if (h1 < h2 && h2 < h3) continue; // 연속 저점 갱신 = 하락 추세
        }

        else if (mode === 'mtf_combined') {
          // D) 하락 추세 아님 + MA 위
          if (h1Idx < 6 || !ma1H[h1Idx]) continue;
          // 하락 추세 체크
          const h1 = data1H[h1Idx].high;
          const h2 = data1H[h1Idx - 1].high;
          const h3 = data1H[h1Idx - 2].high;
          if (h1 < h2 && h2 < h3) continue;
          // MA 위 체크
          if (data1H[h1Idx].close < ma1H[h1Idx]) continue;
        }

        else if (mode === 'mtf_not_down_only') {
          // E) 하락 추세만 걸러냄 (가장 가벼운 필터)
          if (h1Idx < 4) continue;
          const h1 = data1H[h1Idx].high;
          const h2 = data1H[h1Idx - 1].high;
          const h3 = data1H[h1Idx - 2].high;
          const h4 = data1H[h1Idx - 3].high;
          // 4연속 고점 하락 = 강한 하락 추세
          if (h1 < h2 && h2 < h3 && h3 < h4) continue;
        }

        // 미래 캔들에서 결과
        let exitP = null, exitR = null, exitI = null;
        for (let j = i + 1; j < Math.min(i + BASE.maxHoldCandles, data5m.length); j++) {
          if (data5m[j].low <= sl) { exitP = sl; exitR = 'SL'; exitI = j; break; }
          if (data5m[j].high >= tp) { exitP = tp; exitR = 'TP'; exitI = j; break; }
        }
        if (!exitP) { exitI = Math.min(i + BASE.maxHoldCandles, data5m.length - 1); exitP = data5m[exitI].close; exitR = 'TIMEOUT'; }

        const key = candle.time;
        if (!timeline[key]) timeline[key] = [];
        timeline[key].push({ coin, entryIndex: i, exitIndex: exitI, entryTime: candle.time, exitTime: data5m[exitI].time, entryPrice: entry, exitPrice: exitP, reason: exitR, holdMinutes: (exitI - i) * 5 });

        ob.used = true;
        cooldowns[coin] = exitI + BASE.cooldownCandles;
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

  return { total: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
    tp, sl, to, totalPnl, ret: +ret.toFixed(1), avgEv: +avgEv.toFixed(3),
    avgWin: +avgWin.toFixed(3), avgLoss: +avgLoss.toFixed(3), mdd: +mdd.toFixed(2), avgHold: +avgHold.toFixed(0) };
}

function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !['BTC.json', 'ETH.json', 'USDT.json'].includes(f));

  console.log(`\n${'═'.repeat(90)}`);
  console.log('  멀티타임프레임 OB 크로스체크 백테스트 — 5분봉 OB + 1시간봉 확인');
  console.log(`${'═'.repeat(90)}\n`);

  const allData = [];
  for (const f of files) {
    const coin = f.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    const data5m = raw.map(c => ({ time: c.time || c.candle_date_time_kst, open: c.open || c.opening_price, high: c.high || c.high_price, low: c.low || c.low_price, close: c.close || c.trade_price, volume: c.volume || c.candle_acc_trade_volume })).sort((a, b) => a.time.localeCompare(b.time));
    if (data5m.length < 100) continue;

    const data1H = aggregate1H(data5m);
    const obs5m = detectOB_5m(data5m);
    const obs1H = detectOB_1H(data1H);
    const ma1H = calcMA_1H(data1H, 6); // 6시간 MA

    console.log(`  ${coin}: 5m ${obs5m.length}OB, 1H ${obs1H.length}OB, ${data1H.length}시간봉`);
    allData.push({ coin, data5m, obs5m, data1H, obs1H, ma1H });
  }

  const scenarios = [
    { label: '현행 (5분봉만)', mode: 'all' },
    { label: '1H OB 지지 확인', mode: 'mtf_ob_support' },
    { label: '1H MA 위 (상승추세)', mode: 'mtf_trend_up' },
    { label: '1H 하락추세 아님(3봉)', mode: 'mtf_not_downtrend' },
    { label: '1H 강하락 아님(4봉)', mode: 'mtf_not_down_only' },
    { label: '1H 하락아님 + MA위', mode: 'mtf_combined' },
  ];

  const results = [];
  for (const s of scenarios) {
    // OB used 플래그 초기화
    for (const cd of allData) {
      cd.obs5m.forEach(o => o.used = false);
    }
    const r = runTest(allData, s.mode);
    r.label = s.label;
    results.push(r);
  }

  console.log(`\n${'═'.repeat(90)}`);
  console.log('  📊 MTF 크로스체크 비교 결과');
  console.log(`${'═'.repeat(90)}`);
  console.log(`  ${'시나리오'.padEnd(26)} ${'거래'.padStart(5)} ${'승률'.padStart(7)} ${'TP/SL/TO'.padStart(11)} ${'총수익'.padStart(12)} ${'수익률'.padStart(9)} ${'EV/건'.padStart(8)} ${'평균승'.padStart(8)} ${'평균패'.padStart(8)} ${'MDD'.padStart(8)} ${'보유'.padStart(6)}`);
  console.log(`  ${'─'.repeat(86)}`);

  for (const r of results) {
    const best = r.avgEv === Math.max(...results.filter(x => x.total >= 30).map(x => x.avgEv)) ? ' ⭐' : '';
    console.log(`  ${r.label.padEnd(26)} ${String(r.total).padStart(5)} ${(r.winRate + '%').padStart(7)} ${(r.tp + '/' + r.sl + '/' + r.to).padStart(11)} ${((r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString()).padStart(12)} ${((r.ret > 0 ? '+' : '') + r.ret + '%').padStart(9)} ${((r.avgEv > 0 ? '+' : '') + r.avgEv + '%').padStart(8)} ${('+' + r.avgWin + '%').padStart(8)} ${(r.avgLoss + '%').padStart(8)} ${('-' + r.mdd + '%').padStart(8)} ${(r.avgHold + '분').padStart(6)}${best}`);
  }

  const viable = results.filter(r => r.total >= 30);
  const bestEv = viable.reduce((a, b) => a.avgEv > b.avgEv ? a : b);
  const baseline = results[0];
  console.log(`\n  ✅ 최적: ${bestEv.label}`);
  console.log(`     EV ${bestEv.avgEv}%/건 (현행 ${baseline.avgEv}%) | 승률 ${bestEv.winRate}% | MDD -${bestEv.mdd}%`);
  if (bestEv.label !== baseline.label) {
    console.log(`     vs 현행: EV ${(bestEv.avgEv - baseline.avgEv > 0 ? '+' : '')}${(bestEv.avgEv - baseline.avgEv).toFixed(3)}%, 거래 ${bestEv.total - baseline.total}건, MDD ${(bestEv.mdd - baseline.mdd > 0 ? '+' : '')}${(bestEv.mdd - baseline.mdd).toFixed(2)}%`);
  }
  console.log(`${'═'.repeat(90)}\n`);
}

main();
