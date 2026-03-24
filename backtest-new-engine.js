/**
 * 새 엔진 백테스트 — 5중 필터 시스템
 * OB 터치 + HMA 방향 + ADX > 25 + RSI > 50 + R:R 1:2
 *
 * 시나리오별 비교:
 *   기존 엔진 | HMA만 | HMA+ADX | HMA+RSI | 전체 필터
 */

const { getCandles, getTopMarkets } = require('./upbit-api');
const { detectOrderBlocks, normalizeCandles, checkOBTouch } = require('./ob-engine');

// ─── 기술 지표 ───────────────────────────────────────

/** Weighted Moving Average */
function calcWMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0, wSum = 0;
    for (let j = 0; j < period; j++) {
      const w = j + 1;
      sum += data[i - period + 1 + j] * w;
      wSum += w;
    }
    result.push(sum / wSum);
  }
  return result;
}

/** Hull Moving Average (period=20) */
function calcHMA(closes, period = 20) {
  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.round(Math.sqrt(period));

  const wmaHalf = calcWMA(closes, halfPeriod);
  const wmaFull = calcWMA(closes, period);

  // 2 * WMA(n/2) - WMA(n)
  const diff = [];
  for (let i = 0; i < closes.length; i++) {
    if (wmaHalf[i] === null || wmaFull[i] === null) { diff.push(null); continue; }
    diff.push(2 * wmaHalf[i] - wmaFull[i]);
  }

  // WMA(sqrt(n)) of diff — only on non-null portion
  const nonNullStart = diff.findIndex(v => v !== null);
  if (nonNullStart === -1) return new Array(closes.length).fill(null);

  const diffSlice = diff.slice(nonNullStart);
  const hmaSlice = calcWMA(diffSlice, sqrtPeriod);

  const hma = new Array(nonNullStart).fill(null);
  for (const v of hmaSlice) hma.push(v);
  return hma;
}

/** RSI (period=14) */
function calcRSI(closes, period = 14) {
  const rsi = [null];
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i < period) { rsi.push(null); continue; }
      avgGain /= period;
      avgLoss /= period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) rsi.push(100);
    else rsi.push(100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

/** ADX (period=14) */
function calcADX(highs, lows, closes, period = 14) {
  const len = highs.length;
  const adx = [null];
  const trArr = [], plusDMArr = [], minusDMArr = [];

  for (let i = 1; i < len; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    trArr.push(tr);
    plusDMArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Smoothed values using Wilder's smoothing
  if (trArr.length < period) return new Array(len).fill(null);

  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += trArr[i];
    smoothPlusDM += plusDMArr[i];
    smoothMinusDM += minusDMArr[i];
  }

  const dxArr = [];
  for (let i = period; i <= trArr.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trArr[i - 1];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMArr[i - 1];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMArr[i - 1];
    }
    const plusDI = smoothTR ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
    dxArr.push(dx);
  }

  // ADX = smoothed DX over period
  if (dxArr.length < period) return new Array(len).fill(null);

  const adxResult = new Array(len).fill(null);
  let adxVal = 0;
  for (let i = 0; i < period; i++) adxVal += dxArr[i];
  adxVal /= period;
  adxResult[period * 2] = adxVal; // index offset: 1 (for diff) + period (first smooth) + period (adx smooth) - 1

  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
    const idx = i + period + 1; // map back to candle index
    if (idx < len) adxResult[idx] = adxVal;
  }
  return adxResult;
}

// ─── 백테스트 엔진 ──────────────────────────────────

