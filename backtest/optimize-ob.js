/**
 * OB 스캘핑 파라미터 최적화 (그리드서치)
 *
 * 최적화 대상:
 * - impulseMinPct: OB 형성 최소 상승폭
 * - volumeMultiplier: 거래량 배수 조건
 * - obMaxAge: OB 유효기간
 * - slPct: 손절 마진
 * - tpMode/tpFixedPct: 익절 방식
 * - maxHoldCandles: 최대 보유 시간
 * - 시간대 필터
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005;

// ── 보조 지표 (캐싱) ──────────────────────────────
function calcMA(data, period) {
  const r = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += data[j].close;
    r.push(s / period);
  }
  return r;
}

function calcAvgVolume(data, window) {
  const r = [];
  for (let i = 0; i < data.length; i++) {
    if (i < window) { r.push(null); continue; }
    let s = 0; for (let j = i - window; j < i; j++) s += data[j].volume;
    r.push(s / window);
  }
  return r;
}

// ── 데이터 로드 (1회) ─────────────────────────────
function loadAllData() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !['BTC.json','ETH.json','TRX.json','USDT.json'].includes(f));
  const coins = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    if (data.length < 100) continue;
    coins.push({ coin, data });
  }
  return coins;
}

// ── OB 감지 + 시그널 생성 ─────────────────────────
function generateSignals(coins, cfg) {
  const signals = [];

  for (const { coin, data } of coins) {
    const ma = calcMA(data, cfg.trendMaPeriod || 50);
    const avgVol = calcAvgVolume(data, cfg.volumeAvgWindow || 20);

    // OB 감지
    const obs = [];
    for (let i = (cfg.volumeAvgWindow || 20); i < data.length - cfg.impulseLookback; i++) {
      const c = data[i];
      if (c.close >= c.open) continue;
      if (avgVol[i] && c.volume < avgVol[i] * cfg.volumeMultiplier) continue;

      let maxH = 0;
      for (let j = i + 1; j <= i + cfg.impulseLookback && j < data.length; j++) {
        if (data[j].high > maxH) maxH = data[j].high;
      }
      const impulse = (maxH - c.close) / c.close * 100;
      if (impulse < cfg.impulseMinPct) continue;

      obs.push({ index: i, top: c.open, bottom: c.close, swingHigh: maxH, used: false });
    }

    // 시그널 매칭
    const cooldowns = {};
    const startIdx = (cfg.volumeAvgWindow || 20) + cfg.impulseLookback;

    for (let i = startIdx; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];

      // 시간대 필터
      if (cfg.excludeHours) {
        const hour = parseInt(candle.time.slice(11, 13));
        if (cfg.excludeHours.includes(hour)) continue;
      }

      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > cfg.obMaxAge || ob.used) continue;

        const touched = candle.low <= ob.top && candle.close >= ob.bottom;
        if (!touched) continue;

        if (cfg.useTrendFilter && ma[i] !== null && candle.close < ma[i]) continue;

        const entry = Math.max(candle.close, ob.bottom);
        const sl = ob.bottom * (1 - cfg.slPct / 100);

        let tp;
        if (cfg.tpMode === 'swing') {
          tp = ob.swingHigh;
        } else if (cfg.tpMode === 'ratio') {
          // 손절폭 대비 N배 익절
          const slDist = entry - sl;
          tp = entry + slDist * cfg.tpRatio;
        } else {
          tp = entry * (1 + cfg.tpFixedPct / 100);
        }

        // 시뮬레이션
        let exitPrice = null, exitReason = null, exitIndex = null;
        for (let j = i + 1; j < Math.min(i + cfg.maxHoldCandles, data.length); j++) {
          if (data[j].low <= sl) { exitPrice = sl; exitReason = 'SL'; exitIndex = j; break; }
          if (data[j].high >= tp) { exitPrice = tp; exitReason = 'TP'; exitIndex = j; break; }
        }
        if (!exitPrice) {
          const last = Math.min(i + cfg.maxHoldCandles, data.length - 1);
          exitPrice = data[last].close; exitReason = 'TO'; exitIndex = last;
        }

        const netPct = (exitPrice - entry) / entry - COMMISSION * 2;

        signals.push({
          coin, entryTime: candle.time, exitTime: data[exitIndex].time,
          entryIndex: i, exitIndex, entryPrice: entry, exitPrice, netPct, reason: exitReason,
          holdMinutes: (exitIndex - i) * 5,
        });

        ob.used = true;
        cooldowns[coin] = exitIndex + (cfg.cooldownCandles || 6);
        break;
      }
    }
  }

  signals.sort((a, b) => a.entryTime.localeCompare(b.entryTime));
  return signals;
}

// ── 포트폴리오 시뮬레이션 ─────────────────────────
function simulate(signals, cfg) {
  let cash = 100000;
  const active = new Map();
  const trades = [];
  const maxPos = cfg.maxPositions || 10;

  const events = [];
  signals.forEach(s => {
    events.push({ type: 'EXIT', time: s.exitTime, sig: s, key: `${s.coin}_${s.entryTime}` });
    events.push({ type: 'ENTRY', time: s.entryTime, sig: s, key: `${s.coin}_${s.entryTime}` });
  });
  events.sort((a, b) => a.time !== b.time ? a.time.localeCompare(b.time) : (a.type === 'EXIT' ? -1 : 1));

  let peak = cash, mdd = 0;

  for (const ev of events) {
    if (ev.type === 'EXIT') {
      const pos = active.get(ev.key);
      if (!pos) continue;
      const pnl = pos.amount * ev.sig.netPct;
      cash += pos.amount + pnl;
      active.delete(ev.key);
      trades.push({ ...ev.sig, amount: pos.amount, pnl });

      const equity = cash + [...active.values()].reduce((s, p) => s + p.amount, 0);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak * 100;
      if (dd > mdd) mdd = dd;
    }

    if (ev.type === 'ENTRY') {
      const hasCoin = [...active.values()].some(p => p.coin === ev.sig.coin);
      if (hasCoin || active.size >= maxPos) continue;
      const slots = maxPos - active.size;
      const alloc = Math.floor(cash / slots);
      if (alloc < 5000) continue;
      const amt = Math.min(alloc, cash);
      cash -= amt;
      active.set(ev.key, { coin: ev.sig.coin, amount: amt });
    }
  }

  const finalEquity = cash + [...active.values()].reduce((s, p) => s + p.amount, 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;

  // 일별 수익
  const dailyPnl = {};
  trades.forEach(t => {
    const d = t.entryTime.slice(0, 10);
    dailyPnl[d] = (dailyPnl[d] || 0) + t.pnl;
  });
  const days = Object.keys(dailyPnl);
  const dailyAvg = days.length > 0 ? totalPnl / days.length : 0;
  const profitDays = days.filter(d => dailyPnl[d] > 0).length;

  return {
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    totalPnl: Math.round(totalPnl),
    returnPct: +((finalEquity / 100000 - 1) * 100).toFixed(2),
    dailyAvgPct: +(dailyAvg / 100000 * 100).toFixed(3),  // 초기자본 대비
    mdd: +mdd.toFixed(2),
    profitDays,
    totalDays: days.length,
    avgHold: trades.length > 0 ? Math.round(trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length) : 0,
  };
}

// ── 그리드서치 ────────────────────────────────────
function main() {
  console.log('데이터 로딩...');
  const coins = loadAllData();
  console.log(`${coins.length}개 코인 로드 완료\n`);

  // ── 최적화 파라미터 그리드 ──
  const grids = {
    impulseMinPct:   [1.0, 1.5, 2.0, 2.5],
    volumeMultiplier:[1.0, 1.5, 2.0],
    obMaxAge:        [24, 48, 72],         // 2h, 4h, 6h
    slPct:           [0.2, 0.3, 0.5, 0.8],
    tpConfigs: [
      { tpMode: 'swing' },
      { tpMode: 'fixed', tpFixedPct: 1.0 },
      { tpMode: 'fixed', tpFixedPct: 1.5 },
      { tpMode: 'fixed', tpFixedPct: 2.0 },
      { tpMode: 'ratio', tpRatio: 1.5 },  // 손익비 1:1.5
      { tpMode: 'ratio', tpRatio: 2.0 },  // 손익비 1:2
      { tpMode: 'ratio', tpRatio: 3.0 },  // 손익비 1:3
    ],
    maxHoldCandles:  [30, 60, 120],        // 2.5h, 5h, 10h
    maxPositions:    [5, 10],
    useTrendFilter:  [true, false],
    excludeHours: [
      null,                                // 시간 필터 없음
      [0, 1, 2, 3, 4, 5],                 // 새벽 제외
      [0, 1, 21, 22, 23],                 // 심야 제외
    ],
  };

  // 전수 탐색은 너무 많으므로 단계별 최적화
  // 1단계: 핵심 파라미터 (impulse, volume, OB age, TP, SL)
  // 2단계: 보조 파라미터 (시간필터, 추세필터, 보유시간, 포지션수)

  const results = [];
  let tested = 0;

  // ── 1단계: 핵심 파라미터 ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' 1단계: 핵심 파라미터 최적화');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const totalCombos = grids.impulseMinPct.length * grids.volumeMultiplier.length *
    grids.obMaxAge.length * grids.slPct.length * grids.tpConfigs.length;
  console.log(`조합 수: ${totalCombos}개\n`);

  for (const impulse of grids.impulseMinPct) {
    for (const volMult of grids.volumeMultiplier) {
      for (const obAge of grids.obMaxAge) {
        for (const sl of grids.slPct) {
          for (const tpCfg of grids.tpConfigs) {
            const cfg = {
              impulseMinPct: impulse,
              impulseLookback: 6,
              volumeMultiplier: volMult,
              volumeAvgWindow: 20,
              obMaxAge: obAge,
              slPct: sl,
              ...tpCfg,
              useTrendFilter: true,
              trendMaPeriod: 50,
              maxHoldCandles: 60,
              maxPositions: 10,
              cooldownCandles: 6,
              excludeHours: null,
            };

            const signals = generateSignals(coins, cfg);
            const result = simulate(signals, cfg);

            const tpLabel = tpCfg.tpMode === 'swing' ? 'swing'
              : tpCfg.tpMode === 'ratio' ? `ratio${tpCfg.tpRatio}`
              : `fixed${tpCfg.tpFixedPct}%`;

            results.push({
              label: `imp${impulse}_vol${volMult}_age${obAge}_sl${sl}_${tpLabel}`,
              cfg, ...result,
            });

            tested++;
            if (tested % 50 === 0) {
              process.stdout.write(`  ${tested}/${totalCombos} 완료...\r`);
            }
          }
        }
      }
    }
  }

  // 1단계 Top 10
  results.sort((a, b) => b.dailyAvgPct - a.dailyAvgPct);

  console.log(`\n\n  1단계 TOP 10 (일평균 수익률 기준):`);
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  console.log('  #   설정                                    거래  승률   일수익  총수익  MDD');
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  results.slice(0, 10).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}  ${r.label.padEnd(42)} ${String(r.trades).padStart(4)}  ${(r.winRate * 100).toFixed(0).padStart(3)}%  ${('+' + r.dailyAvgPct.toFixed(2) + '%').padStart(7)}  ${('+' + r.returnPct + '%').padStart(7)}  -${r.mdd}%`);
  });

  // 최악 5개
  console.log('\n  WORST 5:');
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  results.slice(-5).reverse().forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}  ${r.label.padEnd(42)} ${String(r.trades).padStart(4)}  ${(r.winRate * 100).toFixed(0).padStart(3)}%  ${(r.dailyAvgPct.toFixed(2) + '%').padStart(7)}  ${(r.returnPct + '%').padStart(7)}  -${r.mdd}%`);
  });

  // ── 2단계: 1단계 Top 1 기반으로 보조 파라미터 최적화 ──
  const best1 = results[0].cfg;
  console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(` 2단계: 보조 파라미터 최적화 (베이스: ${results[0].label})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const results2 = [];

  for (const trend of grids.useTrendFilter) {
    for (const hold of grids.maxHoldCandles) {
      for (const pos of grids.maxPositions) {
        for (const hours of grids.excludeHours) {
          const cfg = {
            ...best1,
            useTrendFilter: trend,
            maxHoldCandles: hold,
            maxPositions: pos,
            excludeHours: hours,
          };

          const signals = generateSignals(coins, cfg);
          const result = simulate(signals, cfg);

          const hourLabel = hours ? `ex[${hours.join(',')}]` : 'allHours';
          const label = `trend=${trend}_hold=${hold}_pos=${pos}_${hourLabel}`;

          results2.push({ label, cfg, ...result });
        }
      }
    }
  }

  results2.sort((a, b) => b.dailyAvgPct - a.dailyAvgPct);

  console.log(`\n  2단계 TOP 10:`);
  console.log('  ─────────────────────────────────────────────────────────────────────────────');
  console.log('  #   설정                                                거래  승률   일수익  총수익  MDD');
  console.log('  ─────────────────────────────────────────────────────────────────────────────');
  results2.slice(0, 10).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}  ${r.label.padEnd(55)} ${String(r.trades).padStart(4)}  ${(r.winRate * 100).toFixed(0).padStart(3)}%  ${('+' + r.dailyAvgPct.toFixed(2) + '%').padStart(7)}  ${('+' + r.returnPct + '%').padStart(7)}  -${r.mdd}%`);
  });

  // ── 최종 결과 ──
  const finalBest = results2[0];
  const fc = finalBest.cfg;

  console.log('\n\n══════════════════════════════════════════════════');
  console.log('  최적 설정');
  console.log('══════════════════════════════════════════════════');
  console.log(`  impulseMinPct:    ${fc.impulseMinPct}%`);
  console.log(`  volumeMultiplier: ${fc.volumeMultiplier}x`);
  console.log(`  obMaxAge:         ${fc.obMaxAge} 캔들 (${fc.obMaxAge * 5}분)`);
  console.log(`  slPct:            ${fc.slPct}% (OB 하단 아래)`);
  console.log(`  tpMode:           ${fc.tpMode}${fc.tpMode === 'fixed' ? ' ' + fc.tpFixedPct + '%' : fc.tpMode === 'ratio' ? ' 1:' + fc.tpRatio : ''}`);
  console.log(`  useTrendFilter:   ${fc.useTrendFilter}`);
  console.log(`  maxHoldCandles:   ${fc.maxHoldCandles} (${fc.maxHoldCandles * 5}분)`);
  console.log(`  maxPositions:     ${fc.maxPositions}`);
  console.log(`  excludeHours:     ${fc.excludeHours ? fc.excludeHours.join(',') + '시' : '없음'}`);
  console.log('──────────────────────────────────────────────────');
  console.log(`  총 거래: ${finalBest.trades}회`);
  console.log(`  승률: ${(finalBest.winRate * 100).toFixed(1)}%`);
  console.log(`  일평균: +${finalBest.dailyAvgPct.toFixed(2)}%`);
  console.log(`  총 수익률: +${finalBest.returnPct}%`);
  console.log(`  MDD: -${finalBest.mdd}%`);
  console.log(`  수익일: ${finalBest.profitDays}/${finalBest.totalDays}일`);
  console.log(`  💰 10만원 → ${(100000 * (1 + finalBest.returnPct / 100)).toLocaleString()}원`);
  console.log('══════════════════════════════════════════════════');

  // 저장
  const savePath = path.join(__dirname, '..', 'data', 'optimize-result.json');
  fs.writeFileSync(savePath, JSON.stringify({
    stage1_top10: results.slice(0, 10).map(r => ({ label: r.label, ...r, cfg: r.cfg })),
    stage2_top10: results2.slice(0, 10).map(r => ({ label: r.label, ...r, cfg: r.cfg })),
    bestConfig: fc,
    bestResult: finalBest,
  }, null, 2));
  console.log(`\n결과 저장: ${savePath}`);
}

main();
