/**
 * 24번트 v3 — 레짐 적응형 멀티 전략 스코어링 엔진
 *
 * v2 → v3 주요 변경:
 *   - 평균회귀(RSI) 전략을 주력으로 승격 (가중 0.40)
 *   - BB 스퀴즈 / EMA 크로스 → 필터 역할로 강등 (가중 0.10씩)
 *   - 레짐 감지(ADX + ATR%) → 레짐에 맞지 않는 전략 차단
 *   - SL/TP: ATR×2.5, R:R 1:2, minSL 1.5% (스탑 헌팅 방지)
 *   - Fractional Kelly 포지션 사이징
 *   - 일일 손실 한도 체크
 *   - BUG-01, BUG-14, BUG-18 수정
 *
 * 전략 구성 (v3):
 *   1. RSI 평균회귀 — 0.40 (주력)
 *   2. BB 스퀴즈   — 0.10 (필터/확인)
 *   3. 변동성 돌파  — 0.20
 *   4. EMA 크로스   — 0.10 (필터/확인)
 *   5. OB 터치      — 0.20
 */

// ═══════════════════════════════════════════════════
// 기술 지표 계산 함수
// ═══════════════════════════════════════════════════

/** EMA (Exponential Moving Average) — BUG-01: 빈 배열 가드 */
function calcEMA(data, period) {
  if (!data || data.length === 0) return [];
  const ema = [data[0]];
  const k = 2 / (period + 1);
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

/** SMA (Simple Moving Average) */
function calcSMA(data, period) {
  const sma = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { sma.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    sma.push(sum / period);
  }
  return sma;
}

/** RSI (Relative Strength Index) */
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
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

/** ATR (Average True Range) */
function calcATR(highs, lows, closes, period = 14) {
  const atr = [null];
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
    if (i < period) { atr.push(null); continue; }
    if (i === period) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += trs[j];
      atr.push(sum / period);
    } else {
      atr.push((atr[i - 1] * (period - 1) + tr) / period);
    }
  }
  return atr;
}

/** ADX (Average Directional Index) — +DI, -DI도 함께 반환 */
function calcADX(highs, lows, closes, period = 14) {
  const len = highs.length;
  const result = { adx: new Array(len).fill(null), plusDI: new Array(len).fill(null), minusDI: new Array(len).fill(null) };
  const trArr = [], plusDMArr = [], minusDMArr = [];

  for (let i = 1; i < len; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    trArr.push(tr);
    plusDMArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  if (trArr.length < period) return result;

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
    const pDI = smoothTR ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mDI = smoothTR ? (smoothMinusDM / smoothTR) * 100 : 0;
    const idx = i; // candle index offset
    if (idx < len) {
      result.plusDI[idx] = pDI;
      result.minusDI[idx] = mDI;
    }
    const diSum = pDI + mDI;
    dxArr.push(diSum ? Math.abs(pDI - mDI) / diSum * 100 : 0);
  }

  if (dxArr.length < period) return result;

  let adxVal = 0;
  for (let i = 0; i < period; i++) adxVal += dxArr[i];
  adxVal /= period;

  const startIdx = period * 2;
  if (startIdx < len) result.adx[startIdx] = adxVal;

  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
    const idx = i + period + 1;
    if (idx < len) result.adx[idx] = adxVal;
  }
  return result;
}

/** 볼린저 밴드 (SMA 기반, 2σ) */
function calcBB(closes, period = 20, mult = 2) {
  const upper = [], middle = [], lower = [], bandwidth = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(null); middle.push(null); lower.push(null); bandwidth.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const sma = sum / period;

    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - sma) ** 2;
    const stddev = Math.sqrt(sqSum / period);

    middle.push(sma);
    upper.push(sma + stddev * mult);
    lower.push(sma - stddev * mult);
    bandwidth.push(sma > 0 ? (stddev * mult * 2) / sma * 100 : 0);
  }
  return { upper, middle, lower, bandwidth };
}

/** MACD */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macd = [];
  for (let i = 0; i < closes.length; i++) {
    macd.push(emaFast[i] - emaSlow[i]);
  }
  const signalLine = calcEMA(macd, signal);
  const histogram = macd.map((v, i) => v - signalLine[i]);
  return { macd, signal: signalLine, histogram };
}