function runBacktest(candles, market, scenario) {
  const {
    useHMA = false,
    useADX = false,
    useRSI = false,
    rrRatio = 2,
    trailActivatePct = 0,  // 0이면 트레일링 미사용
    trailPct = 0.3,
    bearishFilter = 0,
    impulseMinPct = 2.0,
    volumeMultiplier = 1.5,
    impulseLookback = 6,
    obMaxAge = 24,
  } = scenario;

  const config = {
    impulseMinPct,
    impulseLookback,
    volumeMultiplier,
    volumeAvgWindow: 20,
    obMaxAge,
    slPct: 0.8,
  };

  const FEE = 0.0005; // 0.05%
  const MAX_HOLD = 36;
  const BUY_DISCOUNT = 0.01; // 1%

  // 지표 계산
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const hma = useHMA ? calcHMA(closes, 20) : null;
  const adx = useADX ? calcADX(highs, lows, closes, 14) : null;
  const rsi = useRSI ? calcRSI(closes, 14) : null;

  // OB 감지
  const obs = detectOrderBlocks(candles, config);

  const trades = [];
  let position = null;

  for (let i = 30; i < candles.length; i++) {
    const c = candles[i];
    const price = c.close;

    // 포지션 보유 중이면 체크
    if (position) {
      // 고점 갱신 (트레일링용)
      if (c.high > position.highSinceEntry) {
        position.highSinceEntry = c.high;
      }

      // 봉의 저가가 SL 이하 → 손절
      if (c.low <= position.sl) {
        const exitPrice = position.sl;
        const pnlPct = (exitPrice / position.entry - 1) * 100 - FEE * 100 * 2;
        trades.push({
          market,
          entry: position.entry,
          exit: exitPrice,
          pnlPct,
          result: 'LOSS',
          exitType: 'SL',
          holdCandles: i - position.entryIdx,
        });
        position = null;
        continue;
      }
      // 봉의 고가가 TP 이상 → 익절
      if (c.high >= position.tp) {
        const exitPrice = position.tp;
        const pnlPct = (exitPrice / position.entry - 1) * 100 - FEE * 100 * 2;
        trades.push({
          market,
          entry: position.entry,
          exit: exitPrice,
          pnlPct,
          result: 'WIN',
          exitType: 'TP',
          holdCandles: i - position.entryIdx,
        });
        position = null;
        continue;
      }
      // 트레일링 스탑 체크
      if (trailActivatePct > 0) {
        const runupPct = (position.highSinceEntry / position.entry - 1) * 100;
        if (runupPct >= trailActivatePct) {
          const trailStop = position.highSinceEntry * (1 - trailPct / 100);
          if (c.low <= trailStop) {
            const exitPrice = trailStop;
            const pnlPct = (exitPrice / position.entry - 1) * 100 - FEE * 100 * 2;
            trades.push({
              market,
              entry: position.entry,
              exit: exitPrice,
              pnlPct,
              result: pnlPct > 0 ? 'WIN' : 'LOSS',
              exitType: 'TRAIL',
              holdCandles: i - position.entryIdx,
            });
            position = null;
            continue;
          }
        }
      }
      // 시간 초과
      if (i - position.entryIdx >= MAX_HOLD) {
        const exitPrice = price;
        const pnlPct = (exitPrice / position.entry - 1) * 100 - FEE * 100 * 2;
        trades.push({
          market,
          entry: position.entry,
          exit: exitPrice,
          pnlPct,
          result: pnlPct > 0 ? 'WIN' : 'LOSS',
          exitType: 'TIMEOUT',
          holdCandles: i - position.entryIdx,
        });
        position = null;
        continue;
      }
      continue;
    }

    // 포지션 없으면 진입 탐색
    // OB broken 체크 — 봉의 low가 OB 하단 이탈 시 broken 처리
    for (const o of obs) {
      if (!o.used && !o.broken && c.low < o.bottom * (1 - config.slPct / 100)) {
        o.broken = true;
      }
    }

    // 활성 OB 필터링
    const activeOBs = obs.filter(ob => {
      if (ob.used || ob.broken) return false;
      if (i - ob.index > config.obMaxAge) return false;
      return true;
    });

    const touchedOB = checkOBTouch(activeOBs, price);
    if (!touchedOB) continue;

    // 연속 음봉 필터
    if (bearishFilter > 0 && i >= bearishFilter) {
      let allBear = true;
      for (let j = i - bearishFilter; j < i; j++) {
        if (candles[j].close >= candles[j].open) { allBear = false; break; }
      }
      if (allBear) continue;
    }

    // 필터 체크
    if (useHMA && hma) {
      if (hma[i] === null || hma[i - 1] === null) continue;
      if (hma[i] <= hma[i - 1]) continue; // HMA 상승 중이어야
    }
    if (useADX && adx) {
      if (adx[i] === null || adx[i] < 25) continue;
    }
    if (useRSI && rsi) {
      if (rsi[i] === null || rsi[i] < 50) continue;
    }

    // 진입
    const entryPrice = price * (1 - BUY_DISCOUNT);
    const sl = touchedOB.bottom * (1 - config.slPct / 100);
    const slDist = entryPrice - sl;
    if (slDist <= 0) continue; // 진입가가 SL 이하면 스킵

    const tp = entryPrice + slDist * rrRatio;

    touchedOB.used = true;
    position = {
      entry: entryPrice,
      sl,
      tp,
      entryIdx: i,
      highSinceEntry: entryPrice,
    };
  }

  return trades;
}

