/**
 * 거래량 필터 A/B 백테스트
 *
 * 비교: 거래량 필터 없음 vs 매수 시점 5분봉 거래량 >= 평균거래량 × N배
 * 라이브 설정(24번트)과 동일 파라미터 사용
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005; // 0.05% (업비트 KRW Taker)

// 24번트 라이브 설정과 동일
const BASE_CONFIG = {
  impulseMinPct: 2,
  impulseLookback: 6,
  volumeMultiplier: 1,
  volumeAvgWindow: 20,
  obMaxAge: 24,
  tpMode: 'swing',
  slPct: 0.8,
  maxHoldCandles: 60,
  cooldownCandles: 6,
  useTrendFilter: false,
  trendMaPeriod: 50,
  initialCapital: 100000,
  maxPositions: 5,
  minOrderAmount: 5000,
  minTpPct: 0.5,           // TP 최소 수익률 필터 (이미 적용됨)
};

// ── 보조 함수 ─────────────────────────────────────
function calcMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j].close;
    result.push(sum / period);
  }
  return result;
}

function calcAvgVolume(data, window) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < window) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - window; j < i; j++) sum += data[j].volume;
    result.push(sum / window);
  }
  return result;
}

function detectOrderBlocks(data, avgVol, config) {
  const obs = [];
  for (let i = config.volumeAvgWindow; i < data.length - config.impulseLookback; i++) {
    const candle = data[i];
    if (candle.close >= candle.open) continue;

    let maxHighAfter = 0;
    for (let j = i + 1; j <= i + config.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHighAfter) maxHighAfter = data[j].high;
    }
    const impulsePct = (maxHighAfter - candle.close) / candle.close * 100;
    if (impulsePct < config.impulseMinPct) continue;

    obs.push({
      index: i,
      time: candle.time,
      top: candle.open,
      bottom: candle.close,
      swingHigh: maxHighAfter,
      impulsePct: +impulsePct.toFixed(2),
      used: false,
    });
  }
  return obs;
}

// ── 시그널 타임라인 (거래량 필터 포함) ──────────────
function buildSignalTimeline(allCoinData, config, entryVolFilter) {
  const timeline = {};

  for (const { coin, data, obs, ma, avgVol } of allCoinData) {
    const cooldowns = {};

    for (let i = config.volumeAvgWindow + config.impulseLookback; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];

      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > config.obMaxAge || ob.used) continue;

        const touchedOB = candle.low <= ob.top && candle.close >= ob.bottom;
        if (!touchedOB) continue;

        const entryPrice = Math.max(candle.close, ob.bottom);
        const slPrice = ob.bottom * (1 - config.slPct / 100);
        const tpPrice = config.tpMode === 'swing' ? ob.swingHigh : entryPrice * (1 + 1.5 / 100);

        // TP 최소 수익률 필터
        const expectedPct = (tpPrice - entryPrice) / entryPrice * 100;
        if (expectedPct < config.minTpPct) continue;

        // 🔑 거래량 필터: 매수 시점 캔들 거래량 >= 평균 × entryVolFilter
        if (entryVolFilter > 0 && avgVol[i] && candle.volume < avgVol[i] * entryVolFilter) continue;

        // 미래 캔들에서 TP/SL 확인
        let exitPrice = null, exitReason = null, exitIndex = null;
        for (let j = i + 1; j < Math.min(i + config.maxHoldCandles, data.length); j++) {
          if (data[j].low <= slPrice) { exitPrice = slPrice; exitReason = 'SL'; exitIndex = j; break; }
          if (data[j].high >= tpPrice) { exitPrice = tpPrice; exitReason = 'TP'; exitIndex = j; break; }
        }
        if (!exitPrice) {
          const lastIdx = Math.min(i + config.maxHoldCandles, data.length - 1);
          exitPrice = data[lastIdx].close;
          exitReason = 'TIMEOUT';
          exitIndex = lastIdx;
        }

        const timeKey = candle.time;
        if (!timeline[timeKey]) timeline[timeKey] = [];
        timeline[timeKey].push({
          coin, entryIndex: i, exitIndex,
          entryTime: candle.time, exitTime: data[exitIndex].time,
          entryPrice, exitPrice, tpPrice, slPrice,
          reason: exitReason,
          holdMinutes: (exitIndex - i) * 5,
          impulsePct: ob.impulsePct,
          entryVolume: candle.volume,
          avgVolume: avgVol[i] || 0,
        });

        ob.used = true;
        cooldowns[coin] = exitIndex + config.cooldownCandles;
        break;
      }
    }
  }
  return timeline;
}

// ── 포트폴리오 시뮬레이션 ─────────────────────────
function simulatePortfolio(timeline, config) {
  let cash = config.initialCapital;
  const closedTrades = [];
  const equityCurve = [];
  const events = [];

  for (const time of Object.keys(timeline).sort()) {
    for (const sig of timeline[time]) {
      events.push({ type: 'ENTRY', time: sig.entryTime, signal: sig });
      events.push({ type: 'EXIT', time: sig.exitTime, signal: sig });
    }
  }

  events.sort((a, b) => {
    if (a.time !== b.time) return a.time.localeCompare(b.time);
    return a.type === 'EXIT' ? -1 : 1;
  });

  const activePositions = new Map();

  for (const event of events) {
    const sig = event.signal;
    const key = `${sig.coin}_${sig.entryTime}`;

    if (event.type === 'EXIT') {
      const pos = activePositions.get(key);
      if (!pos) continue;
      const grossPct = (sig.exitPrice - sig.entryPrice) / sig.entryPrice;
      const netPct = grossPct - COMMISSION * 2;
      const pnl = pos.amount * netPct;
      cash += pos.amount + pnl;
      activePositions.delete(key);
      closedTrades.push({
        coin: sig.coin, entryTime: sig.entryTime, exitTime: sig.exitTime,
        entryPrice: sig.entryPrice, exitPrice: sig.exitPrice,
        amount: Math.round(pos.amount), pnl: Math.round(pnl),
        netPct: +(netPct * 100).toFixed(3), reason: sig.reason,
        holdMinutes: sig.holdMinutes,
      });
    }

    if (event.type === 'ENTRY') {
      const hasSameCoin = [...activePositions.values()].some(p => p.coin === sig.coin);
      if (hasSameCoin) continue;
      if (activePositions.size >= config.maxPositions) continue;
      const availSlots = config.maxPositions - activePositions.size;
      const allocAmount = Math.floor(cash / availSlots);
      if (allocAmount < config.minOrderAmount) continue;
      const investAmount = Math.min(allocAmount, cash);
      cash -= investAmount;
      activePositions.set(key, { coin: sig.coin, entryTime: sig.entryTime, amount: investAmount });
    }
  }

  // MDD
  let peak = config.initialCapital, mdd = 0, runCash = config.initialCapital;
  for (const t of closedTrades) {
    runCash += t.pnl;
    if (runCash > peak) peak = runCash;
    const dd = (peak - runCash) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  const finalEquity = closedTrades.reduce((s, t) => s + t.pnl, 0) + config.initialCapital;
  return { closedTrades, finalEquity, mdd, finalCash: cash };
}

// ── 결과 요약 출력 ────────────────────────────────
function summarize(label, trades, finalEquity, mdd) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnlPct = trades.length > 0 ? trades.reduce((s, t) => s + t.netPct, 0) / trades.length : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0;
  const totalReturnPct = (finalEquity / BASE_CONFIG.initialCapital - 1) * 100;

  // 일별 통계
  const dailyPnl = {};
  trades.forEach(t => {
    const date = t.entryTime.slice(0, 10);
    if (!dailyPnl[date]) dailyPnl[date] = { pnl: 0, trades: 0 };
    dailyPnl[date].pnl += t.pnl;
    dailyPnl[date].trades++;
  });
  const days = Object.keys(dailyPnl);
  const profitDays = days.filter(d => dailyPnl[d].pnl > 0).length;
  const dailyAvgPct = days.length > 0 ? totalReturnPct / days.length : 0;

  // TP/SL 비율
  const tp = trades.filter(t => t.reason === 'TP').length;
  const sl = trades.filter(t => t.reason === 'SL').length;
  const to = trades.filter(t => t.reason === 'TIMEOUT').length;

  return {
    label, totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
    tp, sl, to,
    totalPnl, totalReturnPct: +totalReturnPct.toFixed(1),
    avgPnlPct: +avgPnlPct.toFixed(3), avgWinPct: +avgWinPct.toFixed(3), avgLossPct: +avgLossPct.toFixed(3),
    avgHold: +avgHold.toFixed(0), mdd: +mdd.toFixed(2),
    days: days.length, profitDays, dailyAvgPct: +dailyAvgPct.toFixed(2),
    finalEquity,
  };
}

// ── 메인 ──────────────────────────────────────────
function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !['BTC.json', 'ETH.json', 'USDT.json'].includes(f));
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  거래량 필터 A/B 백테스트');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  코인: ${files.length}개 | 설정: 24번트 라이브 동일\n`);

  // 데이터 로드 (OB 감지는 필터 없이 공통)
  const allCoinData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const rawData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));

    // 정규화 (업비트 형식이면 변환)
    const data = rawData.map(c => ({
      time: c.time || c.candle_date_time_kst,
      open: c.open || c.opening_price,
      high: c.high || c.high_price,
      low: c.low || c.low_price,
      close: c.close || c.trade_price,
      volume: c.volume || c.candle_acc_trade_volume,
    })).sort((a, b) => a.time.localeCompare(b.time));

    if (data.length < 100) continue;

    const ma = calcMA(data, BASE_CONFIG.trendMaPeriod);
    const avgVol = calcAvgVolume(data, BASE_CONFIG.volumeAvgWindow);
    const obs = detectOrderBlocks(data, avgVol, BASE_CONFIG);

    console.log(`  ${coin}: ${data.length}캔들, ${obs.length}개 OB`);
    allCoinData.push({ coin, data, obs: obs.map(o => ({ ...o })), ma, avgVol });
  }

  // ── A/B 테스트 실행 ──────────────────────────────
  const scenarios = [
    { label: '필터 없음 (현행)', volFilter: 0 },
    { label: '거래량 ≥ 0.5x 평균', volFilter: 0.5 },
    { label: '거래량 ≥ 0.8x 평균', volFilter: 0.8 },
    { label: '거래량 ≥ 1.0x 평균', volFilter: 1.0 },
    { label: '거래량 ≥ 1.5x 평균', volFilter: 1.5 },
    { label: '거래량 ≥ 2.0x 평균', volFilter: 2.0 },
  ];

  const results = [];

  for (const scenario of scenarios) {
    // OB 복사 (used 플래그 초기화)
    const coinDataCopy = allCoinData.map(c => ({
      ...c,
      obs: c.obs.map(o => ({ ...o, used: false })),
    }));

    const timeline = buildSignalTimeline(coinDataCopy, BASE_CONFIG, scenario.volFilter);
    const totalSignals = Object.values(timeline).reduce((s, arr) => s + arr.length, 0);
    const { closedTrades, finalEquity, mdd } = simulatePortfolio(timeline, BASE_CONFIG);
    const summary = summarize(scenario.label, closedTrades, finalEquity, mdd);
    summary.volFilter = scenario.volFilter;
    summary.totalSignals = totalSignals;
    results.push(summary);
  }

  // ── 결과 비교 테이블 ─────────────────────────────
  console.log(`\n${'═'.repeat(80)}`);
  console.log('  📊 거래량 필터 A/B 비교 결과');
  console.log(`${'═'.repeat(80)}`);
  console.log(`  ${'시나리오'.padEnd(22)} ${'거래수'.padStart(5)} ${'승률'.padStart(6)} ${'TP/SL/TO'.padStart(12)} ${'총수익'.padStart(10)} ${'수익률'.padStart(8)} ${'EV/건'.padStart(8)} ${'MDD'.padStart(7)} ${'일수익'.padStart(7)}`);
  console.log(`  ${'─'.repeat(76)}`);

  for (const r of results) {
    const pnlStr = (r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString();
    const retStr = (r.totalReturnPct > 0 ? '+' : '') + r.totalReturnPct + '%';
    const evStr = (r.avgPnlPct > 0 ? '+' : '') + r.avgPnlPct + '%';
    const mddStr = '-' + r.mdd + '%';
    const dailyStr = (r.dailyAvgPct > 0 ? '+' : '') + r.dailyAvgPct + '%';
    console.log(`  ${r.label.padEnd(22)} ${String(r.totalTrades).padStart(5)} ${(r.winRate + '%').padStart(6)} ${(r.tp + '/' + r.sl + '/' + r.to).padStart(12)} ${pnlStr.padStart(10)} ${retStr.padStart(8)} ${evStr.padStart(8)} ${mddStr.padStart(7)} ${dailyStr.padStart(7)}`);
  }

  console.log(`\n  💡 추천: EV/건이 가장 높고, 거래수가 적당히 유지되는 설정 선택`);
  console.log(`${'═'.repeat(80)}\n`);

  // 최적 찾기
  const best = results.reduce((a, b) => a.avgPnlPct > b.avgPnlPct ? a : b);
  console.log(`  ✅ 최적 설정: ${best.label} (EV ${best.avgPnlPct > 0 ? '+' : ''}${best.avgPnlPct}%/건, 승률 ${best.winRate}%, 수익률 ${best.totalReturnPct > 0 ? '+' : ''}${best.totalReturnPct}%)`);
}

main();
