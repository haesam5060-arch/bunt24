/**
 * 오더블록(OB) 스캘핑 백테스트 — 포트폴리오 분산투자 버전
 *
 * - 20개 코인 동시 모니터링
 * - 시그널 발생 시 가용 자금을 균등 분배하여 진입
 * - 동시 다수 포지션 보유 가능
 * - 10만원 시드, 수익 재투자 (복리)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005; // 0.05%

const CONFIG = {
  impulseMinPct: 1.5,
  impulseLookback: 6,
  volumeMultiplier: 1.5,
  volumeAvgWindow: 20,
  obMaxAge: 48,
  tpMode: 'swing',
  tpFixedPct: 1.5,
  slPct: 0.3,
  useTrendFilter: true,
  trendMaPeriod: 50,
  maxHoldCandles: 60,
  cooldownCandles: 6,
  // 포트폴리오 설정
  initialCapital: 100000,
  maxPositions: 10,        // 최대 동시 보유 종목 수
  minOrderAmount: 5000,    // 업비트 최소 주문금액
};

// ── 보조 지표 ─────────────────────────────────────
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

// ── OB 감지 ───────────────────────────────────────
function detectOrderBlocks(data, avgVol) {
  const obs = [];
  for (let i = CONFIG.volumeAvgWindow; i < data.length - CONFIG.impulseLookback; i++) {
    const candle = data[i];
    if (candle.close >= candle.open) continue;
    if (avgVol[i] && candle.volume < avgVol[i] * CONFIG.volumeMultiplier) continue;

    let maxHighAfter = 0;
    for (let j = i + 1; j <= i + CONFIG.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHighAfter) maxHighAfter = data[j].high;
    }
    const impulsePct = (maxHighAfter - candle.close) / candle.close * 100;
    if (impulsePct < CONFIG.impulseMinPct) continue;

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

// ── 전 코인 시그널 타임라인 생성 ──────────────────
function buildSignalTimeline(allCoinData) {
  const timeline = {}; // { timeKey: [{ coin, candle, ob, ... }] }

  for (const { coin, data, obs, ma } of allCoinData) {
    const cooldowns = {};

    for (let i = CONFIG.volumeAvgWindow + CONFIG.impulseLookback; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];

      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > CONFIG.obMaxAge || ob.used) continue;

        const touchedOB = candle.low <= ob.top && candle.close >= ob.bottom;
        if (!touchedOB) continue;
        if (CONFIG.useTrendFilter && ma[i] !== null && candle.close < ma[i]) continue;

        const entryPrice = Math.max(candle.close, ob.bottom);
        const slPrice = ob.bottom * (1 - CONFIG.slPct / 100);
        const tpPrice = CONFIG.tpMode === 'swing' ? ob.swingHigh : entryPrice * (1 + CONFIG.tpFixedPct / 100);

        // 미래 캔들에서 TP/SL 확인
        let exitPrice = null, exitReason = null, exitIndex = null;
        for (let j = i + 1; j < Math.min(i + CONFIG.maxHoldCandles, data.length); j++) {
          if (data[j].low <= slPrice) { exitPrice = slPrice; exitReason = 'SL'; exitIndex = j; break; }
          if (data[j].high >= tpPrice) { exitPrice = tpPrice; exitReason = 'TP'; exitIndex = j; break; }
        }
        if (!exitPrice) {
          const lastIdx = Math.min(i + CONFIG.maxHoldCandles, data.length - 1);
          exitPrice = data[lastIdx].close;
          exitReason = 'TIMEOUT';
          exitIndex = lastIdx;
        }

        const timeKey = candle.time;
        if (!timeline[timeKey]) timeline[timeKey] = [];
        timeline[timeKey].push({
          coin,
          entryIndex: i,
          exitIndex,
          entryTime: candle.time,
          exitTime: data[exitIndex].time,
          entryPrice,
          exitPrice,
          tpPrice,
          slPrice,
          reason: exitReason,
          holdMinutes: (exitIndex - i) * 5,
          impulsePct: ob.impulsePct,
        });

        ob.used = true;
        cooldowns[coin] = exitIndex + CONFIG.cooldownCandles;
        break;
      }
    }
  }

  return timeline;
}

// ── 포트폴리오 시뮬레이션 ─────────────────────────
function simulatePortfolio(timeline) {
  let cash = CONFIG.initialCapital;
  const positions = []; // { coin, entryTime, exitTime, entryPrice, exitPrice, amount, reason, ... }
  const closedTrades = [];
  const equityCurve = [];

  // 모든 시간 키를 정렬
  const allTimes = Object.keys(timeline).sort();

  // 모든 이벤트 (진입 + 청산)을 시간순으로 처리
  const events = [];

  // 진입 이벤트
  for (const time of allTimes) {
    for (const sig of timeline[time]) {
      events.push({ type: 'ENTRY', time: sig.entryTime, signal: sig });
      events.push({ type: 'EXIT', time: sig.exitTime, signal: sig });
    }
  }

  events.sort((a, b) => {
    if (a.time !== b.time) return a.time.localeCompare(b.time);
    // 청산을 진입보다 먼저 처리 (자금 확보)
    return a.type === 'EXIT' ? -1 : 1;
  });

  const activePositions = new Map(); // key = coin+entryTime

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
        coin: sig.coin,
        entryTime: sig.entryTime,
        exitTime: sig.exitTime,
        entryPrice: sig.entryPrice,
        exitPrice: sig.exitPrice,
        amount: Math.round(pos.amount),
        pnl: Math.round(pnl),
        netPct: +(netPct * 100).toFixed(3),
        reason: sig.reason,
        holdMinutes: sig.holdMinutes,
      });

      // 자산 기록
      const totalEquity = cash + [...activePositions.values()].reduce((s, p) => s + p.amount, 0);
      equityCurve.push({ time: sig.exitTime, equity: Math.round(totalEquity), event: 'EXIT', coin: sig.coin });
    }

    if (event.type === 'ENTRY') {
      // 이미 같은 코인 포지션 있으면 스킵
      const hasSameCoin = [...activePositions.values()].some(p => p.coin === sig.coin);
      if (hasSameCoin) continue;

      // 최대 포지션 수 체크
      if (activePositions.size >= CONFIG.maxPositions) continue;

      // 가용 자금으로 균등 분배
      const availSlots = CONFIG.maxPositions - activePositions.size;
      const allocAmount = Math.floor(cash / availSlots);

      if (allocAmount < CONFIG.minOrderAmount) continue;

      const investAmount = Math.min(allocAmount, cash);
      cash -= investAmount;

      activePositions.set(key, {
        coin: sig.coin,
        entryTime: sig.entryTime,
        amount: investAmount,
      });

      const totalEquity = cash + [...activePositions.values()].reduce((s, p) => s + p.amount, 0);
      equityCurve.push({ time: sig.entryTime, equity: Math.round(totalEquity), event: 'ENTRY', coin: sig.coin });
    }
  }

  return { closedTrades, equityCurve, finalCash: cash, remainingPositions: activePositions.size };
}

// ── 결과 분석 ─────────────────────────────────────
function analyzeResults(trades, equityCurve) {
  if (trades.length === 0) { console.log('거래 없음'); return; }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnlPct = trades.reduce((s, t) => s + t.netPct, 0) / trades.length;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgHold = trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length;

  // 일별 수익
  const dailyPnl = {};
  trades.forEach(t => {
    const date = t.entryTime.slice(0, 10);
    if (!dailyPnl[date]) dailyPnl[date] = { pnl: 0, trades: 0 };
    dailyPnl[date].pnl += t.pnl;
    dailyPnl[date].trades++;
  });
  const days = Object.keys(dailyPnl).sort();
  const profitDays = days.filter(d => dailyPnl[d].pnl > 0).length;

  // MDD 계산 (자산 기준)
  let peak = CONFIG.initialCapital, mdd = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : CONFIG.initialCapital;
  const totalReturnPct = (finalEquity / CONFIG.initialCapital - 1) * 100;
  const dailyAvgPct = days.length > 0 ? totalReturnPct / days.length : 0;

  // 동시 보유 최대 수
  let maxConcurrent = 0, concurrent = 0;
  const posEvents = [];
  trades.forEach(t => {
    posEvents.push({ time: t.entryTime, delta: 1 });
    posEvents.push({ time: t.exitTime, delta: -1 });
  });
  posEvents.sort((a, b) => a.time.localeCompare(b.time));
  posEvents.forEach(e => {
    concurrent += e.delta;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
  });

  console.log('\n════════════════════════════════════════════════════');
  console.log('  OB 스캘핑 백테스트 — 포트폴리오 분산투자');
  console.log('════════════════════════════════════════════════════');
  console.log(`  기간: ${trades[0].entryTime.slice(0, 10)} ~ ${trades[trades.length - 1].entryTime.slice(0, 10)}`);
  console.log(`  시드: ${CONFIG.initialCapital.toLocaleString()}원`);
  console.log(`  최대 동시보유: ${CONFIG.maxPositions}종목 (실제 최대: ${maxConcurrent}종목)`);
  console.log('────────────────────────────────────────────────────');
  console.log(`  총 거래: ${trades.length}회`);
  console.log(`  승률: ${(wins.length / trades.length * 100).toFixed(1)}% (${wins.length}승 ${losses.length}패)`);
  console.log(`  TP/SL/TO: ${trades.filter(t=>t.reason==='TP').length} / ${trades.filter(t=>t.reason==='SL').length} / ${trades.filter(t=>t.reason==='TIMEOUT').length}`);
  console.log('────────────────────────────────────────────────────');
  console.log(`  총 수익: ${totalPnl > 0 ? '+' : ''}${totalPnl.toLocaleString()}원`);
  console.log(`  총 수익률: ${totalReturnPct > 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%`);
  console.log(`  평균 수익률/건: ${avgPnlPct > 0 ? '+' : ''}${avgPnlPct.toFixed(3)}%`);
  console.log(`  평균 수익(승): +${avgWinPct.toFixed(3)}%`);
  console.log(`  평균 손실(패): ${avgLossPct.toFixed(3)}%`);
  console.log(`  손익비: 1:${Math.abs(avgWinPct / avgLossPct).toFixed(2)}`);
  console.log(`  평균 보유: ${avgHold.toFixed(0)}분`);
  console.log('────────────────────────────────────────────────────');
  console.log(`  일평균 수익률: ${dailyAvgPct > 0 ? '+' : ''}${dailyAvgPct.toFixed(2)}%`);
  console.log(`  수익일: ${profitDays}/${days.length}일 (${(profitDays / days.length * 100).toFixed(0)}%)`);
  console.log(`  MDD: -${mdd.toFixed(2)}%`);
  console.log('────────────────────────────────────────────────────');
  console.log(`  💰 ${CONFIG.initialCapital.toLocaleString()}원 → ${finalEquity.toLocaleString()}원 (${totalReturnPct > 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%)`);
  console.log('════════════════════════════════════════════════════');

  // 코인별 성과
  const byCoin = {};
  trades.forEach(t => {
    if (!byCoin[t.coin]) byCoin[t.coin] = { trades: 0, pnl: 0, wins: 0, amount: 0 };
    byCoin[t.coin].trades++;
    byCoin[t.coin].pnl += t.pnl;
    byCoin[t.coin].amount += t.amount;
    if (t.pnl > 0) byCoin[t.coin].wins++;
  });

  console.log('\n  코인별 성과 (수익순):');
  console.log('  ──────────────────────────────────────────────');
  Object.entries(byCoin)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .forEach(([coin, s]) => {
      const wr = (s.wins / s.trades * 100).toFixed(0);
      console.log(`  ${coin.padEnd(8)} ${String(s.trades).padStart(3)}건  승률 ${wr.padStart(3)}%  수익 ${s.pnl > 0 ? '+' : ''}${s.pnl.toLocaleString()}원`);
    });

  // 일별 수익
  console.log('\n  일별 손익:');
  console.log('  ──────────────────────────────────────────────');
  let cumPnl = 0;
  days.forEach(d => {
    const dp = dailyPnl[d];
    cumPnl += dp.pnl;
    const bar = dp.pnl > 0
      ? '█'.repeat(Math.min(Math.ceil(dp.pnl / 1000), 30))
      : '░'.repeat(Math.min(Math.ceil(-dp.pnl / 1000), 30));
    console.log(`  ${d}  ${dp.trades.toString().padStart(2)}건  ${dp.pnl > 0 ? '+' : ''}${dp.pnl.toLocaleString().padStart(8)}원  누적 ${cumPnl > 0 ? '+' : ''}${cumPnl.toLocaleString().padStart(8)}원  ${dp.pnl > 0 ? '🟢' : '🔴'} ${bar}`);
  });

  // 시간대별 성과
  const byHour = {};
  trades.forEach(t => {
    const hour = t.entryTime.slice(11, 13);
    if (!byHour[hour]) byHour[hour] = { trades: 0, pnl: 0, wins: 0 };
    byHour[hour].trades++;
    byHour[hour].pnl += t.pnl;
    if (t.pnl > 0) byHour[hour].wins++;
  });

  console.log('\n  시간대별 성과:');
  console.log('  ──────────────────────────────────────────────');
  Object.keys(byHour).sort().forEach(h => {
    const s = byHour[h];
    const wr = (s.wins / s.trades * 100).toFixed(0);
    console.log(`  ${h}시  ${String(s.trades).padStart(3)}건  승률 ${wr.padStart(3)}%  ${s.pnl > 0 ? '+' : ''}${s.pnl.toLocaleString()}원`);
  });

  return { totalPnl, totalReturnPct, finalEquity, mdd, dailyAvgPct };
}

// ── 메인 ──────────────────────────────────────────
function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && f !== 'BTC.json');
  console.log(`\n${files.length}개 코인 동시 모니터링 포트폴리오 백테스트`);
  console.log(`시드: ${CONFIG.initialCapital.toLocaleString()}원, 최대 ${CONFIG.maxPositions}종목 동시 보유\n`);

  const allCoinData = [];

  for (const file of files) {
    const coin = file.replace('.json', '');
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    if (data.length < 100) continue;

    const ma = calcMA(data, CONFIG.trendMaPeriod);
    const avgVol = calcAvgVolume(data, CONFIG.volumeAvgWindow);
    const obs = detectOrderBlocks(data, avgVol);

    console.log(`  ${coin}: ${obs.length}개 OB 감지, ${data.length}개 캔들`);
    allCoinData.push({ coin, data, obs, ma });
  }

  console.log('\n시그널 타임라인 생성...');
  const timeline = buildSignalTimeline(allCoinData);
  const totalSignals = Object.values(timeline).reduce((s, arr) => s + arr.length, 0);
  console.log(`총 ${totalSignals}개 시그널\n`);

  console.log('포트폴리오 시뮬레이션...');
  const { closedTrades, equityCurve, finalCash, remainingPositions } = simulatePortfolio(timeline);

  analyzeResults(closedTrades, equityCurve);

  // 결과 저장
  const resultPath = path.join(__dirname, '..', 'data', 'backtest-portfolio.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    config: CONFIG,
    trades: closedTrades,
    equityCurve,
    summary: { finalCash, remainingPositions, totalTrades: closedTrades.length }
  }, null, 2));
  console.log(`\n상세 결과: ${resultPath}`);
}

main();