/** VWAP (Volume Weighted Average Price) — 일중 리셋 */
function calcVWAP(candles) {
  const vwap = [];
  let cumVol = 0, cumTP = 0;
  let prevDay = null;

  for (const c of candles) {
    const day = c.time ? c.time.substring(0, 10) : null;
    if (day !== prevDay) {
      cumVol = 0;
      cumTP = 0;
      prevDay = day;
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumTP += tp * c.volume;
    vwap.push(cumVol > 0 ? cumTP / cumVol : c.close);
  }
  return vwap;
}

/** 거래량 이동평균 */
function calcVolMA(volumes, period = 20) {
  return calcSMA(volumes, period);
}

// ═══════════════════════════════════════════════════
// 레짐 감지 (v3 신규)
// ═══════════════════════════════════════════════════

/**
 * 시장 레짐 감지
 * - ADX > 25 → trending (추세)
 * - ADX < 20 → ranging  (횡보)
 * - 20~25    → transitioning (전환 중)
 * - ATR% = ATR/price × 100 (변동성 수준)
 *
 * @returns {{ regime: 'trending'|'ranging'|'transitioning', atrPct: number, adx: number|null }}
 */
function detectRegime(ind, i) {
  const adxVal = ind.adx.adx[i];
  const atr = ind.atr14[i];
  const price = ind.closes[i];

  const atrPct = (atr && price > 0) ? (atr / price) * 100 : 0;
  const adx = adxVal !== null ? adxVal : null;

  let regime = 'transitioning';
  if (adx !== null) {
    if (adx > 25) regime = 'trending';
    else if (adx < 20) regime = 'ranging';
  }

  return { regime, atrPct: +atrPct.toFixed(3), adx };
}

// ═══════════════════════════════════════════════════
// 전략 스코어링 시스템 (v3 개편)
// ═══════════════════════════════════════════════════

/**
 * 모든 지표를 한 번에 계산하여 캐시
 * BUG-18: candle validation — undefined close/high/low 필터링
 */
function computeIndicators(candles) {
  // BUG-18: 유효하지 않은 캔들 필터링
  const validCandles = candles.filter(c =>
    c.close !== undefined && c.close !== null &&
    c.high !== undefined && c.high !== null &&
    c.low !== undefined && c.low !== null
  );

  const closes = validCandles.map(c => c.close);
  const highs = validCandles.map(c => c.high);
  const lows = validCandles.map(c => c.low);
  const volumes = validCandles.map(c => c.volume || 0);

  return {
    closes, highs, lows, volumes,
    candles: validCandles,
    rsi14: calcRSI(closes, 14),
    rsi7: calcRSI(closes, 7),
    atr14: calcATR(highs, lows, closes, 14),
    adx: calcADX(highs, lows, closes, 14),
    bb: calcBB(closes, 20, 2),
    ema9: calcEMA(closes, 9),
    ema21: calcEMA(closes, 21),
    ema50: calcEMA(closes, 50),
    ema200: calcEMA(closes, 200),
    macd: calcMACD(closes, 12, 26, 9),
    vwap: calcVWAP(validCandles),
    volMA: calcVolMA(volumes, 20),
  };
}

/**
 * 전략 1: RSI 평균회귀 (v3 주력 — 가중 0.40)
 * - RSI(14) < 30 진입, 반등 확인
 * - VWAP 아래 = 보너스 (평균회귀 기대값 높음)
 * - 최근 스윙 로우 근접 = 지지 확인 보너스
 * - 거래량 확인
 */
function scoreRSIMeanReversion(ind, i) {
  const rsi = ind.rsi14[i];
  const rsiPrev = ind.rsi14[i - 1];
  if (rsi === null || rsiPrev === null) return 0;

  let score = 0;

  // RSI 과매도 구간 (v3: 점수 상향)
  if (rsi < 20) score += 45;
  else if (rsi < 25) score += 35;
  else if (rsi < 30) score += 25;
  else if (rsi < 35) score += 10;
  else return 0; // RSI > 35 → 신호 없음

  // RSI 반등 확인 (V자 반등)
  if (rsi > rsiPrev) score += 25;

  // RSI(7) 단기 과매도
  const rsi7 = ind.rsi7[i];
  if (rsi7 !== null && rsi7 < 25) score += 15;

  // v3: VWAP 확인 — 가격이 VWAP 아래 = 평균회귀 보너스
  const vwap = ind.vwap[i];
  const price = ind.closes[i];
  if (vwap && price < vwap) {
    const distPct = ((vwap - price) / vwap) * 100;
    if (distPct > 1.0) score += 20;       // VWAP 아래 1% 이상
    else if (distPct > 0.3) score += 12;  // VWAP 아래 0.3~1%
    else score += 5;
  }

  // v3: 최근 스윙 로우 근접 확인 (지지 레벨)
  if (i >= 20) {
    let swingLow = Infinity;
    for (let j = i - 20; j < i; j++) {
      if (ind.lows[j] < swingLow) swingLow = ind.lows[j];
    }
    const lowDist = ((price - swingLow) / swingLow) * 100;
    if (lowDist < 0.5) score += 15;       // 스윙 로우 0.5% 이내
    else if (lowDist < 1.5) score += 8;   // 1.5% 이내
  }

  // 거래량 확인 (평균 이상)
  const volMA = ind.volMA[i];
  if (volMA && ind.volumes[i] > volMA * 1.5) score += 20;
  else if (volMA && ind.volumes[i] > volMA) score += 10;

  return Math.min(score, 100);
}

/**
 * 전략 2: 볼린저 밴드 스퀴즈 (v3: 필터 역할로 강등)
 * - 최대 점수 60으로 하향
 * - 거래량 미확인 시 최대 30
 */
function scoreBBSqueeze(ind, i) {
  const bb = ind.bb;
  if (bb.bandwidth[i] === null || i < 25) return 0;

  let score = 0;
  let hasVolumeConfirm = false;

  // 스퀴즈 감지 (밴드폭이 최근 20봉 중 하위 25%)
  const recentBW = [];
  for (let j = Math.max(0, i - 20); j <= i; j++) {
    if (bb.bandwidth[j] !== null) recentBW.push(bb.bandwidth[j]);
  }
  if (recentBW.length < 10) return 0;

  recentBW.sort((a, b) => a - b);
  const pct25 = recentBW[Math.floor(recentBW.length * 0.25)];
  const isSqueezing = bb.bandwidth[i] <= pct25;

  if (!isSqueezing) return 0;
  score += 15;

  // 가격이 하단 밴드 터치 or 이탈
  const price = ind.closes[i];
  if (price <= bb.lower[i]) score += 15;
  else if (price <= bb.lower[i] * 1.005) score += 10; // 하단 근접 (0.5% 이내)

  // 반등 확인 (이전 봉 대비 가격 상승)
  if (ind.closes[i] > ind.closes[i - 1]) score += 10;

  // 거래량 확인 (v3: 없으면 최대 30)
  const volMA = ind.volMA[i];
  if (volMA && ind.volumes[i] > volMA * 1.5) {
    score += 15;
    hasVolumeConfirm = true;
  } else if (volMA && ind.volumes[i] > volMA) {
    score += 8;
    hasVolumeConfirm = true;
  }

  // v3: 거래량 미확인 시 최대 30, 전체 최대 60
  const maxScore = hasVolumeConfirm ? 60 : 30;
  return Math.min(score, maxScore);
}

/**
 * 전략 3: 변동성 돌파 (래리 윌리엄스)
 * - 당일 시가 + (전일 고가-전일 저가) × K
 * - BUG-14: open !== undefined 체크
 */
function scoreVolatilityBreakout(ind, i, candles, k = 0.5) {
  if (i < 2) return 0;

  const prevRange = ind.highs[i - 1] - ind.lows[i - 1];
  if (prevRange <= 0) return 0;

  // BUG-14: open 값 검증
  const open = candles[i].open;
  if (open === undefined || open === null) return 0;

  // 현재 봉의 시가 기준 돌파 레벨
  const breakoutLevel = open + prevRange * k;
  const price = ind.closes[i];

  if (price <= breakoutLevel) return 0;

  let score = 30; // 기본 돌파 점수

  // 돌파 강도
  const breakoutPct = (price - breakoutLevel) / breakoutLevel * 100;
  if (breakoutPct > 1.5) score += 30;
  else if (breakoutPct > 0.5) score += 20;
  else score += 10;

  // ATR 대비 돌파 크기
  const atr = ind.atr14[i];
  if (atr && (price - open) > atr * 0.5) score += 20;

  // 거래량 확인
  const volMA = ind.volMA[i];
  if (volMA && ind.volumes[i] > volMA * 2) score += 20;
  else if (volMA && ind.volumes[i] > volMA * 1.3) score += 10;

  return Math.min(score, 100);
}

/**
 * 전략 4: EMA 크로스 (v3: 필터 역할로 강등)
 * - 최대 점수 60
 * - ADX > 25 필수 (미충족 시 0점 반환)
 */
function scoreEMACross(ind, i) {
  if (i < 3) return 0;
  const ema9 = ind.ema9[i];
  const ema21 = ind.ema21[i];
  const ema50 = ind.ema50[i];
  const adxData = ind.adx;

  // v3: ADX > 25 필수 — 약한 추세에서 EMA 크로스는 무의미
  if (adxData.adx[i] === null || adxData.adx[i] <= 25) return 0;

  let score = 0;

  // EMA9 > EMA21 (단기 상승 추세)
  if (ema9 > ema21) score += 15;
  else return 0; // 기본 조건 미충족

  // EMA9 > EMA21 크로스 발생 (최근 3봉 내)
  for (let j = Math.max(1, i - 3); j <= i; j++) {
    if (ind.ema9[j] > ind.ema21[j] && ind.ema9[j - 1] <= ind.ema21[j - 1]) {
      score += 15; // 신규 크로스 보너스
      break;
    }
  }

  // 가격 > EMA50 (중기 상승)
  if (ind.closes[i] > ema50) score += 10;

  // +DI > -DI (상승 방향)
  if (adxData.plusDI[i] !== null && adxData.minusDI[i] !== null) {
    if (adxData.plusDI[i] > adxData.minusDI[i]) score += 10;
  }

  // MACD 히스토그램 양수
  if (ind.macd.histogram[i] > 0) score += 10;

  return Math.min(score, 60);
}

/**
 * 전략 5: OB 터치 (v3: 가중 0.20으로 승격)
 * - 기존 OB 감지 로직 활용
 * - 추가: EMA50 위 + RSI > 40 + 연속 음봉 아님
 */
function scoreOBTouch(ind, i, candles, activeOBs) {
  if (!activeOBs || activeOBs.length === 0) return 0;

  const price = ind.closes[i];

  // OB 터치 확인
  let touchedOB = null;
  for (const ob of activeOBs) {
    if (ob.used || ob.broken) continue;
    if (price <= ob.top && price >= ob.bottom) {
      touchedOB = ob;
      break;
    }
  }
  if (!touchedOB) return 0;

  let score = 25; // OB 터치 기본 점수

  // 추세 확인 (EMA50 위)
  if (ind.ema50[i] && price > ind.ema50[i]) score += 20;
  else score -= 10; // EMA 아래면 감점

  // RSI > 40 (과매도 아닌 건전한 눌림목)
  const rsi = ind.rsi14[i];
  if (rsi !== null && rsi > 40 && rsi < 70) score += 15;
  else if (rsi !== null && rsi <= 30) score += 5; // 과매도는 약간의 보너스

  // 연속 음봉 체크 (3봉 연속 음봉이면 감점)
  if (i >= 3) {
    const allBearish = candles.slice(i - 3, i).every(c => c.close < c.open);
    if (allBearish) score -= 20;
  }

  // 임펄스 강도 보너스
  if (touchedOB.impulsePct > 5) score += 15;
  else if (touchedOB.impulsePct > 3) score += 10;

  // 거래량
  const volMA = ind.volMA[i];
  if (volMA && ind.volumes[i] > volMA * 1.5) score += 15;

  return { score: Math.max(0, Math.min(score, 100)), ob: touchedOB };
}

/**
 * VWAP 위치 보너스 (추가 필터)
 * - 가격 > VWAP → 강세 확인
 */
function scoreVWAP(ind, i) {
  const vwap = ind.vwap[i];
  const price = ind.closes[i];
  if (!vwap) return 0;

  if (price > vwap * 1.005) return 15; // VWAP 위 0.5% 이상
  if (price > vwap) return 10;
  if (price > vwap * 0.995) return 5; // VWAP 근처
  return 0; // VWAP 아래
}

// ═══════════════════════════════════════════════════
// 종합 시그널 생성 (v3 레짐 적응형)
// ═══════════════════════════════════════════════════

/**
 * 진입 시그널 생성 (v3)
 *
 * @param {Object} ind - 계산된 지표들
 * @param {number} i - 현재 캔들 인덱스
 * @param {Array} candles - 캔들 배열
 * @param {Array} activeOBs - 활성 오더블록 (없으면 [])
 * @param {Object} params - 전략 파라미터
 *
 * @returns {Object|null} { score, strategies, sl, tp, atrSL, regime } 또는 null
 */
function generateSignal(ind, i, candles, activeOBs, params = {}) {
  const {
    minScore = 20,             // v4: 최소 진입 점수
    atrSlMultiplier = 3.5,     // v4: ATR × 3.5 = SL 거리 (v3: 2.5)
    rrRatio = 1.5,             // v4: R:R 1:1.5 (v3: 1:2)
    volatilityK = 0.5,        // 래리 윌리엄스 K값
    maxAtrSlPct = 5.0,        // v4: 최대 SL 5% (v3: 3%)
    minAtrSlPct = 2.5,        // v4: 최소 SL 2.5% (v3: 1.5%) — 노이즈 필터 강화
  } = params;

  if (i < 50) return null; // 최소 데이터 요구

  const price = ind.closes[i];
  const atr = ind.atr14[i];
  if (!atr || atr <= 0) return null;

  // ── v3: 레짐 감지 ──
  const regimeInfo = detectRegime(ind, i);

  // ── 각 전략 점수 계산 ──
  const scores = {
    rsiMR: scoreRSIMeanReversion(ind, i),
    bbSqueeze: scoreBBSqueeze(ind, i),
    volBreakout: scoreVolatilityBreakout(ind, i, candles, volatilityK),
    emaCross: scoreEMACross(ind, i),
  };

  // OB 전략은 특별 처리 (OB 객체도 반환)
  const obResult = scoreOBTouch(ind, i, candles, activeOBs);
  let obScore = 0, touchedOB = null;
  if (typeof obResult === 'object' && obResult !== null) {
    obScore = obResult.score;
    touchedOB = obResult.ob;
  }
  scores.obTouch = obScore;

  // ── v3: 레짐 기반 전략 감점 (zero-out → 감점 방식으로 변경) ──
  // ranging → 모멘텀 전략 70% 감점 (volBreakout, emaCross)
  // trending → 평균회귀 전략 70% 감점 (rsiMR, bbSqueeze, obTouch)
  // transitioning → 감점 없음
  if (regimeInfo.regime === 'ranging') {
    scores.volBreakout = Math.round(scores.volBreakout * 0.3);
    scores.emaCross = Math.round(scores.emaCross * 0.3);
  } else if (regimeInfo.regime === 'trending') {
    scores.rsiMR = Math.round(scores.rsiMR * 0.3);
    scores.bbSqueeze = Math.round(scores.bbSqueeze * 0.3);
    scores.obTouch = Math.round(scores.obTouch * 0.3);
  }

  const effectiveMinScore = minScore; // 레짐별 차별 제거, generateSignal 내부 감점으로 충분

  // VWAP 보너스 (독립 전략은 아님, 추가 확인)
  const vwapBonus = scoreVWAP(ind, i);

  // v3: 전략 가중치 변경
  const weights = {
    rsiMR: 0.40,       // v2: 0.25 → v3: 0.40 (주력)
    bbSqueeze: 0.10,   // v2: 0.15 → v3: 0.10 (필터)
    volBreakout: 0.20,  // 유지
    emaCross: 0.10,    // v2: 0.25 → v3: 0.10 (필터)
    obTouch: 0.20,     // v2: 0.15 → v3: 0.20 (승격)
  };

  let totalScore = 0;
  const activeStrategies = [];

  for (const [key, weight] of Object.entries(weights)) {
    const s = scores[key] * weight;
    totalScore += s;
    if (scores[key] >= 15) { // 의미있는 신호를 보낸 전략만 기록 (30→15, 레짐 감점 후에도 집계되도록)
      activeStrategies.push({ name: key, score: scores[key] });
    }
  }

  // VWAP 보너스 추가
  totalScore += vwapBonus * 0.1;
  if (vwapBonus >= 10) {
    activeStrategies.push({ name: 'vwap', score: vwapBonus });
  }

  // 최소 2개 이상의 전략이 신호를 보내야 함 (단일 전략 의존 방지)
  if (activeStrategies.length < 2) return null;

  // 임계값 미달
  if (totalScore < effectiveMinScore) return null;

  // ── ATR 기반 동적 SL/TP (v3: 더 넓은 SL, 더 높은 R:R) ──
  let slDistance = atr * atrSlMultiplier;
  let slPct = (slDistance / price) * 100;

  // SL 범위 제한
  slPct = Math.max(minAtrSlPct, Math.min(slPct, maxAtrSlPct));
  slDistance = price * slPct / 100;

  const sl = price - slDistance;
  const tp = price + slDistance * rrRatio;

  return {
    score: +totalScore.toFixed(1),
    strategies: activeStrategies,
    price,
    sl: +sl.toFixed(2),
    tp: +tp.toFixed(2),
    slPct: +slPct.toFixed(2),
    tpPct: +(slPct * rrRatio).toFixed(2),
    atr: +atr.toFixed(2),
    touchedOB,
    vwapBonus,
    regime: regimeInfo, // v3: 레짐 정보 포함
  };
}

// ═══════════════════════════════════════════════════
// 코인 필터링
// ═══════════════════════════════════════════════════

/**
 * 코인 적합성 점수 (스캔 시 사용)
 * - 거래대금, 가격, 변동성 기반 필터
 */
function scoreCoinSuitability(ticker) {
  let score = 0;

  // 가격 필터 (100원 이상 → 호가 단위 유리)
  if (ticker.price >= 1000) score += 30;
  else if (ticker.price >= 500) score += 20;
  else if (ticker.price >= 100) score += 10;
  else return 0; // 100원 미만 제외

  // 24시간 거래대금 (최소 10억 이상)
  const vol24h = ticker.volume24h || 0;
  if (vol24h >= 50e9) score += 30;       // 500억 이상
  else if (vol24h >= 10e9) score += 20;  // 100억 이상
  else if (vol24h >= 3e9) score += 10;   // 30억 이상
  else return 0; // 30억 미만 제외

  // 변동률 (적절한 변동성 선호)
  const changeRate = Math.abs(ticker.changeRate || 0) * 100;
  if (changeRate >= 2 && changeRate <= 10) score += 20; // 적당한 변동
  else if (changeRate >= 1 && changeRate <= 15) score += 10;
  // 변동이 거의 없거나 너무 크면 보너스 없음

  return score;
}

// ═══════════════════════════════════════════════════
// 시간 필터
// ═══════════════════════════════════════════════════

/**
 * 시간대 적합성 (KST 기준)
 * - 03:00~07:00 비활성 (유동성 부족)
 * - 09:00~10:00 위험 (변동성 과다)
 * - 최적: 10:00~23:00
 */
function isGoodTradingHour(hour) {
  if (hour >= 3 && hour <= 7) return false;  // 새벽 비활성
  return true;
}

/**
 * 시간대 보너스 점수
 */
function getTimeBonus(hour) {
  if (hour >= 10 && hour <= 15) return 10; // 한국 장중 최적
  if (hour >= 21 && hour <= 23) return 8;  // 미국 장 시작
  if (hour >= 16 && hour <= 20) return 5;  // 일반
  if (hour >= 8 && hour <= 9) return 0;    // 변동 구간
  return -5; // 새벽
}

// ═══════════════════════════════════════════════════
// 리스크 관리 (v3 확장)
// ═══════════════════════════════════════════════════

/**
 * 변동성 기반 포지션 사이징 (기존 유지)
 * - ATR이 클수록 → 작은 포지션
 * - ATR이 작을수록 → 큰 포지션
 * - 최대 손실을 총자산의 1%로 제한
 */
function calcPositionSize(totalCapital, atr, entryPrice, slPrice, maxRiskPct = 1.0) {
  const riskAmount = totalCapital * (maxRiskPct / 100);
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance <= 0) return 0;

  // 손실 제한 기준 최대 투자금
  const maxPosition = (riskAmount / slDistance) * entryPrice;

  // 총자산의 maxPositions 분할 기준 투자금
  const maxAlloc = totalCapital * 0.33; // 최대 33% 단일 포지션

  return Math.min(maxPosition, maxAlloc);
}