// ─── OB 없는 순수 지표 전략 백테스트 ─────────────────
// 영상2: HMA 밴드 전환 → 진입, SL=HMA밴드, TP=SL×2
// 영상1: 200EMA + RSI>50 + 상승장악형캔들
function runNoOBBacktest(candles, market, scenario) {
  const { mode = 'hma', rrRatio = 2 } = scenario;

  const FEE = 0.0005;
  const MAX_HOLD = 36;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);

  const hma = calcHMA(closes, 20);
  const adx = calcADX(highs, lows, closes, 14);
  const rsi = calcRSI(closes, 14);

  // EMA 200 계산
  function calcEMA(data, period) {
    const ema = [data[0]];
    const k = 2 / (period + 1);
    for (let i = 1; i < data.length; i++) {
      ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }
  const ema200 = calcEMA(closes, 200);

  // 상승 장악형 캔들 감지
  function isEngulfing(i) {
    if (i < 1) return false;
    const prev = { o: opens[i - 1], c: closes[i - 1], h: highs[i - 1], l: lows[i - 1] };
    const curr = { o: opens[i], c: closes[i], h: highs[i], l: lows[i] };
    // 이전: 음봉, 현재: 양봉, 현재가 이전을 감싸야 함
    return prev.c < prev.o && curr.c > curr.o && curr.c > prev.o && curr.o < prev.c;
  }

  const trades = [];
  let position = null;
  let lastHmaDir = null; // 'up' or 'down'

  for (let i = 30; i < candles.length; i++) {
    const c = candles[i];
    const price = c.close;

    // 포지션 보유 중 → SL/TP/TIMEOUT 체크
    if (position) {
      if (c.low <= position.sl) {
        const pnlPct = (position.sl / position.entry - 1) * 100 - FEE * 100 * 2;
        trades.push({ market, entry: position.entry, exit: position.sl, pnlPct, result: 'LOSS', holdCandles: i - position.entryIdx });
        position = null;
        continue;
      }
      if (c.high >= position.tp) {
        const pnlPct = (position.tp / position.entry - 1) * 100 - FEE * 100 * 2;
        trades.push({ market, entry: position.entry, exit: position.tp, pnlPct, result: 'WIN', holdCandles: i - position.entryIdx });
        position = null;
        continue;
      }
      if (i - position.entryIdx >= MAX_HOLD) {
        const pnlPct = (price / position.entry - 1) * 100 - FEE * 100 * 2;
        trades.push({ market, entry: position.entry, exit: price, pnlPct, result: pnlPct > 0 ? 'WIN' : 'LOSS', holdCandles: i - position.entryIdx });
        position = null;
        continue;
      }
      continue;
    }

    // ─── 진입 조건 ───
    if (hma[i] === null || hma[i - 1] === null) continue;

    const hmaDir = hma[i] > hma[i - 1] ? 'up' : 'down';

    if (mode === 'hma_band') {
      // 영상2: HMA 밴드 하락→상승 전환 시 매수
      if (lastHmaDir === 'down' && hmaDir === 'up') {
        // ADX > 25 필터
        if (adx[i] !== null && adx[i] < 25) { lastHmaDir = hmaDir; continue; }

        const entryPrice = price;
        const sl = hma[i]; // HMA 밴드가 SL
        const slDist = entryPrice - sl;
        if (slDist <= 0 || slDist / entryPrice * 100 < 0.3) { lastHmaDir = hmaDir; continue; } // SL 너무 가까우면 스킵
        const tp = entryPrice + slDist * rrRatio;

        position = { entry: entryPrice, sl, tp, entryIdx: i };
      }
      lastHmaDir = hmaDir;

    } else if (mode === 'ema_rsi_engulf') {
      // 영상1: 가격>EMA200 + RSI>50 + 상승장악형 캔들
      if (price <= ema200[i]) continue;
      if (rsi[i] === null || rsi[i] < 50) continue;
      if (!isEngulfing(i)) continue;

      // SL = 장악형 캔들의 저점
      const entryPrice = price;
      const sl = lows[i] * 0.998; // 저점 -0.2%
      const slDist = entryPrice - sl;
      if (slDist <= 0 || slDist / entryPrice * 100 < 0.3) continue;
      const tp = entryPrice + slDist * rrRatio;

      position = { entry: entryPrice, sl, tp, entryIdx: i };

    } else if (mode === 'hma_rsi') {
      // 혼합: HMA 상승 + RSI>50 + ADX>25
      if (hmaDir !== 'up') continue;
      if (rsi[i] === null || rsi[i] < 50) continue;
      if (adx[i] !== null && adx[i] < 25) continue;
      // 이전 봉이 음봉이고 현재 봉이 양봉 (간단한 반전 확인)
      if (!(closes[i - 1] < opens[i - 1] && closes[i] > opens[i])) continue;

      const entryPrice = price;
      const sl = Math.min(lows[i], lows[i - 1]) * 0.998;
      const slDist = entryPrice - sl;
      if (slDist <= 0 || slDist / entryPrice * 100 < 0.3) continue;
      const tp = entryPrice + slDist * rrRatio;

      position = { entry: entryPrice, sl, tp, entryIdx: i };
    }
  }

  return trades;
}

