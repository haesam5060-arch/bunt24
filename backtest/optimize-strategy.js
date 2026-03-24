/**
 * 전략 최적화 백테스트 — 실전 데이터 기반
 *
 * 목표: 상승/하락/횡보 모든 장에서 박스권 스캘핑
 * 문제점 진단:
 *   1) 승률 35% → 손익비 0.81 (마이너스 확정 구조)
 *   2) 거래량 17건/일 (스캘핑치고 적음)
 *   3) TIMEOUT 3건 = 300분 묶여서 기회비용 낭비
 *   4) ATH -3.57% 한 건이 전체 수익 파괴
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005; // 업비트 0.05%

// ── 데이터 로드 ──
function loadAllData() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const allData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    if (['BTC', 'ETH', 'USDT', 'CTC', 'ETC'].includes(coin)) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    if (raw.length < 200) continue;
    allData.push({ coin, data: raw });
  }
  return allData;
}

// ── OB 감지 ──
function detectOB(data, cfg) {
  const obs = [];
  for (let i = cfg.volumeAvgWindow; i < data.length - cfg.impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue; // 음봉만

    let maxHigh = 0;
    for (let j = i + 1; j <= i + cfg.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHigh) maxHigh = data[j].high;
    }
    const imp = (maxHigh - c.close) / c.close * 100;
    if (imp < cfg.impulseMinPct) continue;

    obs.push({
      index: i, top: c.open, bottom: c.close,
      swingHigh: maxHigh, impulsePct: imp, used: false
    });
  }
  return obs;
}

// ── 1H 추세 필터 (5분봉 12개 = 1시간) ──
function check1HTrend(data, idx, trendBars) {
  if (trendBars <= 0) return true; // 비활성화
  if (idx < trendBars) return true;

  let maSum = 0;
  for (let j = idx - trendBars; j < idx; j++) maSum += data[j].close;
  const ma = maSum / trendBars;
  return data[idx].close >= ma;
}

// ── 트레일링 스탑 로직 ──
function calcTrailingStop(entryPrice, highSinceEntry, trailActivatePct, trailPct) {
  if (trailActivatePct <= 0 || trailPct <= 0) return 0;
  const gain = (highSinceEntry - entryPrice) / entryPrice * 100;
  if (gain >= trailActivatePct) {
    return highSinceEntry * (1 - trailPct / 100);
  }
  return 0;
}

// ── 메인 백테스트 엔진 ──
function runBacktest(allData, cfg) {
  // 타임라인 구축 (모든 코인의 모든 봉을 시간순 정렬)
  const events = [];
  for (const { coin, data } of allData) {
    const obs = detectOB(data, cfg);
    for (let i = 0; i < data.length; i++) {
      events.push({ time: data[i].time, coin, idx: i, candle: data[i], obs });
    }
  }
  events.sort((a, b) => a.time.localeCompare(b.time));

  const positions = [];
  const trades = [];
  let cash = cfg.initialCapital;
  const cooldowns = {};
  const usedOBs = new Set();

  for (const ev of events) {
    const { coin, idx, candle, obs } = ev;
    const price = candle.close;

    // ── 청산 체크 ──
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      if (pos.coin !== coin) continue;

      const holdBars = idx - pos.entryIdx;

      // 최고가 추적
      if (candle.high > pos.highSinceEntry) {
        pos.highSinceEntry = candle.high;
      }

      let exitReason = null;
      let exitPrice = price;

      // TP 도달 (고가 기준)
      if (candle.high >= pos.tpPrice) {
        exitReason = 'TP';
        exitPrice = pos.tpPrice;
      }
      // 트레일링 스탑
      else if (cfg.trailActivatePct > 0) {
        const trailStop = calcTrailingStop(pos.entryPrice, pos.highSinceEntry, cfg.trailActivatePct, cfg.trailPct);
        if (trailStop > 0 && candle.low <= trailStop) {
          exitReason = 'TRAIL';
          exitPrice = trailStop;
        }
      }
      // SL (저가 기준)
      if (!exitReason && candle.low <= pos.slPrice) {
        exitReason = 'SL';
        exitPrice = pos.slPrice;
      }
      // TIMEOUT
      if (!exitReason && holdBars >= cfg.maxHoldCandles) {
        exitReason = 'TIMEOUT';
        exitPrice = price;
      }

      if (exitReason) {
        const sellAmount = pos.amount * (1 - COMMISSION);
        const pnl = (exitPrice - pos.entryPrice) / pos.entryPrice * sellAmount;
        cash += sellAmount + pnl;

        trades.push({
          coin, entryPrice: pos.entryPrice, exitPrice,
          reason: exitReason, pnl, holdBars,
          pnlPct: (exitPrice - pos.entryPrice) / pos.entryPrice * 100,
          time: candle.time,
        });

        positions.splice(pi, 1);
        cooldowns[coin] = idx + cfg.cooldownCandles;
      }
    }

    // ── 진입 체크 ──
    if (positions.length >= cfg.maxPositions) continue;
    if (positions.some(p => p.coin === coin)) continue;
    if (cooldowns[coin] && idx < cooldowns[coin]) continue;

    // 1H 추세 필터
    const allCoinData = allData.find(d => d.coin === coin)?.data;
    if (!allCoinData) continue;
    if (!check1HTrend(allCoinData, idx, cfg.trendBars)) continue;

    // 활성 OB 확인
    const maxAgeIdx = idx - cfg.obMaxAge;
    const activeOBs = obs.filter(o =>
      !o.used && !usedOBs.has(`${coin}_${o.index}`) &&
      o.index >= maxAgeIdx && o.index < idx
    );

    for (const ob of activeOBs) {
      if (price <= ob.top && price >= ob.bottom) {
        // minTpPct 필터
        const expectedPct = (ob.swingHigh - price) / price * 100;
        if (expectedPct < cfg.minTpPct) continue;

        const availSlots = cfg.maxPositions - positions.length;
        const allocAmount = Math.floor(cash * 0.995 / availSlots);
        if (allocAmount < cfg.minOrderAmount) continue;

        const entryPrice = price * (1 + COMMISSION);
        const slPrice = ob.bottom * (1 - cfg.slPct / 100);
        const tpPrice = ob.swingHigh;

        positions.push({
          coin, entryPrice, tpPrice, slPrice,
          amount: allocAmount, entryIdx: idx,
          highSinceEntry: candle.high,
        });

        cash -= allocAmount;
        usedOBs.add(`${coin}_${ob.index}`);
        cooldowns[coin] = idx + cfg.cooldownCandles;
        break;
      }
    }
  }

  // 미청산 포지션 강제 청산
  for (const pos of positions) {
    const coinData = allData.find(d => d.coin === pos.coin)?.data;
    if (coinData) {
      const lastPrice = coinData[coinData.length - 1].close;
      const pnl = (lastPrice - pos.entryPrice) / pos.entryPrice * pos.amount;
      trades.push({
        coin: pos.coin, entryPrice: pos.entryPrice, exitPrice: lastPrice,
        reason: 'OPEN', pnl, holdBars: 0,
        pnlPct: (lastPrice - pos.entryPrice) / pos.entryPrice * 100,
      });
      cash += pos.amount + pnl;
    }
  }

  // ── 결과 집계 ──
  const closedTrades = trades.filter(t => t.reason !== 'OPEN');
  const tp = closedTrades.filter(t => t.reason === 'TP' || t.reason === 'TRAIL');
  const sl = closedTrades.filter(t => t.reason === 'SL');
  const to = closedTrades.filter(t => t.reason === 'TIMEOUT');
  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);

  const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  // 일별 집계
  const daily = {};
  for (const t of closedTrades) {
    const date = (t.time || '').slice(0, 10);
    if (!daily[date]) daily[date] = { pnl: 0, trades: 0 };
    daily[date].pnl += t.pnl;
    daily[date].trades += t.pnl !== undefined ? 1 : 0;
  }
  const days = Object.keys(daily).length || 1;

  // MDD 계산
  let peak = cfg.initialCapital;
  let equity = cfg.initialCapital;
  let mdd = 0;
  for (const t of closedTrades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  const avgHold = closedTrades.length > 0
    ? closedTrades.reduce((s, t) => s + (t.holdBars || 0), 0) / closedTrades.length
    : 0;

  return {
    total: closedTrades.length,
    tp: tp.length, sl: sl.length, timeout: to.length,
    wins: wins.length, losses: losses.length,
    winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length * 100) : 0,
    totalPnl: Math.round(totalPnl),
    avgWin: Math.round(avgWin),
    avgLoss: Math.round(avgLoss),
    profitFactor: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0,
    avgHoldBars: Math.round(avgHold),
    tradesPerDay: +(closedTrades.length / days).toFixed(1),
    dailyPnl: Math.round(totalPnl / days),
    mdd: +mdd.toFixed(2),
    days,
    daily,
  };
}

// ── 최적화 시나리오 ──
const allData = loadAllData();
console.log(`로드 완료: ${allData.length}개 코인, ${allData.reduce((s, d) => s + d.data.length, 0)}봉\n`);

const scenarios = [
  // 현재 설정 (베이스라인)
  {
    name: '현재 설정 (베이스라인)',
    impulseMinPct: 1.5, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 48, slPct: 1.2, maxHoldCandles: 60, cooldownCandles: 3,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 2.0, trendBars: 24, // 2시간 MA
    trailActivatePct: 0, trailPct: 0,
  },
  // A: 더 공격적 진입 (impulse 낮춤 + OB 수명 늘림)
  {
    name: 'A: 공격적 진입 (impulse 1.0%)',
    impulseMinPct: 1.0, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 60, slPct: 1.2, maxHoldCandles: 60, cooldownCandles: 2,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.5, trendBars: 24,
    trailActivatePct: 0, trailPct: 0,
  },
  // B: 타이트 SL + 빠른 탈출 (손실 제한)
  {
    name: 'B: 타이트 SL 0.8% + 보유 30캔들',
    impulseMinPct: 1.5, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 48, slPct: 0.8, maxHoldCandles: 30, cooldownCandles: 2,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.5, trendBars: 24,
    trailActivatePct: 0, trailPct: 0,
  },
  // C: 트레일링 스탑 (수익 보호)
  {
    name: 'C: 트레일링 스탑 (1% 활성, 0.5% 트레일)',
    impulseMinPct: 1.5, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 48, slPct: 1.2, maxHoldCandles: 60, cooldownCandles: 3,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.5, trendBars: 24,
    trailActivatePct: 1.0, trailPct: 0.5,
  },
  // D: 추세필터 없음 (모든 장세 진입)
  {
    name: 'D: 추세필터 OFF (횡보장 포착)',
    impulseMinPct: 1.5, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 48, slPct: 1.0, maxHoldCandles: 40, cooldownCandles: 2,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.5, trendBars: 0, // OFF
    trailActivatePct: 0, trailPct: 0,
  },
  // E: 고빈도 + 작은 수익 (스캘핑 본질)
  {
    name: 'E: 고빈도 스캘핑 (minTP 1%, SL 0.7%, 쿨다운 1)',
    impulseMinPct: 1.0, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 60, slPct: 0.7, maxHoldCandles: 24, cooldownCandles: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.0, trendBars: 0,
    trailActivatePct: 0, trailPct: 0,
  },
  // F: 고빈도 + 트레일링
  {
    name: 'F: 고빈도 + 트레일링 (1%활성, 0.4%트레일)',
    impulseMinPct: 1.0, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 60, slPct: 0.7, maxHoldCandles: 30, cooldownCandles: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.0, trendBars: 0,
    trailActivatePct: 1.0, trailPct: 0.4,
  },
  // G: 최대 포지션 6개 + 고빈도 (자본 활용 극대화)
  {
    name: 'G: 6포지션 + 고빈도',
    impulseMinPct: 1.0, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 60, slPct: 0.8, maxHoldCandles: 30, cooldownCandles: 1,
    maxPositions: 6, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.0, trendBars: 12, // 1시간 약한 필터
    trailActivatePct: 0, trailPct: 0,
  },
  // H: 콤보 (D+E+트레일링)
  {
    name: 'H: 콤보 — 추세OFF, 고빈도, 트레일링',
    impulseMinPct: 1.0, impulseLookback: 6, volumeAvgWindow: 20,
    obMaxAge: 48, slPct: 0.8, maxHoldCandles: 30, cooldownCandles: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 1.0, trendBars: 0,
    trailActivatePct: 0.8, trailPct: 0.4,
  },
  // I: 타이트 SL + 넓은 진입 + 빠른 순환
  {
    name: 'I: SL 0.6% + 빠른 순환 (20캔들) + 쿨다운 0',
    impulseMinPct: 1.0, impulseLookback: 8, volumeAvgWindow: 20,
    obMaxAge: 36, slPct: 0.6, maxHoldCandles: 20, cooldownCandles: 0,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.8, trendBars: 0,
    trailActivatePct: 0, trailPct: 0,
  },
];

console.log('시나리오 | 총거래 | 일평균 | 승률 | TP | SL | TO | 총손익 | 일손익 | 평균이익 | 평균손실 | 손익비 | 평균보유 | MDD');
console.log('-'.repeat(150));

for (const sc of scenarios) {
  const r = runBacktest(allData, sc);
  console.log(
    `${sc.name.padEnd(45)} | ` +
    `${String(r.total).padStart(4)} | ` +
    `${String(r.tradesPerDay).padStart(5)}/일 | ` +
    `${r.winRate.toFixed(1).padStart(5)}% | ` +
    `${String(r.tp).padStart(3)} | ` +
    `${String(r.sl).padStart(3)} | ` +
    `${String(r.timeout).padStart(3)} | ` +
    `${(r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString() + '원'}`.padStart(10) + ` | ` +
    `${(r.dailyPnl > 0 ? '+' : '') + r.dailyPnl.toLocaleString() + '원'}`.padStart(9) + ` | ` +
    `${('+' + r.avgWin).padStart(7)}원 | ` +
    `${String(r.avgLoss).padStart(7)}원 | ` +
    `${r.profitFactor.toFixed(2).padStart(5)} | ` +
    `${String(r.avgHoldBars).padStart(4)}봉 | ` +
    `${r.mdd.toFixed(1)}%`
  );
}

// 상위 3개 일별 상세
console.log('\n\n=== 상위 시나리오 일별 상세 ===');
const results = scenarios.map(sc => ({ name: sc.name, cfg: sc, result: runBacktest(allData, sc) }));
results.sort((a, b) => b.result.totalPnl - a.result.totalPnl);

for (let ri = 0; ri < Math.min(3, results.length); ri++) {
  const { name, result } = results[ri];
  console.log(`\n[${ri + 1}위] ${name} — 총 ${result.totalPnl > 0 ? '+' : ''}${result.totalPnl.toLocaleString()}원`);
  const sorted = Object.entries(result.daily).sort(([a], [b]) => a.localeCompare(b));
  for (const [date, d] of sorted) {
    console.log(`  ${date}: ${d.pnl > 0 ? '+' : ''}${Math.round(d.pnl).toLocaleString()}원 (${d.trades}건)`);
  }
}
