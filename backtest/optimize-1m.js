/**
 * 1분봉 기반 전략 최적화 백테스트
 * 더 타이트한 스캘핑 — 박스권 치고빠지기
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-1m');
const COMMISSION = 0.0005;

function loadAllData() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const allData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    if (raw.length < 500) continue;
    allData.push({ coin, data: raw });
  }
  return allData;
}

function detectOB(data, cfg) {
  const obs = [];
  for (let i = cfg.volumeAvgWindow; i < data.length - cfg.impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue;
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

function checkShortMA(data, idx, maBars) {
  if (maBars <= 0 || idx < maBars) return true;
  let sum = 0;
  for (let j = idx - maBars; j < idx; j++) sum += data[j].close;
  return data[idx].close >= sum / maBars;
}

function runBacktest(allData, cfg) {
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

    // 청산 체크
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      if (pos.coin !== coin) continue;
      const holdBars = idx - pos.entryIdx;
      if (candle.high > pos.highSinceEntry) pos.highSinceEntry = candle.high;

      let exitReason = null, exitPrice = price;

      if (candle.high >= pos.tpPrice) {
        exitReason = 'TP'; exitPrice = pos.tpPrice;
      }
      if (!exitReason && cfg.trailActivatePct > 0) {
        const gain = (pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100;
        if (gain >= cfg.trailActivatePct) {
          const trailStop = pos.highSinceEntry * (1 - cfg.trailPct / 100);
          if (candle.low <= trailStop) {
            exitReason = 'TRAIL'; exitPrice = trailStop;
          }
        }
      }
      if (!exitReason && candle.low <= pos.slPrice) {
        exitReason = 'SL'; exitPrice = pos.slPrice;
      }
      if (!exitReason && holdBars >= cfg.maxHoldBars) {
        exitReason = 'TIMEOUT'; exitPrice = price;
      }

      if (exitReason) {
        const sellAmt = pos.amount * (1 - COMMISSION);
        const pnl = (exitPrice - pos.entryPrice) / pos.entryPrice * sellAmt;
        cash += sellAmt + pnl;
        trades.push({
          coin, entryPrice: pos.entryPrice, exitPrice, reason: exitReason,
          pnl, holdBars, pnlPct: (exitPrice - pos.entryPrice) / pos.entryPrice * 100,
          time: candle.time,
        });
        positions.splice(pi, 1);
        cooldowns[coin] = idx + cfg.cooldownBars;
      }
    }

    // 진입 체크
    if (positions.length >= cfg.maxPositions) continue;
    if (positions.some(p => p.coin === coin)) continue;
    if (cooldowns[coin] && idx < cooldowns[coin]) continue;

    const allCoinData = allData.find(d => d.coin === coin)?.data;
    if (!allCoinData) continue;
    if (!checkShortMA(allCoinData, idx, cfg.maBars)) continue;

    const maxAgeIdx = idx - cfg.obMaxAge;
    const activeOBs = obs.filter(o =>
      !o.used && !usedOBs.has(`${coin}_${o.index}`) &&
      o.index >= maxAgeIdx && o.index < idx
    );

    for (const ob of activeOBs) {
      if (price <= ob.top && price >= ob.bottom) {
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
          amount: allocAmount, entryIdx: idx, highSinceEntry: candle.high,
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
      const pnl = (last - pos.entryPrice) / pos.entryPrice * pos.amount;
      trades.push({ coin: pos.coin, reason: 'OPEN', pnl, pnlPct: (last - pos.entryPrice) / pos.entryPrice * 100, time: '' });
      cash += pos.amount + pnl;
    }
  }

  const closed = trades.filter(t => t.reason !== 'OPEN');
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const tp = closed.filter(t => t.reason === 'TP' || t.reason === 'TRAIL');
  const sl = closed.filter(t => t.reason === 'SL');
  const to = closed.filter(t => t.reason === 'TIMEOUT');

  const daily = {};
  for (const t of closed) {
    const date = (t.time || '').slice(0, 10);
    if (!daily[date]) daily[date] = { pnl: 0, trades: 0 };
    daily[date].pnl += t.pnl;
    daily[date].trades += 1;
  }
  const days = Object.keys(daily).filter(d => daily[d].trades > 10).length || 1;

  let peak = cfg.initialCapital, equity = cfg.initialCapital, mdd = 0;
  for (const t of closed) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  const avgHold = closed.length > 0 ? closed.reduce((s, t) => s + (t.holdBars || 0), 0) / closed.length : 0;

  return {
    total: closed.length, tp: tp.length, sl: sl.length, timeout: to.length,
    wins: wins.length, losses: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length * 100) : 0,
    totalPnl: Math.round(totalPnl), avgWin: Math.round(avgWin), avgLoss: Math.round(avgLoss),
    profitFactor: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0,
    avgHoldBars: Math.round(avgHold),
    tradesPerDay: +(closed.length / days).toFixed(1),
    dailyPnl: Math.round(totalPnl / days),
    mdd: +mdd.toFixed(2), days, daily,
  };
}

const allData = loadAllData();
console.log(`1분봉 로드: ${allData.length}개 코인, ${allData.reduce((s, d) => s + d.data.length, 0).toLocaleString()}봉\n`);

const scenarios = [
  // 1) 5분봉 H 시나리오를 1분봉으로 변환 (기준선)
  {
    name: '5분→1분 변환 (H시나리오 기준)',
    impulseMinPct: 0.5, impulseLookback: 15, volumeAvgWindow: 60,
    obMaxAge: 150, slPct: 0.5, maxHoldBars: 120, cooldownBars: 5,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.5, maBars: 0,
    trailActivatePct: 0.4, trailPct: 0.2,
  },
  // 2) 초단타 스캘핑 — 0.3% 목표
  {
    name: '초단타: TP 0.3%, SL 0.3%, 30bar',
    impulseMinPct: 0.3, impulseLookback: 10, volumeAvgWindow: 30,
    obMaxAge: 60, slPct: 0.3, maxHoldBars: 30, cooldownBars: 2,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.3, maBars: 0,
    trailActivatePct: 0, trailPct: 0,
  },
  // 3) 0.5% 타겟 + 트레일링
  {
    name: '0.5% 타겟 + 트레일링 0.3%활성/0.15%트레일',
    impulseMinPct: 0.4, impulseLookback: 15, volumeAvgWindow: 30,
    obMaxAge: 90, slPct: 0.4, maxHoldBars: 60, cooldownBars: 3,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.5, maBars: 0,
    trailActivatePct: 0.3, trailPct: 0.15,
  },
  // 4) 0.5% 타겟 타이트
  {
    name: '0.5% 타이트: SL 0.3%, 45bar, 쿨다운 1',
    impulseMinPct: 0.4, impulseLookback: 12, volumeAvgWindow: 30,
    obMaxAge: 120, slPct: 0.3, maxHoldBars: 45, cooldownBars: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.5, maBars: 0,
    trailActivatePct: 0, trailPct: 0,
  },
  // 5) 0.8% 목표 + 트레일링
  {
    name: '0.8% 목표 + 트레일링 0.5%/0.3%',
    impulseMinPct: 0.5, impulseLookback: 15, volumeAvgWindow: 30,
    obMaxAge: 120, slPct: 0.5, maxHoldBars: 90, cooldownBars: 2,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.8, maBars: 0,
    trailActivatePct: 0.5, trailPct: 0.3,
  },
  // 6) 6포지션 고빈도
  {
    name: '6포지션 고빈도: TP 0.5%, SL 0.3%',
    impulseMinPct: 0.3, impulseLookback: 10, volumeAvgWindow: 30,
    obMaxAge: 90, slPct: 0.3, maxHoldBars: 45, cooldownBars: 1,
    maxPositions: 6, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.5, maBars: 0,
    trailActivatePct: 0, trailPct: 0,
  },
  // 7) 고빈도 + 약한 MA필터
  {
    name: '고빈도 + 30MA 필터',
    impulseMinPct: 0.4, impulseLookback: 12, volumeAvgWindow: 30,
    obMaxAge: 90, slPct: 0.3, maxHoldBars: 45, cooldownBars: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.5, maBars: 30,
    trailActivatePct: 0, trailPct: 0,
  },
  // 8) 콤보: 트레일링 + 타이트 SL
  {
    name: '콤보: SL 0.3%, 트레일 0.3%/0.15%, 60bar',
    impulseMinPct: 0.4, impulseLookback: 12, volumeAvgWindow: 30,
    obMaxAge: 90, slPct: 0.3, maxHoldBars: 60, cooldownBars: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.5, maBars: 0,
    trailActivatePct: 0.3, trailPct: 0.15,
  },
  // 9) 넓은 OB + 타이트 실행
  {
    name: '넓은 OB(imp 0.3, age 180) + SL 0.25%',
    impulseMinPct: 0.3, impulseLookback: 15, volumeAvgWindow: 30,
    obMaxAge: 180, slPct: 0.25, maxHoldBars: 30, cooldownBars: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.4, maBars: 0,
    trailActivatePct: 0, trailPct: 0,
  },
  // 10) 최적 추정: 모든 요소 조합
  {
    name: '최적 추정: imp 0.3, SL 0.3%, trail 0.3/0.15',
    impulseMinPct: 0.3, impulseLookback: 12, volumeAvgWindow: 30,
    obMaxAge: 120, slPct: 0.3, maxHoldBars: 45, cooldownBars: 1,
    maxPositions: 4, initialCapital: 100000, minOrderAmount: 5000,
    minTpPct: 0.4, maBars: 0,
    trailActivatePct: 0.3, trailPct: 0.15,
  },
];

console.log('시나리오 | 거래수 | 일평균 | 승률 | TP | SL | TO | 총손익 | 일손익 | 평균이익 | 평균손실 | 손익비 | 보유 | MDD');
console.log('-'.repeat(160));

const results = [];
for (const sc of scenarios) {
  const r = runBacktest(allData, sc);
  results.push({ name: sc.name, cfg: sc, result: r });
  console.log(
    `${sc.name.padEnd(50)} | ` +
    `${String(r.total).padStart(5)} | ` +
    `${String(r.tradesPerDay).padStart(6)}/일 | ` +
    `${r.winRate.toFixed(1).padStart(5)}% | ` +
    `${String(r.tp).padStart(4)} | ` +
    `${String(r.sl).padStart(4)} | ` +
    `${String(r.timeout).padStart(4)} | ` +
    `${(r.totalPnl > 0 ? '+' : '') + r.totalPnl.toLocaleString() + '원'}`.padStart(12) + ` | ` +
    `${(r.dailyPnl > 0 ? '+' : '') + r.dailyPnl.toLocaleString() + '원'}`.padStart(10) + ` | ` +
    `${('+' + r.avgWin).padStart(7)}원 | ` +
    `${String(r.avgLoss).padStart(7)}원 | ` +
    `${r.profitFactor.toFixed(2).padStart(5)} | ` +
    `${String(r.avgHoldBars).padStart(4)}분 | ` +
    `${r.mdd.toFixed(1)}%`
  );
}

// 상위 3개 일별 상세
results.sort((a, b) => b.result.totalPnl - a.result.totalPnl);
console.log('\n\n=== 상위 3 시나리오 일별 상세 ===');
for (let ri = 0; ri < Math.min(3, results.length); ri++) {
  const { name, result, cfg } = results[ri];
  console.log(`\n[${ri + 1}위] ${name}`);
  console.log(`  총수익: ${result.totalPnl > 0 ? '+' : ''}${result.totalPnl.toLocaleString()}원 | 거래: ${result.total}건 | 승률: ${result.winRate.toFixed(1)}% | MDD: ${result.mdd}%`);
  console.log(`  설정: impulse ${cfg.impulseMinPct}%, SL ${cfg.slPct}%, minTP ${cfg.minTpPct}%, maxHold ${cfg.maxHoldBars}분, trail ${cfg.trailActivatePct}/${cfg.trailPct}%`);
  const sorted = Object.entries(result.daily).sort(([a], [b]) => a.localeCompare(b));
  for (const [date, d] of sorted) {
    if (d.trades < 5) continue;
    console.log(`  ${date}: ${d.pnl > 0 ? '+' : ''}${Math.round(d.pnl).toLocaleString()}원 (${d.trades}건)`);
  }
}
