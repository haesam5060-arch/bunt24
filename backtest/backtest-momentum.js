/**
 * 모멘텀 필터 백테스트
 *
 * 비교 시나리오:
 * A) 기존 OB (현재 설정 그대로)
 * B) OB + 500원 최소 가격 필터
 * C) OB + 모멘텀 필터 (전일대비 상승 코인만)
 * D) OB + 모멘텀 + 500원 필터
 * E~J) 모멘텀 임계값 변화 (0%, +1%, +2%, +3%, +5%, 상위N개)
 * K~N) 5분봉 + 모멘텀 시나리오
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR_1M = path.join(__dirname, '..', 'data', 'candles-1m');
const DATA_DIR_5M = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005; // 매수/매도 각 0.05%

// ── 데이터 로드 ──
function loadAllData(dir, minPrice = 0) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const allData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file)));
    if (raw.length < 500) continue;
    // 최소 가격 필터: 평균 가격이 minPrice 이상인 코인만
    if (minPrice > 0) {
      const sample = raw.slice(-200);
      const avgPrice = sample.reduce((s, c) => s + c.close, 0) / sample.length;
      if (avgPrice < minPrice) continue;
    }
    allData.push({ coin, data: raw });
  }
  return allData;
}

// ── OB 감지 ──
function detectOB(data, cfg) {
  const obs = [];
  for (let i = cfg.volumeAvgWindow; i < data.length - cfg.impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue;

    // 거래량 필터
    if (cfg.volumeMultiplier > 1) {
      let volSum = 0;
      for (let j = i - cfg.volumeAvgWindow; j < i; j++) volSum += data[j].volume;
      const avgVol = volSum / cfg.volumeAvgWindow;
      if (c.volume < avgVol * cfg.volumeMultiplier) continue;
    }

    let maxHigh = 0;
    for (let j = i + 1; j <= i + cfg.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHigh) maxHigh = data[j].high;
    }
    const imp = (maxHigh - c.close) / c.close * 100;
    if (imp < cfg.impulseMinPct) continue;
    obs.push({ index: i, top: c.open, bottom: c.close, swingHigh: maxHigh, impulsePct: imp, used: false });
  }
  return obs;
}

// ── 24시간 변화율 계산 (캔들 기반) ──
function calcDailyChange(data, idx, candleMinute) {
  const barsIn24h = Math.floor(24 * 60 / candleMinute);
  if (idx < barsIn24h) return 0;
  const prev = data[idx - barsIn24h].close;
  const curr = data[idx].close;
  return (curr - prev) / prev * 100;
}

// ── MA 체크 ──
function checkMA(data, idx, maBars) {
  if (maBars <= 0 || idx < maBars) return true;
  let sum = 0;
  for (let j = idx - maBars; j < idx; j++) sum += data[j].close;
  return data[idx].close >= sum / maBars;
}

// ── 메인 백테스트 엔진 ──
function runBacktest(allData, cfg) {
  const candleMin = cfg.candleMinute || 1;

  // 이벤트 타임라인 생성
  const events = [];
  for (const { coin, data } of allData) {
    const obs = detectOB(data, cfg);
    for (let i = 0; i < data.length; i++) {
      const dailyChg = calcDailyChange(data, i, candleMin);
      events.push({ time: data[i].time, coin, idx: i, candle: data[i], obs, dailyChg });
    }
  }
  events.sort((a, b) => a.time.localeCompare(b.time));

  const positions = [];
  const trades = [];
  let cash = cfg.initialCapital;
  const cooldowns = {};
  const usedOBs = new Set();

  for (const ev of events) {
    const { coin, idx, candle, obs, dailyChg } = ev;
    const price = candle.close;

    // ── 청산 체크 ──
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      if (pos.coin !== coin) continue;
      const holdBars = idx - pos.entryIdx;
      if (candle.high > pos.highSinceEntry) pos.highSinceEntry = candle.high;

      let exitReason = null, exitPrice = price;

      // TP
      if (candle.high >= pos.tpPrice) {
        exitReason = 'TP'; exitPrice = pos.tpPrice;
      }
      // 트레일링
      if (!exitReason && cfg.trailActivatePct > 0) {
        const gain = (pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100;
        if (gain >= cfg.trailActivatePct) {
          const trailStop = pos.highSinceEntry * (1 - cfg.trailPct / 100);
          if (candle.low <= trailStop) {
            exitReason = 'TRAIL'; exitPrice = trailStop;
          }
        }
      }
      // SL
      if (!exitReason && candle.low <= pos.slPrice) {
        exitReason = 'SL'; exitPrice = pos.slPrice;
      }
      // TIMEOUT
      if (!exitReason && holdBars >= cfg.maxHoldBars) {
        exitReason = 'TIMEOUT'; exitPrice = price;
      }

      if (exitReason) {
        const netExit = exitPrice * (1 - COMMISSION); // 매도 수수료
        const pnl = (netExit - pos.entryPrice) / pos.entryPrice * pos.amount;
        cash += pos.amount + pnl;
        trades.push({
          coin, entryPrice: pos.entryPrice, exitPrice, reason: exitReason,
          pnl, holdBars, pnlPct: (netExit - pos.entryPrice) / pos.entryPrice * 100,
          time: candle.time, dailyChgAtEntry: pos.dailyChgAtEntry,
        });
        positions.splice(pi, 1);
        cooldowns[coin] = idx + cfg.cooldownBars;
      }
    }

    // ── 진입 체크 ──
    if (positions.length >= cfg.maxPositions) continue;
    if (positions.some(p => p.coin === coin)) continue;
    if (cooldowns[coin] && idx < cooldowns[coin]) continue;

    // 모멘텀 필터
    if (cfg.minDailyChg !== undefined && dailyChg < cfg.minDailyChg) continue;
    if (cfg.maxDailyChg !== undefined && dailyChg > cfg.maxDailyChg) continue;

    // MA 필터
    const allCoinData = allData.find(d => d.coin === coin)?.data;
    if (!allCoinData) continue;
    if (!checkMA(allCoinData, idx, cfg.maBars || 0)) continue;

    // OB 터치 확인
    const maxAgeIdx = idx - cfg.obMaxAge;
    const activeOBs = obs.filter(o =>
      !o.used && !usedOBs.has(`${coin}_${o.index}`) &&
      o.index >= maxAgeIdx && o.index < idx
    );

    for (const ob of activeOBs) {
      if (price <= ob.top && price >= ob.bottom) {
        const tpPrice = Math.max(ob.swingHigh, price * (1 + cfg.minTpPct / 100));
        const expectedPct = (tpPrice - price) / price * 100;
        if (expectedPct < cfg.minTpPct) continue;

        const availSlots = cfg.maxPositions - positions.length;
        const allocAmount = Math.floor(cash * 0.995 / availSlots);
        if (allocAmount < cfg.minOrderAmount) continue;

        const entryPrice = price * (1 + COMMISSION); // 매수 수수료
        const slPrice = ob.bottom * (1 - cfg.slPct / 100);

        positions.push({
          coin, entryPrice, tpPrice, slPrice,
          amount: allocAmount, entryIdx: idx, highSinceEntry: candle.high,
          dailyChgAtEntry: dailyChg,
        });
        cash -= allocAmount;
        usedOBs.add(`${coin}_${ob.index}`);
        cooldowns[coin] = idx + cfg.cooldownBars;
        break;
      }
    }
  }

  // 미청산 강제 정리
  for (const pos of positions) {
    const coinData = allData.find(d => d.coin === pos.coin)?.data;
    if (coinData) {
      const last = coinData[coinData.length - 1].close;
      const netLast = last * (1 - COMMISSION);
      const pnl = (netLast - pos.entryPrice) / pos.entryPrice * pos.amount;
      trades.push({ coin: pos.coin, reason: 'OPEN', pnl, pnlPct: (netLast - pos.entryPrice) / pos.entryPrice * 100, time: '' });
      cash += pos.amount + pnl;
    }
  }

  // ── 통계 계산 ──
  const closed = trades.filter(t => t.reason !== 'OPEN');
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const tp = closed.filter(t => t.reason === 'TP');
  const trail = closed.filter(t => t.reason === 'TRAIL');
  const sl = closed.filter(t => t.reason === 'SL');
  const to = closed.filter(t => t.reason === 'TIMEOUT');

  const daily = {};
  for (const t of closed) {
    const date = (t.time || '').slice(0, 10);
    if (!daily[date]) daily[date] = { pnl: 0, trades: 0, wins: 0 };
    daily[date].pnl += t.pnl;
    daily[date].trades += 1;
    if (t.pnl > 0) daily[date].wins += 1;
  }
  const days = Object.keys(daily).filter(d => daily[d].trades > 0).length || 1;

  // MDD 계산
  let peak = cfg.initialCapital, equity = cfg.initialCapital, mdd = 0;
  for (const t of closed) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  // 연속 손절
  let maxConsecLoss = 0, consecLoss = 0;
  for (const t of closed) {
    if (t.pnl <= 0) { consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
    else consecLoss = 0;
  }

  const avgHold = closed.length > 0 ? closed.reduce((s, t) => s + (t.holdBars || 0), 0) / closed.length : 0;
  const profitFactor = losses.length > 0 && wins.length > 0
    ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + t.pnl, 0))
    : 0;

  // 코인별 성과
  const coinStats = {};
  for (const t of closed) {
    if (!coinStats[t.coin]) coinStats[t.coin] = { trades: 0, pnl: 0, wins: 0 };
    coinStats[t.coin].trades++;
    coinStats[t.coin].pnl += t.pnl;
    if (t.pnl > 0) coinStats[t.coin].wins++;
  }

  return {
    total: closed.length, tp: tp.length, trail: trail.length, sl: sl.length, timeout: to.length,
    wins: wins.length, losses: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length * 100) : 0,
    totalPnl: Math.round(totalPnl),
    avgWinPct: +avgWin.toFixed(2), avgLossPct: +avgLoss.toFixed(2),
    profitFactor: +profitFactor.toFixed(2),
    avgHoldBars: Math.round(avgHold),
    tradesPerDay: +(closed.length / days).toFixed(1),
    dailyPnl: Math.round(totalPnl / days),
    mdd: +mdd.toFixed(2), maxConsecLoss, days, daily, coinStats,
    ev: closed.length > 0 ? +(totalPnl / closed.length).toFixed(0) : 0,
  };
}

// ═══════════════════════════════════════════════════════
// 시나리오 정의
// ═══════════════════════════════════════════════════════

const BASE_1M = {
  candleMinute: 1,
  impulseMinPct: 0.4, impulseLookback: 12, volumeAvgWindow: 30, volumeMultiplier: 1,
  obMaxAge: 90, slPct: 0.5, maxHoldBars: 60, cooldownBars: 1,
  maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
  minTpPct: 2.0, maBars: 0,
  trailActivatePct: 0.8, trailPct: 0.3,
};

const IMPROVED_1M = {
  candleMinute: 1,
  impulseMinPct: 1.5, impulseLookback: 12, volumeAvgWindow: 30, volumeMultiplier: 1.5,
  obMaxAge: 60, slPct: 1.0, maxHoldBars: 90, cooldownBars: 10,
  maxPositions: 2, initialCapital: 100000, minOrderAmount: 5000,
  minTpPct: 3.0, maBars: 0,
  trailActivatePct: 2.0, trailPct: 0.5,
};

const BASE_5M = {
  candleMinute: 5,
  impulseMinPct: 1.5, impulseLookback: 6, volumeAvgWindow: 20, volumeMultiplier: 1.5,
  obMaxAge: 48, slPct: 1.0, maxHoldBars: 36, cooldownBars: 3,
  maxPositions: 2, initialCapital: 100000, minOrderAmount: 5000,
  minTpPct: 2.0, maBars: 0,
  trailActivatePct: 1.5, trailPct: 0.5,
};

const scenarios = [
  // ── 1분봉: 기존 vs 필터 적용 ──
  { name: 'A) 1M 현재설정 (기준선)', ...BASE_1M, minPrice: 0 },
  { name: 'B) 1M + 500원 필터', ...BASE_1M, minPrice: 500 },
  { name: 'C) 1M + 모멘텀>0%', ...BASE_1M, minPrice: 0, minDailyChg: 0 },
  { name: 'D) 1M + 500원 + 모멘텀>0%', ...BASE_1M, minPrice: 500, minDailyChg: 0 },
  { name: 'E) 1M + 500원 + 모멘텀>1%', ...BASE_1M, minPrice: 500, minDailyChg: 1 },
  { name: 'F) 1M + 500원 + 모멘텀>2%', ...BASE_1M, minPrice: 500, minDailyChg: 2 },
  { name: 'G) 1M + 500원 + 모멘텀>3%', ...BASE_1M, minPrice: 500, minDailyChg: 3 },
  { name: 'H) 1M + 500원 + 모멘텀>5%', ...BASE_1M, minPrice: 500, minDailyChg: 5 },
  { name: 'I) 1M + 500원 + 모멘텀0~10%(과열제외)', ...BASE_1M, minPrice: 500, minDailyChg: 0, maxDailyChg: 10 },

  // ── 1분봉: 개선된 설정 + 모멘텀 ──
  { name: 'J) 1M 개선 (imp1.5,SL1,TP3,trail2)', ...IMPROVED_1M, minPrice: 500 },
  { name: 'K) 1M 개선 + 모멘텀>0%', ...IMPROVED_1M, minPrice: 500, minDailyChg: 0 },
  { name: 'L) 1M 개선 + 모멘텀>1%', ...IMPROVED_1M, minPrice: 500, minDailyChg: 1 },
  { name: 'M) 1M 개선 + 모멘텀>2%', ...IMPROVED_1M, minPrice: 500, minDailyChg: 2 },

  // ── 5분봉: 모멘텀 시나리오 ──
  { name: 'N) 5M 기본', ...BASE_5M, minPrice: 500 },
  { name: 'O) 5M + 모멘텀>0%', ...BASE_5M, minPrice: 500, minDailyChg: 0 },
  { name: 'P) 5M + 모멘텀>1%', ...BASE_5M, minPrice: 500, minDailyChg: 1 },
  { name: 'Q) 5M + 모멘텀>2%', ...BASE_5M, minPrice: 500, minDailyChg: 2 },
  { name: 'R) 5M + 모멘텀>3%', ...BASE_5M, minPrice: 500, minDailyChg: 3 },
  { name: 'S) 5M + 모멘텀0~10%', ...BASE_5M, minPrice: 500, minDailyChg: 0, maxDailyChg: 10 },

  // ── 5분봉: R:R 최적화 + 모멘텀 ──
  { name: 'T) 5M SL0.8 TP2 trail1.5/0.5 + 모멘텀>1%', ...BASE_5M, minPrice: 500, slPct: 0.8, minTpPct: 2.0, trailActivatePct: 1.5, trailPct: 0.5, minDailyChg: 1 },
  { name: 'U) 5M SL1.2 TP3 trail2/0.7 + 모멘텀>1%', ...BASE_5M, minPrice: 500, slPct: 1.2, minTpPct: 3.0, trailActivatePct: 2.0, trailPct: 0.7, minDailyChg: 1 },
  { name: 'V) 5M SL1.5 TP4 noTrail + 모멘텀>1%', ...BASE_5M, minPrice: 500, slPct: 1.5, minTpPct: 4.0, trailActivatePct: 0, trailPct: 0, minDailyChg: 1, maxHoldBars: 72 },
];

// ═══════════════════════════════════════════════════════
// 실행
// ═══════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  모멘텀 필터 백테스트 — 전일대비 상승률 기반 진입 필터 검증');
console.log('  수수료: 매수 0.05% + 매도 0.05% = 왕복 0.1% 반영');
console.log('═══════════════════════════════════════════════════════════════════════\n');

// 1분봉, 5분봉 데이터 미리 로드 (가격별)
const data1m_all = loadAllData(DATA_DIR_1M, 0);
const data1m_500 = loadAllData(DATA_DIR_1M, 500);
const data5m_500 = loadAllData(DATA_DIR_5M, 500);

console.log(`1분봉 전체: ${data1m_all.length}개 코인 [${data1m_all.map(d=>d.coin).join(', ')}]`);
console.log(`1분봉 500원↑: ${data1m_500.length}개 코인 [${data1m_500.map(d=>d.coin).join(', ')}]`);
console.log(`5분봉 500원↑: ${data5m_500.length}개 코인 [${data5m_500.map(d=>d.coin).join(', ')}]`);
console.log('');

const header = '시나리오'.padEnd(48) + ' | 거래 | 일평균 | 승률  | TP  | TR  | SL  | TO  |   총손익   |  일손익  | 승%  | 패%  | 손익비 | 보유 | MDD  | 연손 | EV';
console.log(header);
console.log('─'.repeat(header.length + 20));

const results = [];
for (const sc of scenarios) {
  // 적절한 데이터셋 선택
  let data;
  if (sc.candleMinute === 5) {
    data = data5m_500;
  } else {
    data = sc.minPrice >= 500 ? data1m_500 : data1m_all;
  }

  const r = runBacktest(data, sc);
  results.push({ name: sc.name, cfg: sc, result: r });

  const line = [
    sc.name.padEnd(48),
    String(r.total).padStart(4),
    `${r.tradesPerDay}/일`.padStart(6),
    `${r.winRate.toFixed(1)}%`.padStart(5),
    String(r.tp).padStart(4),
    String(r.trail).padStart(4),
    String(r.sl).padStart(4),
    String(r.timeout).padStart(4),
    `${r.totalPnl > 0 ? '+' : ''}${r.totalPnl.toLocaleString()}원`.padStart(10),
    `${r.dailyPnl > 0 ? '+' : ''}${r.dailyPnl.toLocaleString()}원`.padStart(8),
    `${r.avgWinPct > 0 ? '+' : ''}${r.avgWinPct}%`.padStart(6),
    `${r.avgLossPct}%`.padStart(6),
    `${r.profitFactor}`.padStart(5),
    `${r.avgHoldBars}분`.padStart(5),
    `${r.mdd}%`.padStart(5),
    String(r.maxConsecLoss).padStart(3),
    `${r.ev > 0 ? '+' : ''}${r.ev}원`.padStart(6),
  ].join(' | ');
  console.log(line);
}

// ═══════════════════════════════════════════════════════
// 상위 5개 상세 분석
// ═══════════════════════════════════════════════════════
results.sort((a, b) => b.result.totalPnl - a.result.totalPnl);

console.log('\n\n═══════════════════════════════════════════════════════════════════════');
console.log('  상위 5 시나리오 상세 분석');
console.log('═══════════════════════════════════════════════════════════════════════');

for (let ri = 0; ri < Math.min(5, results.length); ri++) {
  const { name, result, cfg } = results[ri];
  console.log(`\n┌─ [${ri + 1}위] ${name}`);
  console.log(`│  총수익: ${result.totalPnl > 0 ? '+' : ''}${result.totalPnl.toLocaleString()}원 | 거래: ${result.total}건 | 승률: ${result.winRate.toFixed(1)}% | PF: ${result.profitFactor} | MDD: ${result.mdd}% | 연속손절: ${result.maxConsecLoss}`);
  console.log(`│  TP: ${result.tp} | TRAIL: ${result.trail} | SL: ${result.sl} | TIMEOUT: ${result.timeout}`);
  console.log(`│  평균 승: +${result.avgWinPct}% | 평균 패: ${result.avgLossPct}% | EV: ${result.ev}원/건`);
  console.log(`│  설정: ${cfg.candleMinute}분봉 | imp${cfg.impulseMinPct}% | SL${cfg.slPct}% | TP${cfg.minTpPct}% | trail${cfg.trailActivatePct}/${cfg.trailPct}% | cool${cfg.cooldownBars} | 모멘텀${cfg.minDailyChg !== undefined ? '>'+cfg.minDailyChg+'%' : '없음'}${cfg.maxDailyChg !== undefined ? ' <'+cfg.maxDailyChg+'%' : ''} | 최소가격${cfg.minPrice || 0}원`);

  // 일별 상세
  console.log('│');
  console.log('│  [일별 손익]');
  const sorted = Object.entries(result.daily).sort(([a], [b]) => a.localeCompare(b));
  for (const [date, d] of sorted) {
    if (d.trades < 1) continue;
    const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(0) : 0;
    const bar = d.pnl >= 0 ? '█'.repeat(Math.min(20, Math.round(d.pnl / 100))) : '▒'.repeat(Math.min(20, Math.round(Math.abs(d.pnl) / 100)));
    console.log(`│  ${date}: ${d.pnl > 0 ? '+' : ''}${Math.round(d.pnl).toLocaleString().padStart(7)}원 (${d.trades}건, 승률${wr}%) ${d.pnl >= 0 ? '🟢' : '🔴'} ${bar}`);
  }

  // 코인별 성과
  console.log('│');
  console.log('│  [코인별 손익]');
  const coinSorted = Object.entries(result.coinStats).sort(([,a], [,b]) => b.pnl - a.pnl);
  for (const [coin, cs] of coinSorted) {
    const wr = cs.trades > 0 ? (cs.wins / cs.trades * 100).toFixed(0) : 0;
    console.log(`│  ${coin.padEnd(7)}: ${cs.pnl > 0 ? '+' : ''}${Math.round(cs.pnl).toLocaleString().padStart(7)}원 (${cs.trades}건, 승률${wr}%)`);
  }
  console.log('└─────────────────────────────────────────────');
}

// ═══════════════════════════════════════════════════════
// 모멘텀 임계값별 비교 요약
// ═══════════════════════════════════════════════════════
console.log('\n\n═══════════════════════════════════════════════════════════════════════');
console.log('  모멘텀 임계값별 비교 요약');
console.log('═══════════════════════════════════════════════════════════════════════');

const momentumResults = results.filter(r => r.name.includes('모멘텀') || r.name.includes('기준선') || r.name.includes('500원'));
for (const { name, result } of momentumResults) {
  const verdict = result.profitFactor >= 1.5 ? '✅ 추천' :
                  result.profitFactor >= 1.0 ? '⚠️ 보통' : '❌ 비추';
  console.log(`${verdict} ${name}: PF ${result.profitFactor} | 승률 ${result.winRate.toFixed(1)}% | 총${result.totalPnl > 0 ? '+' : ''}${result.totalPnl.toLocaleString()}원 | ${result.total}건 | MDD ${result.mdd}%`);
}

console.log('\n[결론]');
const best = results[0];
console.log(`최적 시나리오: ${best.name}`);
console.log(`  → 총수익: ${best.result.totalPnl > 0 ? '+' : ''}${best.result.totalPnl.toLocaleString()}원 | 승률: ${best.result.winRate.toFixed(1)}% | PF: ${best.result.profitFactor} | 거래: ${best.result.total}건 | MDD: ${best.result.mdd}%`);
