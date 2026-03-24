#!/usr/bin/env node
/**
 * 백테스트 v2 — 멀티 전략 스코어링 엔진 검증
 *
 * 기능:
 *   1. 업비트 API에서 실제 캔들 데이터 수집
 *   2. 전략별 개별 백테스트 + 종합 스코어 백테스트
 *   3. 그리드 서치 (핵심 파라미터 최적화)
 *   4. 워크포워드 검증 (과적합 방지)
 *   5. 리스크 지표 (MDD, 샤프비율, 승률, 기대수익)
 *
 * 사용법: node backtest-v2.js [--grid] [--coins 5] [--days 30]
 */

const strategy = require('./strategy-engine');
const { detectOrderBlocks, normalizeCandles } = require('./ob-engine');
const upbitApi = require('./upbit-api');

const FEE = 0.0005; // 0.05% (업비트 수수료)

// ═══════════════════════════════════════════════════
// 데이터 수집
// ═══════════════════════════════════════════════════

async function fetchCandleData(market, minutes = 5, totalCandles = 2000) {
  const allRaw = [];
  let to = null;
  const batchSize = 200;

  while (allRaw.length < totalCandles) {
    try {
      const raw = await upbitApi.getCandles(market, minutes, batchSize, to);
      if (!Array.isArray(raw) || raw.length === 0) break;

      allRaw.push(...raw);

      // 다음 배치: 가장 오래된 캔들의 UTC 시간 이전
      const oldest = raw[raw.length - 1];
      to = oldest.candle_date_time_utc;

      if (raw.length < batchSize) break;

      await sleep(200); // API 속도 제한
    } catch (e) {
      console.error(`[${market}] 데이터 수집 오류: ${e.message}`);
      break;
    }
  }

  // 정규화 + 시간순 정렬
  const allCandles = normalizeCandles(allRaw);

  // 중복 제거
  const seen = new Set();
  const unique = allCandles.filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  return unique;
}

// ═══════════════════════════════════════════════════
// 백테스트 실행 엔진
// ═══════════════════════════════════════════════════

