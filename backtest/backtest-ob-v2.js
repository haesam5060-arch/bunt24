/**
 * OB 전략 A/B 백테스트 — 현행 vs 정석(영상 기준)
 *
 * [A] 현행: 음봉+임펄스 OB, SL=OB하단-0.8%, TP=스윙고점 100% 청산
 * [B] 정석: 인걸핑 OB, SL=OB캔들 최저점, TP=고점 50% 청산 + 본절로스
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005; // 0.05%

const CONFIG = {
  initialCapital: 100000,
  maxPositions: 2,
  minOrderAmount: 5000,
  maxHoldCandles: 60,
  cooldownCandles: 6,
  minTpPct: 0.5,
};

// ════════════════════════════════════════════════════
// [A] 현행 OB 감지 — 음봉 후 임펄스 상승
// ════════════════════════════════════════════════════
function detectOB_Current(data) {
  const impulseMinPct = 2;
  const impulseLookback = 6;
  const volumeAvgWindow = 20;
  const obMaxAge = 24;
  const obs = [];

  for (let i = volumeAvgWindow; i < data.length - impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue; // 음봉만

    let maxHigh = 0;
    for (let j = i + 1; j <= i + impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHigh) maxHigh = data[j].high;
    }
    const impulsePct = (maxHigh - c.close) / c.close * 100;
    if (impulsePct < impulseMinPct) continue;

    obs.push({
      index: i,
      top: c.open,        // 음봉 시가
      bottom: c.close,     // 음봉 종가
      swingHigh: maxHigh,
      candleLow: c.low,    // 캔들 최저점 (꼬리 포함)
      used: false,
      maxAge: obMaxAge,
    });
  }
  return obs;
}

// ════════════════════════════════════════════════════
// [B] 정석 OB 감지 — 인걸핑 패턴
// ════════════════════════════════════════════════════
function detectOB_Engulfing(data) {
  const obMaxAge = 24;
  const obs = [];

  for (let i = 1; i < data.length - 1; i++) {
    const prev = data[i - 1];
    const curr = data[i];

    // 강세 인걸핑: 이전=음봉, 현재=양봉, 현재 몸통이 이전 몸통을 감쌈
    if (prev.close < prev.open && curr.close > curr.open) {
      const prevBodyTop = prev.open;
      const prevBodyBot = prev.close;
      const currBodyTop = curr.close;
      const currBodyBot = curr.open;

      if (currBodyTop >= prevBodyTop && currBodyBot <= prevBodyBot) {
        // OB존 = 감싸진 음봉의 몸통
        // 이전 고점 찾기 (pullback 전 고점)
        let prevHigh = 0;
        for (let j = Math.max(0, i - 20); j < i; j++) {
          if (data[j].high > prevHigh) prevHigh = data[j].high;
        }
        // 이후 스윙 고점도 찾기 (6봉 내)
        let afterHigh = 0;
        for (let j = i + 1; j <= i + 6 && j < data.length; j++) {
          if (data[j].high > afterHigh) afterHigh = data[j].high;
        }

        obs.push({
          index: i,
          top: prevBodyTop,       // 감싸진 음봉 시가 (OB 상단)
          bottom: prevBodyBot,    // 감싸진 음봉 종가 (OB 하단)
          candleLow: Math.min(prev.low, curr.low),  // OB 캔들 최저점 (꼬리)
          swingHigh: Math.max(prevHigh, afterHigh),  // 직전 고점
          prevHigh: prevHigh,     // pullback 전 고점 (반익절 타겟)
          used: false,
          maxAge: obMaxAge,
        });
      }
    }
  }
  return obs;
}

// ════════════════════════════════════════════════════
// 시그널 생성 — [A] 현행 (100% 청산)
// ════════════════════════════════════════════════════
function buildSignals_Current(allCoinData) {
  const timeline = {};

  for (const { coin, data, obs } of allCoinData) {
    const cooldowns = {};

    for (let i = 20; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];

      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > ob.maxAge || ob.used) continue;

        // OB 터치
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;

        const entryPrice = Math.max(candle.close, ob.bottom);
        const slPrice = ob.bottom * (1 - 0.8 / 100);  // 현행: OB하단 -0.8%
        const tpPrice = ob.swingHigh;

        // TP 최소 수익률 필터
        const expectedPct = (tpPrice - entryPrice) / entryPrice * 100;
        if (expectedPct < CONFIG.minTpPct) continue;

        // 미래 캔들에서 결과 확인
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
          coin, entryIndex: i, exitIndex,
          entryTime: candle.time, exitTime: data[exitIndex].time,
          entryPrice, exitPrice, tpPrice, slPrice,
          reason: exitReason,
          holdMinutes: (exitIndex - i) * 5,
        });

        ob.used = true;
        cooldowns[coin] = exitIndex + CONFIG.cooldownCandles;
        break;
      }
    }
  }
  return timeline;
}

// ════════════════════════════════════════════════════
// 시그널 생성 — [B] 정석 (50% 반익절 + 본절로스)
// ════════════════════════════════════════════════════
function buildSignals_V2(allCoinData) {
  const timeline = {};

  for (const { coin, data, obs } of allCoinData) {
    const cooldowns = {};

    for (let i = 20; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];

      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > ob.maxAge || ob.used) continue;

        // OB 터치
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;

        const entryPrice = Math.max(candle.close, ob.bottom);
        const slPrice = ob.candleLow;  // 정석: OB 캔들 최저점 (꼬리)
        const tp1Price = ob.prevHigh || ob.swingHigh;  // 이전 고점 (반익절 타겟)

        // TP 최소 수익률 필터
        const expectedPct = (tp1Price - entryPrice) / entryPrice * 100;
        if (expectedPct < CONFIG.minTpPct) continue;

        // SL이 진입가보다 높으면 스킵 (비정상)
        if (slPrice >= entryPrice) continue;

        // 미래 캔들에서 결과 시뮬레이션 (반익절 로직)
        let half1Price = null, half1Reason = null;
        let half2Price = null, half2Reason = null;
        let exitIndex = null;
        let halfDone = false;

        for (let j = i + 1; j < Math.min(i + CONFIG.maxHoldCandles, data.length); j++) {
          if (!halfDone) {
            // Phase 1: 반익절 전
            if (data[j].low <= slPrice) {
              // 전량 손절
              half1Price = slPrice;
              half1Reason = 'SL';
              half2Price = slPrice;
              half2Reason = 'SL';
              exitIndex = j;
              break;
            }
            if (data[j].high >= tp1Price) {
              // 50% 익절 → 본절로스 전환
              half1Price = tp1Price;
              half1Reason = 'TP1';
              halfDone = true;
              // Phase 2 시작: SL을 진입가로 이동 (본절로스)
              continue;
            }
          } else {
            // Phase 2: 반익절 후 — SL=진입가, TP=추세 따라감
            if (data[j].low <= entryPrice) {
              // 본절 청산 (나머지 50%)
              half2Price = entryPrice;
              half2Reason = 'BREAKEVEN';
              exitIndex = j;
              break;
            }
            // 추가 익절: 더 높은 고점 (tp1 * 1.5 또는 최대 보유시간)
            const tp2Price = tp1Price * 1.02;  // 추가 2% 목표
            if (data[j].high >= tp2Price) {
              half2Price = tp2Price;
              half2Reason = 'TP2';
              exitIndex = j;
              break;
            }
          }
        }

        // 시간 초과 처리
        if (!exitIndex) {
          const lastIdx = Math.min(i + CONFIG.maxHoldCandles, data.length - 1);
          exitIndex = lastIdx;
          if (!half1Price) {
            half1Price = data[lastIdx].close;
            half1Reason = 'TIMEOUT';
            half2Price = data[lastIdx].close;
            half2Reason = 'TIMEOUT';
          } else if (!half2Price) {
            half2Price = data[lastIdx].close;
            half2Reason = 'TIMEOUT';
          }
        }

        // 두 반 합산 수익률 계산
        const half1Pct = (half1Price - entryPrice) / entryPrice;
        const half2Pct = (half2Price - entryPrice) / entryPrice;
        const totalNetPct = (half1Pct + half2Pct) / 2 - COMMISSION * 2;  // 평균 수익률
        const combinedReason = halfDone ? `${half1Reason}+${half2Reason}` : half1Reason;

        // 가중 평균 청산가
        const avgExitPrice = (half1Price + half2Price) / 2;

        const timeKey = candle.time;
        if (!timeline[timeKey]) timeline[timeKey] = [];
        timeline[timeKey].push({
          coin, entryIndex: i, exitIndex,
          entryTime: candle.time, exitTime: data[exitIndex].time,
          entryPrice,
          exitPrice: avgExitPrice,
          tpPrice: tp1Price,
          slPrice,
          reason: combinedReason,
          holdMinutes: (exitIndex - i) * 5,
          half1: { price: half1Price, reason: half1Reason },
          half2: { price: half2Price, reason: half2Reason },
        });

        ob.used = true;
        cooldowns[coin] = exitIndex + CONFIG.cooldownCandles;
        break;
      }
    }
  }
  return timeline;
}

// ════════════════════════════════════════════════════
// 포트폴리오 시뮬레이션
// ════════════════════════════════════════════════════
function simulate(timeline) {
  let cash = CONFIG.initialCapital;
  const closedTrades = [];
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

  const active = new Map();

  for (const event of events) {
    const sig = event.signal;
    const key = `${sig.coin}_${sig.entryTime}`;

    if (event.type === 'EXIT') {
      const pos = active.get(key);
      if (!pos) continue;
      const grossPct = (sig.exitPrice - sig.entryPrice) / sig.entryPrice;
      const netPct = grossPct - COMMISSION * 2;
      const pnl = pos.amount * netPct;
      cash += pos.amount + pnl;
      active.delete(key);
      closedTrades.push({
        coin: sig.coin, entryTime: sig.entryTime, exitTime: sig.exitTime,
        entryPrice: sig.entryPrice, exitPrice: +sig.exitPrice.toFixed(2),
        amount: Math.round(pos.amount), pnl: Math.round(pnl),
        netPct: +(netPct * 100).toFixed(3), reason: sig.reason,
        holdMinutes: sig.holdMinutes,
      });
    }

    if (event.type === 'ENTRY') {
      const hasSame = [...active.values()].some(p => p.coin === sig.coin);
      if (hasSame) continue;
      if (active.size >= CONFIG.maxPositions) continue;
      const slots = CONFIG.maxPositions - active.size;
      const alloc = Math.floor(cash / slots);
      if (alloc < CONFIG.minOrderAmount) continue;
      const invest = Math.min(alloc, cash);
      cash -= invest;
      active.set(key, { coin: sig.coin, entryTime: sig.entryTime, amount: invest });
    }
  }

  // MDD
  let peak = CONFIG.initialCapital, mdd = 0, runCash = CONFIG.initialCapital;
  for (const t of closedTrades) {
    runCash += t.pnl;
    if (runCash > peak) peak = runCash;
    const dd = (peak - runCash) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  const finalEquity = closedTrades.reduce((s, t) => s + t.pnl, 0) + CONFIG.initialCapital;
  return { closedTrades, finalEquity, mdd };
}

// ════════════════════════════════════════════════════
// 결과 요약
// ════════════════════════════════════════════════════
function summarize(label, trades, finalEquity, mdd) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnlPct = trades.length > 0 ? trades.reduce((s, t) => s + t.netPct, 0) / trades.length : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0;
  const totalReturnPct = (finalEquity / CONFIG.initialCapital - 1) * 100;

  const dailyPnl = {};
  trades.forEach(t => {
    const date = t.entryTime.slice(0, 10);
    if (!dailyPnl[date]) dailyPnl[date] = { pnl: 0, trades: 0 };
    dailyPnl[date].pnl += t.pnl;
    dailyPnl[date].trades++;
  });
  const days = Object.keys(dailyPnl);
  const profitDays = days.filter(d => dailyPnl[d].pnl > 0).length;
  const dailyAvg = days.length > 0 ? totalReturnPct / days.length : 0;

  // reason 분포
  const reasons = {};
  trades.forEach(t => {
    const r = t.reason.includes('+') ? t.reason : t.reason;
    reasons[r] = (reasons[r] || 0) + 1;
  });

  return {
    label, totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
    totalPnl, totalReturnPct: +totalReturnPct.toFixed(1),
    avgPnlPct: +avgPnlPct.toFixed(3),
    avgWinPct: +avgWinPct.toFixed(3),
    avgLossPct: +avgLossPct.toFixed(3),
    avgHold: +avgHold.toFixed(0),
    mdd: +mdd.toFixed(2),
    days: days.length, profitDays,
    dailyAvg: +dailyAvg.toFixed(2),
    finalEquity,
    reasons,
  };
}

// ════════════════════════════════════════════════════
// 메인
// ════════════════════════════════════════════════════
function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f =>
    f.endsWith('.json') && !['BTC.json', 'ETH.json', 'USDT.json'].includes(f)
  );

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  OB 전략 A/B 백테스트 — 현행 vs 정석(인걸핑+반익절)');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  코인: ${files.length}개 | 최대포지션: ${CONFIG.maxPositions}개 | 시드: ${CONFIG.initialCapital.toLocaleString()}원\n`);

  // 데이터 로드
  const allData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const rawData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    const data = rawData.map(c => ({
      time: c.time || c.candle_date_time_kst,
      open: c.open || c.opening_price,
      high: c.high || c.high_price,
      low: c.low || c.low_price,
      close: c.close || c.trade_price,
      volume: c.volume || c.candle_acc_trade_volume,
    })).sort((a, b) => a.time.localeCompare(b.time));

    if (data.length < 100) continue;
    allData.push({ coin, data });
  }

  // ── [A] 현행 전략 ──
  console.log('  [A] 현행 전략 (음봉+임펄스, SL=-0.8%, TP=스윙고점 100%)');
  const coinDataA = allData.map(({ coin, data }) => {
    const obs = detectOB_Current(data);
    console.log(`    ${coin}: ${obs.length}개 OB`);
    return { coin, data, obs };
  });
  const timelineA = buildSignals_Current(coinDataA);
  const sigCountA = Object.values(timelineA).reduce((s, a) => s + a.length, 0);
  console.log(`    → 총 ${sigCountA}개 시그널`);
  const resultA = simulate(timelineA);
  const summaryA = summarize('[A] 현행', resultA.closedTrades, resultA.finalEquity, resultA.mdd);

  // ── [B] 정석 전략 ──
  console.log(`\n  [B] 정석 전략 (인걸핑 OB, SL=캔들저점, TP=고점 50%+본절로스)`);
  const coinDataB = allData.map(({ coin, data }) => {
    const obs = detectOB_Engulfing(data);
    console.log(`    ${coin}: ${obs.length}개 OB`);
    return { coin, data, obs };
  });
  const timelineB = buildSignals_V2(coinDataB);
  const sigCountB = Object.values(timelineB).reduce((s, a) => s + a.length, 0);
  console.log(`    → 총 ${sigCountB}개 시그널`);
  const resultB = simulate(timelineB);
  const summaryB = summarize('[B] 정석', resultB.closedTrades, resultB.finalEquity, resultB.mdd);

  // ── 비교 출력 ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  📊 A/B 비교 결과');
  console.log(`${'═'.repeat(70)}`);

  const headers = ['', '거래수', '승률', '총수익', '수익률', 'EV/건', '평균승', '평균패', 'MDD', '보유(분)', '일수익'];
  console.log(`  ${headers.map((h, i) => i === 0 ? h.padEnd(16) : h.padStart(8)).join('')}`);
  console.log(`  ${'─'.repeat(66)}`);

  for (const s of [summaryA, summaryB]) {
    const cols = [
      s.label.padEnd(16),
      String(s.totalTrades).padStart(8),
      (s.winRate + '%').padStart(8),
      ((s.totalPnl > 0 ? '+' : '') + s.totalPnl.toLocaleString()).padStart(8),
      ((s.totalReturnPct > 0 ? '+' : '') + s.totalReturnPct + '%').padStart(8),
      ((s.avgPnlPct > 0 ? '+' : '') + s.avgPnlPct + '%').padStart(8),
      ('+' + s.avgWinPct + '%').padStart(8),
      (s.avgLossPct + '%').padStart(8),
      ('-' + s.mdd + '%').padStart(8),
      (s.avgHold + '분').padStart(8),
      ((s.dailyAvg > 0 ? '+' : '') + s.dailyAvg + '%').padStart(8),
    ];
    console.log(`  ${cols.join('')}`);
  }

  // 청산 사유 분포
  console.log(`\n  청산 사유 분포:`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  [A] 현행: ${JSON.stringify(summaryA.reasons)}`);
  console.log(`  [B] 정석: ${JSON.stringify(summaryB.reasons)}`);

  // 승패 분석
  console.log(`\n  승/패 분석:`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  [A] 현행: ${summaryA.wins}승 ${summaryA.losses}패 | 승시 평균 +${summaryA.avgWinPct}% | 패시 평균 ${summaryA.avgLossPct}%`);
  console.log(`  [B] 정석: ${summaryB.wins}승 ${summaryB.losses}패 | 승시 평균 +${summaryB.avgWinPct}% | 패시 평균 ${summaryB.avgLossPct}%`);

  // 손익비
  const rrA = summaryA.avgLossPct !== 0 ? Math.abs(summaryA.avgWinPct / summaryA.avgLossPct) : 0;
  const rrB = summaryB.avgLossPct !== 0 ? Math.abs(summaryB.avgWinPct / summaryB.avgLossPct) : 0;
  console.log(`\n  손익비: [A] 1:${rrA.toFixed(2)} | [B] 1:${rrB.toFixed(2)}`);

  // 코인별 성과
  for (const { label, trades } of [
    { label: '[A] 현행', trades: resultA.closedTrades },
    { label: '[B] 정석', trades: resultB.closedTrades },
  ]) {
    const byCoin = {};
    trades.forEach(t => {
      if (!byCoin[t.coin]) byCoin[t.coin] = { trades: 0, pnl: 0, wins: 0 };
      byCoin[t.coin].trades++;
      byCoin[t.coin].pnl += t.pnl;
      if (t.pnl > 0) byCoin[t.coin].wins++;
    });
    console.log(`\n  ${label} 코인별 (수익순):`);
    console.log(`  ${'─'.repeat(50)}`);
    Object.entries(byCoin)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, 10)
      .forEach(([coin, s]) => {
        const wr = (s.wins / s.trades * 100).toFixed(0);
        console.log(`    ${coin.padEnd(8)} ${String(s.trades).padStart(3)}건  승률 ${wr.padStart(3)}%  ${s.pnl > 0 ? '+' : ''}${s.pnl.toLocaleString()}원`);
      });
  }

  // 최종 결론
  console.log(`\n${'═'.repeat(70)}`);
  const better = summaryA.avgPnlPct > summaryB.avgPnlPct ? summaryA : summaryB;
  const worse = better === summaryA ? summaryB : summaryA;
  console.log(`  ✅ 결론: ${better.label}이 EV/건 ${better.avgPnlPct}% vs ${worse.avgPnlPct}%로 우세`);
  console.log(`     총수익 ${better.label}: ${better.totalPnl > 0 ? '+' : ''}${better.totalPnl.toLocaleString()}원 vs ${worse.label}: ${worse.totalPnl > 0 ? '+' : ''}${worse.totalPnl.toLocaleString()}원`);
  console.log(`${'═'.repeat(70)}\n`);

  // 결과 저장
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'backtest-ob-v2.json'),
    JSON.stringify({ summaryA, summaryB, tradesA: resultA.closedTrades, tradesB: resultB.closedTrades }, null, 2)
  );
}

main();