/**
 * v3: Fractional Kelly 포지션 사이징
 *
 * Kelly% = winRate - (1 - winRate) / (avgWin / avgLoss)
 * Quarter Kelly = Kelly% × 0.25 (안전 마진)
 * 결과를 자본의 1~5% 범위로 clamp
 *
 * @param {number} totalCapital - 총 자본금
 * @param {number} winRate - 승률 (0~1)
 * @param {number} avgWin - 평균 수익 금액 (양수)
 * @param {number} avgLoss - 평균 손실 금액 (양수)
 * @param {number} maxRiskPct - 최대 리스크% (기본 5%)
 * @returns {number} 투자할 금액
 */
function calcKellyPositionSize(totalCapital, winRate, avgWin, avgLoss, maxRiskPct = 5.0) {
  // 트레이드 히스토리 부족 시 보수적 폴백
  if (!winRate || !avgWin || !avgLoss || avgLoss <= 0 || avgWin <= 0) {
    return totalCapital * 0.01; // 고정 1% 리스크
  }

  const payoffRatio = avgWin / avgLoss;
  const kellyPct = winRate - (1 - winRate) / payoffRatio;

  // Kelly가 음수 → 손실 예상 전략, 최소값으로 폴백
  if (kellyPct <= 0) {
    return totalCapital * 0.01;
  }

  // Quarter Kelly (0.25배) 적용
  const quarterKelly = kellyPct * 0.25;

  // 1% ~ maxRiskPct 범위로 clamp
  const clampedPct = Math.max(0.01, Math.min(quarterKelly, maxRiskPct / 100));

  return totalCapital * clampedPct;
}