function runBacktest(candles, market, params = {}) {
  const {
    minScore = 60,
    atrSlMultiplier = 1.5,
    rrRatio = 2.0,
    volatilityK = 0.5,
    maxAtrSlPct = 3.0,
    minAtrSlPct = 0.5,
    maxHoldCandles = 36,
    trailActivatePct = 1.5,
    trailPct = 0.3,
    cooldownCandles = 3,
    buyDiscountPct = 0.3,
    obConfig = { impulseMinPct: 3, impulseLookback: 6, volumeMultiplier: 2, volumeAvgWindow: 20, obMaxAge: 24, slPct: 1.2 },
  } = params;

  if (candles.length < 100) return { trades: [], stats: null };

  // 지표 계산
  const ind = strategy.computeIndicators(candles);

  // OB 감지
  const obs = detectOrderBlocks(candles, obConfig);

  const trades = [];
  let position = null;
  let lastExitIdx = -999; // 쿨다운

  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    const price = c.close;

    // ── 포지션 보유 중 → 청산 체크 ──
    if (position) {
      // 고점 추적
      if (c.high > position.highSinceEntry) {
        position.highSinceEntry = c.high;
      }

      let exitReason = null;
      let exitPrice = price;

      // SL 체크 (봉의 저가)
      if (c.low <= position.sl) {
        exitReason = 'SL';
        exitPrice = position.sl;
      }

      // TP 체크 (봉의 고가)
      if (!exitReason && c.high >= position.tp) {
        exitReason = 'TP';
        exitPrice = position.tp;
      }

      // 트레일링 스탑
      if (!exitReason && trailActivatePct > 0) {
        const gain = (position.highSinceEntry / position.entry - 1) * 100;
        if (gain >= trailActivatePct) {
          const trailStop = position.highSinceEntry * (1 - trailPct / 100);
          if (c.low <= trailStop) {
            exitReason = 'TRAIL';
            exitPrice = trailStop;
          }
        }
      }

      // 시간 초과
      if (!exitReason && (i - position.entryIdx) >= maxHoldCandles) {
        exitReason = 'TIMEOUT';
        exitPrice = price;
      }

      if (exitReason) {
        const pnlPct = (exitPrice / position.entry - 1) * 100 - FEE * 100 * 2;
        trades.push({
          market,
          entry: position.entry,
          exit: exitPrice,
          pnlPct: +pnlPct.toFixed(3),
          result: pnlPct > 0 ? 'WIN' : 'LOSS',
          exitType: exitReason,
          holdCandles: i - position.entryIdx,
          score: position.score,
          strategies: position.strategies,
          entryTime: candles[position.entryIdx].time,
          exitTime: c.time,
        });
        lastExitIdx = i;
        position = null;
      }
      continue;
    }

    // ── 포지션 없음 → 진입 탐색 ──

    // 쿨다운 체크
    if (i - lastExitIdx < cooldownCandles) continue;

    // OB 상태 업데이트
    for (const o of obs) {
      if (!o.used && !o.broken && c.low < o.bottom * (1 - (obConfig.slPct || 1.2) / 100)) {
        o.broken = true;
      }
    }

    const activeOBs = obs.filter(o => !o.used && !o.broken && (i - o.index <= obConfig.obMaxAge));

    // 시그널 생성
    const signal = strategy.generateSignal(ind, i, candles, activeOBs, {
      minScore,
      atrSlMultiplier,
      rrRatio,
      volatilityK,
      maxAtrSlPct,
      minAtrSlPct,
    });

    if (!signal) continue;

    // 매수 할인 적용
    const entryPrice = price * (1 - buyDiscountPct / 100);

    // SL이 진입가 이상이면 스킵
    if (signal.sl >= entryPrice) continue;

    // 최소 TP% 확인
    const expectedPct = (signal.tp - entryPrice) / entryPrice * 100;
    if (expectedPct < 1.0) continue;

    // OB 사용 처리
    if (signal.touchedOB) signal.touchedOB.used = true;

    position = {
      entry: entryPrice,
      sl: signal.sl,
      tp: signal.tp,
      entryIdx: i,
      highSinceEntry: c.high,
      score: signal.score,
      strategies: signal.strategies.map(s => s.name),
    };
  }

  // 미청산 포지션 강제 청산 (백테스트 종료)
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const exitPrice = lastCandle.close;
    const pnlPct = (exitPrice / position.entry - 1) * 100 - FEE * 100 * 2;
    trades.push({
      market,
      entry: position.entry,
      exit: exitPrice,
      pnlPct: +pnlPct.toFixed(3),
      result: pnlPct > 0 ? 'WIN' : 'LOSS',
      exitType: 'END',
      holdCandles: candles.length - 1 - position.entryIdx,
      score: position.score,
      strategies: position.strategies,
      entryTime: candles[position.entryIdx].time,
      exitTime: lastCandle.time,
    });
  }

  return { trades, stats: calcStats(trades) };
}

// ═══════════════════════════════════════════════════
// 통계 계산
// ═══════════════════════════════════════════════════