// ─── 결과 집계 ──────────────────────────────────────

function aggregateResults(allTrades, scenarioName) {
  const total = allTrades.length;
  if (total === 0) return { scenarioName, total: 0, wins: 0, winRate: 0, avgWin: 0, avgLoss: 0, rr: 0, totalPnl: 0 };

  const wins = allTrades.filter(t => t.result === 'WIN').length;
  const losses = total - wins;
  const winRate = (wins / total * 100);

  const winTrades = allTrades.filter(t => t.result === 'WIN');
  const lossTrades = allTrades.filter(t => t.result === 'LOSS');

  const avgWin = winTrades.length ? winTrades.reduce((s, t) => s + t.pnlPct, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length ? lossTrades.reduce((s, t) => s + t.pnlPct, 0) / lossTrades.length : 0;
  const rr = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  // 총 수익 (100,000원 기준, 복리)
  let capital = 100000;
  for (const t of allTrades) {
    capital *= (1 + t.pnlPct / 100);
  }
  const totalPnl = capital - 100000;

  return {
    scenarioName,
    total,
    wins,
    losses,
    winRate: +winRate.toFixed(1),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    rr: +rr.toFixed(2),
    totalPnl: Math.round(totalPnl),
    finalCapital: Math.round(capital),
  };
}

// ─── 메인 ───────────────────────────────────────────

const BASE = { rrRatio: 2, trailActivatePct: 1.8, trailPct: 0.3, bearishFilter: 2 };
const OB_SCENARIOS = [
  // A. 임펄스 강도 (OB 뒤 상승폭)
  { ...BASE, name: '① 임펄스2%+거래량1.5x(현재)', impulseMinPct: 2, volumeMultiplier: 1.5 },
  { ...BASE, name: '② 임펄스3%+거래량1.5x',      impulseMinPct: 3, volumeMultiplier: 1.5 },
  { ...BASE, name: '③ 임펄스4%+거래량1.5x',      impulseMinPct: 4, volumeMultiplier: 1.5 },
  { ...BASE, name: '④ 임펄스5%+거래량1.5x',      impulseMinPct: 5, volumeMultiplier: 1.5 },
  // B. 거래량 배수
  { ...BASE, name: '⑤ 임펄스3%+거래량2x',        impulseMinPct: 3, volumeMultiplier: 2.0 },
  { ...BASE, name: '⑥ 임펄스3%+거래량2.5x',      impulseMinPct: 3, volumeMultiplier: 2.5 },
  { ...BASE, name: '⑦ 임펄스3%+거래량3x',        impulseMinPct: 3, volumeMultiplier: 3.0 },
  // C. OB 유효기간
  { ...BASE, name: '⑧ 임펄스3%+거래량2x+12봉유효', impulseMinPct: 3, volumeMultiplier: 2.0, obMaxAge: 12 },
  { ...BASE, name: '⑨ 임펄스3%+거래량2x+6봉유효',  impulseMinPct: 3, volumeMultiplier: 2.0, obMaxAge: 6 },
  // D. 최강 필터 조합
  { ...BASE, name: '⑩ 임펄스4%+거래량2.5x+12봉',  impulseMinPct: 4, volumeMultiplier: 2.5, obMaxAge: 12 },
];

const NOOB_SCENARIOS = [];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  새 엔진 백테스트 — 5중 필터 시스템 비교');
  console.log('  OB + HMA(20) + ADX(14)>25 + RSI(14)>50 + R:R');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. 거래대금 상위 15개 코인
  console.log('\n[1] 거래대금 상위 15개 코인 조회 중...');
  const topMarkets = await getTopMarkets(15);
  console.log(`    조회 완료: ${topMarkets.map(m => m.coin).join(', ')}`);

  // 2. 각 코인 5분봉 수집 (페이지네이션으로 최대 3일치=864봉)
  const PAGES = 4; // 200 × 4 = 800봉 (약 2.8일)
  console.log(`\n[2] 5분봉 데이터 수집 중 (${PAGES}페이지 × 200봉 = 최대 ${PAGES*200}봉)...`);
  const allCandles = {};
  for (const m of topMarkets) {
    try {
      let all = [];
      let lastTo = null;
      for (let page = 0; page < PAGES; page++) {
        let url = `/v1/candles/minutes/5?market=${m.market}&count=200`;
        if (lastTo) url += `&to=${lastTo}`;
        const { publicGet } = require('./upbit-api');
        // publicGet은 없으므로 getCandles 호출 방식 변경
        const raw = lastTo
          ? await new Promise((resolve, reject) => {
              const https = require('https');
              https.get(`https://api.upbit.com${url}`, { headers: { accept: 'application/json' } }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
              }).on('error', reject);
            })
          : await getCandles(m.market, 5, 200);

        if (!Array.isArray(raw) || raw.length === 0) break;
        all.push(...raw);
        // 다음 페이지: 현재 마지막 캔들의 시간 전으로
        lastTo = raw[raw.length - 1].candle_date_time_utc;
        await sleep(250);
      }
      // 중복 제거 후 정규화
      const uniqueMap = new Map();
      for (const c of all) uniqueMap.set(c.candle_date_time_kst, c);
      const normalized = normalizeCandles([...uniqueMap.values()]);
      if (normalized.length >= 50) {
        allCandles[m.market] = normalized;
        console.log(`    ${m.coin}: ${normalized.length}봉 수집`);
      } else {
        console.log(`    ${m.coin}: 데이터 부족 (${normalized.length}봉) — 스킵`);
      }
    } catch (e) {
      console.log(`    ${m.coin}: 오류 — ${e.message}`);
    }
    await sleep(200);
  }

  const markets = Object.keys(allCandles);
  console.log(`\n    총 ${markets.length}개 코인 데이터 확보`);

  // 3. 시나리오별 백테스트
  console.log('\n[3] 시나리오별 백테스트 실행 중...\n');
  const results = [];

  // A) OB 기반 전략들
  for (const scenario of OB_SCENARIOS) {
    const allTrades = [];
    for (const market of markets) {
      const trades = runBacktest(allCandles[market], market, scenario);
      allTrades.push(...trades);
    }
    const result = aggregateResults(allTrades, scenario.name);
    result.trades = allTrades;
    results.push(result);
  }

  // B) OB 없는 순수 지표 전략들
  for (const scenario of NOOB_SCENARIOS) {
    const allTrades = [];
    for (const market of markets) {
      const trades = runNoOBBacktest(allCandles[market], market, scenario);
      allTrades.push(...trades);
    }
    const result = aggregateResults(allTrades, scenario.name);
    result.trades = allTrades;
    results.push(result);
  }

  // 4. 결과 출력
  function printTable(label, rows) {
    console.log(`\n${label}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' 시나리오                        | 매매수 | 승 | 패 | 승률   | 평균익절 | 평균손절 | R:R  | 총손익(원)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const r of rows) {
      const name = r.scenarioName.padEnd(30);
      const pnl = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toLocaleString();
      console.log(` ${name} | ${String(r.total).padStart(4)} | ${String(r.wins).padStart(3)} | ${String(r.losses).padStart(3)} | ${(r.winRate+'%').padStart(6)} | ${((r.avgWin>0?'+':'')+r.avgWin.toFixed(2)+'%').padStart(8)} | ${(r.avgLoss.toFixed(2)+'%').padStart(8)} | ${r.rr.toFixed(2).padStart(4)} | ${pnl.padStart(10)}`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  printTable('[트레일링 스탑 비교] OB + R:R2 기준', results.sort((a,b) => b.totalPnl - a.totalPnl));

  console.log('\n * 투자금 100,000원 기준 복리 수익 / 수수료 0.1% / 3일치 데이터\n');

  // 각 시나리오별 청산 유형 통계
  console.log('\n─── 청산 유형별 통계 ───');
  console.log(' 시나리오                        | TP청산 | TRAIL청산 | SL청산 | 시간초과 | TRAIL평균익');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const r of results) {
    const trades = r.trades || [];
    const tp = trades.filter(t => t.exitType === 'TP').length;
    const trail = trades.filter(t => t.exitType === 'TRAIL');
    const sl = trades.filter(t => t.exitType === 'SL').length;
    const timeout = trades.filter(t => t.exitType === 'TIMEOUT').length;
    const trailAvg = trail.length > 0 ? (trail.reduce((s,t) => s + t.pnlPct, 0) / trail.length).toFixed(2) : '-';
    const name = r.scenarioName.padEnd(30);
    console.log(` ${name} | ${String(tp).padStart(6)} | ${String(trail.length).padStart(9)} | ${String(sl).padStart(6)} | ${String(timeout).padStart(8)} | ${String(trailAvg+'%').padStart(11)}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  백테스트 완료');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(e => {
  console.error('백테스트 실행 오류:', e.message);
  process.exit(1);
});