/**
 * v3: 일일 손실 한도 체크
 *
 * @param {number} dailyPnl - 당일 누적 손익 (음수 = 손실)
 * @param {number} totalCapital - 총 자본금
 * @param {number} maxDailyLossPct - 최대 일일 손실 한도% (기본 -3%)
 * @returns {boolean} true = 한도 초과 → 거래 중단
 */
function checkDailyLossLimit(dailyPnl, totalCapital, maxDailyLossPct = -3) {
  if (!totalCapital || totalCapital <= 0) return true; // 자본 정보 없으면 안전 차단
  const lossPct = (dailyPnl / totalCapital) * 100;
  return lossPct <= maxDailyLossPct;
}

// ═══════════════════════════════════════════════════
// 모듈 내보내기
// ═══════════════════════════════════════════════════

module.exports = {
  // 지표 계산
  calcEMA, calcSMA, calcRSI, calcATR, calcADX, calcBB, calcMACD, calcVWAP, calcVolMA,
  // 종합 분석
  computeIndicators,
  generateSignal,
  // 레짐 감지 (v3 신규)
  detectRegime,
  // 개별 전략 점수
  scoreRSIMeanReversion,
  scoreBBSqueeze,
  scoreVolatilityBreakout,
  scoreEMACross,
  scoreOBTouch,
  scoreVWAP,
  // 유틸
  scoreCoinSuitability,
  isGoodTradingHour,
  getTimeBonus,
  calcPositionSize,
  // v3 리스크 관리
  calcKellyPositionSize,
  checkDailyLossLimit,
};