function calcStats(trades) {
  if (trades.length === 0) return null;

  const wins = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const winRate = wins.length / trades.length * 100;

  const pnls = trades.map(t => t.pnlPct);
  const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;

  // 기대값 (EV)
  const ev = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;

  // MDD (Maximum Drawdown)
  let equity = 100;
  let peak = 100;
  let maxDD = 0;
  for (const t of trades) {
    equity *= (1 + t.pnlPct / 100);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // 프로핏 팩터
  const grossProfit = wins.reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  // 샤프비율 (간이)
  const mean = avgPnl;
  const variance = pnls.reduce((a, p) => a + (p - mean) ** 2, 0) / pnls.length;
  const stddev = Math.sqrt(variance);
  const sharpe = stddev > 0 ? mean / stddev : 0;

  // 평균 보유 시간
  const avgHold = trades.reduce((a, t) => a + t.holdCandles, 0) / trades.length;

  // 청산 유형별 분석
  const exitTypes = {};
  for (const t of trades) {
    if (!exitTypes[t.exitType]) exitTypes[t.exitType] = { count: 0, pnl: 0 };
    exitTypes[t.exitType].count++;
    exitTypes[t.exitType].pnl += t.pnlPct;
  }

  // 전략별 기여도
  const strategyStats = {};
  for (const t of trades) {
    if (!t.strategies) continue;
    for (const s of t.strategies) {
      if (!strategyStats[s]) strategyStats[s] = { count: 0, wins: 0, totalPnl: 0 };
      strategyStats[s].count++;
      if (t.result === 'WIN') strategyStats[s].wins++;
      strategyStats[s].totalPnl += t.pnlPct;
    }
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +winRate.toFixed(1),
    avgPnl: +avgPnl.toFixed(3),
    totalPnl: +totalPnl.toFixed(2),
    avgWin: +avgWin.toFixed(3),
    avgLoss: +avgLoss.toFixed(3),
    ev: +ev.toFixed(3),
    mdd: +maxDD.toFixed(2),
    profitFactor: +profitFactor.toFixed(2),
    sharpe: +sharpe.toFixed(3),
    avgHoldCandles: +avgHold.toFixed(1),
    finalEquity: +equity.toFixed(2),
    exitTypes,
    strategyStats,
  };
}

// ═══════════════════════════════════════════════════
// 그리드 서치
// ═══════════════════════════════════════════════════

function generateParamGrid() {
  const grid = [];

  const minScores = [40, 50, 60];
  const atrSlMults = [1.0, 1.5, 2.0];
  const rrRatios = [1.5, 2.0, 2.5, 3.0];
  const volatilityKs = [0.4, 0.5, 0.6];
  const trailActivates = [0, 1.5, 2.0];
  const buyDiscounts = [0.2, 0.3, 0.5];

  for (const minScore of minScores) {
    for (const atrSlMultiplier of atrSlMults) {
      for (const rrRatio of rrRatios) {
        for (const volatilityK of volatilityKs) {
          for (const trailActivatePct of trailActivates) {
            for (const buyDiscountPct of buyDiscounts) {
              grid.push({
                minScore,
                atrSlMultiplier,
                rrRatio,
                volatilityK,
                trailActivatePct,
                trailPct: 0.3,
                buyDiscountPct,
                maxHoldCandles: 36,
                cooldownCandles: 3,
                maxAtrSlPct: 3.0,
                minAtrSlPct: 0.5,
              });
            }
          }
        }
      }
    }
  }

  return grid;
}

async function runGridSearch(candles, market) {
  const grid = generateParamGrid();
  console.log(`\n📊 그리드 서치 시작: ${grid.length}개 조합 × ${market}`);

  const results = [];

  for (let idx = 0; idx < grid.length; idx++) {
    const params = grid[idx];
    const { trades, stats } = runBacktest(candles, market, params);

    if (stats && stats.totalTrades >= 5) {
      results.push({
        params,
        stats,
        // 종합 점수: 수익 × 안정성
        compositeScore: calcCompositeScore(stats),
      });
    }

    if ((idx + 1) % 100 === 0) {
      process.stdout.write(`  ${idx + 1}/${grid.length} 완료\r`);
    }
  }

  // 종합 점수 순 정렬
  results.sort((a, b) => b.compositeScore - a.compositeScore);

  return results;
}

/**
 * 종합 점수 = EV × PF × (1 - MDD/100) × sqrt(trades)
 * - EV: 기대값 (높을수록 좋음)
 * - PF: 프로핏 팩터 (1 이상이어야 수익)
 * - MDD: 최대 낙폭 (낮을수록 안정적)
 * - trades: 거래 횟수 (통계적 유의미성)
 */
function calcCompositeScore(stats) {
  if (!stats || stats.totalTrades < 5) return -999;
  if (stats.ev <= 0) return stats.ev * 10; // 마이너스 EV는 큰 감점

  const evScore = stats.ev;
  const pfScore = Math.min(stats.profitFactor, 5); // PF 상한
  const mddPenalty = 1 - stats.mdd / 100;
  const tradeFactor = Math.sqrt(stats.totalTrades);
  const winRateBonus = stats.winRate > 50 ? 1.2 : (stats.winRate > 40 ? 1.0 : 0.8);

  return evScore * pfScore * mddPenalty * tradeFactor * winRateBonus;
}

// ═══════════════════════════════════════════════════
// 워크포워드 검증 (과적합 방지)
// ═══════════════════════════════════════════════════

function walkForwardValidation(candles, market, bestParams, splitRatio = 0.7) {
  const splitIdx = Math.floor(candles.length * splitRatio);
  const inSample = candles.slice(0, splitIdx);
  const outSample = candles.slice(splitIdx);

  const inResult = runBacktest(inSample, market, bestParams);
  const outResult = runBacktest(outSample, market, bestParams);

  return {
    inSample: inResult.stats,
    outSample: outResult.stats,
    isRobust: outResult.stats && outResult.stats.ev > 0 && outResult.stats.profitFactor > 1.0,
    evDecay: inResult.stats && outResult.stats
      ? +((outResult.stats.ev / Math.max(inResult.stats.ev, 0.001) * 100).toFixed(1))
      : 0,
  };
}

// ═══════════════════════════════════════════════════
// 메인 실행
// ═══════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const isGrid = args.includes('--grid');
  const coinsArg = args.find(a => a.startsWith('--coins'));
  const daysArg = args.find(a => a.startsWith('--days'));
  const numCoins = coinsArg ? parseInt(coinsArg.split('=')[1] || coinsArg.split(' ')[1]) || 10 : 10;
  const numDays = daysArg ? parseInt(daysArg.split('=')[1] || daysArg.split(' ')[1]) || 30 : 30;

  console.log('═══════════════════════════════════════════════════');
  console.log('  24번트 v2 백테스트 — 멀티 전략 스코어링 엔진');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  모드: ${isGrid ? '그리드 서치' : '단일 백테스트'}`);
  console.log(`  코인: 상위 ${numCoins}개`);
  console.log(`  기간: 약 ${numDays}일 (5분봉 ${Math.round(numDays * 288)}개)`);
  console.log('');

  // 1. 거래대금 상위 코인 수집
  console.log('📡 거래대금 상위 코인 조회 중...');
  const topCoins = await upbitApi.getTopMarkets(0);
  const filtered = topCoins
    .filter(t => t.price >= 100) // 100원 이상
    .filter(t => !['BTC', 'ETH', 'USDT', 'CTC', 'ETC'].includes(t.coin)) // 대형/제외 코인 스킵
    .sort((a, b) => strategy.scoreCoinSuitability(b) - strategy.scoreCoinSuitability(a))
    .slice(0, numCoins);

  console.log(`  선별 코인: ${filtered.map(t => t.coin).join(', ')}\n`);

  const totalCandles = Math.round(numDays * 288); // 5분봉 기준
  const allResults = [];

  // 2. 코인별 백테스트
  for (const ticker of filtered) {
    console.log(`\n━━━ ${ticker.coin} (${ticker.market}) ━━━`);
    console.log(`  현재가: ${ticker.price.toLocaleString()}원 | 24h 거래대금: ${(ticker.volume24h / 1e8).toFixed(0)}억`);

    const candles = await fetchCandleData(ticker.market, 5, totalCandles);
    console.log(`  캔들 수집: ${candles.length}개 (${candles[0]?.time?.substring(0, 10)} ~ ${candles[candles.length - 1]?.time?.substring(0, 10)})`);

    if (candles.length < 200) {
      console.log('  ⚠️ 데이터 부족 — 스킵');
      continue;
    }

    if (isGrid) {
      // 그리드 서치
      const gridResults = await runGridSearch(candles, ticker.market);

      if (gridResults.length > 0) {
        const best = gridResults[0];
        console.log(`\n  🏆 최적 파라미터:`);
        console.log(`    minScore=${best.params.minScore} atrSL=${best.params.atrSlMultiplier} RR=${best.params.rrRatio} K=${best.params.volatilityK} trail=${best.params.trailActivatePct}`);
        printStats(best.stats, '    ');

        // 워크포워드 검증
        const wf = walkForwardValidation(candles, ticker.market, best.params);
        console.log(`\n  📋 워크포워드 검증:`);
        console.log(`    In-Sample:  ${wf.inSample ? `EV=${wf.inSample.ev}% PF=${wf.inSample.profitFactor} MDD=${wf.inSample.mdd}%` : 'N/A'}`);
        console.log(`    Out-Sample: ${wf.outSample ? `EV=${wf.outSample.ev}% PF=${wf.outSample.profitFactor} MDD=${wf.outSample.mdd}%` : 'N/A'}`);
        console.log(`    Robust: ${wf.isRobust ? '✅ PASS' : '❌ FAIL'} (EV decay: ${wf.evDecay}%)`);

        allResults.push({
          coin: ticker.coin,
          market: ticker.market,
          bestParams: best.params,
          bestStats: best.stats,
          compositeScore: best.compositeScore,
          walkForward: wf,
          gridResultCount: gridResults.length,
        });
      }
    } else {
      // 기본 파라미터 백테스트
      const { trades, stats } = runBacktest(candles, ticker.market, {
        minScore: 50,
        atrSlMultiplier: 1.5,
        rrRatio: 2.0,
        volatilityK: 0.5,
        trailActivatePct: 1.5,
        trailPct: 0.3,
        buyDiscountPct: 0.3,
        maxHoldCandles: 36,
        cooldownCandles: 3,
      });

      if (stats) {
        printStats(stats, '  ');
        allResults.push({ coin: ticker.coin, market: ticker.market, stats });
      } else {
        console.log('  거래 없음');
      }
    }

    await sleep(500); // API 속도 제한
  }

  // 3. 종합 결과
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  종합 결과');
  console.log('═══════════════════════════════════════════════════\n');

  if (allResults.length === 0) {
    console.log('  유효한 결과 없음\n');
    return;
  }

  // 전체 거래 통합
  const allTrades = allResults.flatMap(r => r.bestStats?.totalTrades ? [r] : [r]);

  // 코인별 요약
  console.log('  코인별 성과:');
  console.log('  ─────────────────────────────────────────────');
  console.log('  코인    | 거래수 | 승률   | EV      | PF   | MDD   | 종합');
  console.log('  ─────────────────────────────────────────────');

  for (const r of allResults.sort((a, b) => (b.bestStats?.ev || b.stats?.ev || 0) - (a.bestStats?.ev || a.stats?.ev || 0))) {
    const s = r.bestStats || r.stats;
    if (!s) continue;
    const coin = r.coin.padEnd(8);
    const trades = String(s.totalTrades).padStart(4);
    const wr = (s.winRate + '%').padStart(6);
    const ev = (s.ev > 0 ? '+' : '') + s.ev.toFixed(2) + '%';
    const pf = s.profitFactor.toFixed(1).padStart(4);
    const mdd = s.mdd.toFixed(1) + '%';
    const robust = r.walkForward?.isRobust ? '✅' : (r.walkForward ? '❌' : '—');
    console.log(`  ${coin} | ${trades} | ${wr} | ${ev.padStart(7)} | ${pf} | ${mdd.padStart(5)} | ${robust}`);
  }

  // 최적 전역 파라미터 찾기 (그리드 서치 모드)
  if (isGrid && allResults.length > 0) {
    const robustResults = allResults.filter(r => r.walkForward?.isRobust);
    console.log(`\n  워크포워드 통과: ${robustResults.length}/${allResults.length}개 코인`);

    if (robustResults.length > 0) {
      // 가장 많이 등장한 파라미터 조합 찾기
      const paramCounts = {};
      for (const r of robustResults) {
        const key = JSON.stringify({
          minScore: r.bestParams.minScore,
          atrSlMultiplier: r.bestParams.atrSlMultiplier,
          rrRatio: r.bestParams.rrRatio,
          volatilityK: r.bestParams.volatilityK,
          trailActivatePct: r.bestParams.trailActivatePct,
        });
        paramCounts[key] = (paramCounts[key] || 0) + 1;
      }

      // 평균 최적 파라미터 계산
      const avgParams = {
        minScore: Math.round(robustResults.reduce((a, r) => a + r.bestParams.minScore, 0) / robustResults.length),
        atrSlMultiplier: +(robustResults.reduce((a, r) => a + r.bestParams.atrSlMultiplier, 0) / robustResults.length).toFixed(2),
        rrRatio: +(robustResults.reduce((a, r) => a + r.bestParams.rrRatio, 0) / robustResults.length).toFixed(2),
        volatilityK: +(robustResults.reduce((a, r) => a + r.bestParams.volatilityK, 0) / robustResults.length).toFixed(2),
        trailActivatePct: +(robustResults.reduce((a, r) => a + r.bestParams.trailActivatePct, 0) / robustResults.length).toFixed(2),
        buyDiscountPct: +(robustResults.reduce((a, r) => a + r.bestParams.buyDiscountPct, 0) / robustResults.length).toFixed(2),
      };

      console.log('\n  🎯 추천 전역 파라미터 (워크포워드 통과 평균):');
      console.log(`    minScore: ${avgParams.minScore}`);
      console.log(`    atrSlMultiplier: ${avgParams.atrSlMultiplier}`);
      console.log(`    rrRatio: ${avgParams.rrRatio}`);
      console.log(`    volatilityK: ${avgParams.volatilityK}`);
      console.log(`    trailActivatePct: ${avgParams.trailActivatePct}`);
      console.log(`    buyDiscountPct: ${avgParams.buyDiscountPct}`);

      // config.json 추천값 출력
      console.log('\n  📝 config.json 추천 설정:');
      console.log(JSON.stringify({
        strategyV2: {
          ...avgParams,
          trailPct: 0.3,
          maxHoldCandles: 36,
          cooldownCandles: 3,
          maxAtrSlPct: 3.0,
          minAtrSlPct: 0.5,
        }
      }, null, 2));
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  백테스트 완료');
  console.log('═══════════════════════════════════════════════════\n');
}

function printStats(stats, prefix = '') {
  if (!stats) return;
  console.log(`${prefix}거래: ${stats.totalTrades}회 (${stats.wins}W/${stats.losses}L) | 승률: ${stats.winRate}%`);
  console.log(`${prefix}EV: ${stats.ev > 0 ? '+' : ''}${stats.ev}% | 총PnL: ${stats.totalPnl > 0 ? '+' : ''}${stats.totalPnl}%`);
  console.log(`${prefix}평균 승/패: +${stats.avgWin}% / ${stats.avgLoss}%`);
  console.log(`${prefix}PF: ${stats.profitFactor} | MDD: ${stats.mdd}% | Sharpe: ${stats.sharpe}`);
  console.log(`${prefix}평균 보유: ${stats.avgHoldCandles}봉 | 최종자산: ${stats.finalEquity}%`);

  if (stats.exitTypes) {
    const types = Object.entries(stats.exitTypes)
      .map(([k, v]) => `${k}: ${v.count}회 (${v.pnl > 0 ? '+' : ''}${v.pnl.toFixed(1)}%)`)
      .join(' | ');
    console.log(`${prefix}청산: ${types}`);
  }

  if (stats.strategyStats) {
    console.log(`${prefix}전략 기여:`);
    for (const [name, s] of Object.entries(stats.strategyStats)) {
      const wr = (s.wins / s.count * 100).toFixed(0);
      console.log(`${prefix}  ${name}: ${s.count}회 참여 (승률 ${wr}%, PnL ${s.totalPnl > 0 ? '+' : ''}${s.totalPnl.toFixed(1)}%)`);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 직접 실행 시
if (require.main === module) {
  main().catch(e => {
    console.error('백테스트 오류:', e);
    process.exit(1);
  });
}

// 모듈 내보내기 (server.js에서 사용)
module.exports = { runBacktest, calcStats, fetchCandleData, runGridSearch, walkForwardValidation };
