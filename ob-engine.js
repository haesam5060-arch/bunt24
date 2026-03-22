/**
 * 오더블록(OB) 감지 엔진
 *
 * - 5분봉 데이터로 OB존 감지
 * - 실시간 가격으로 OB 터치 판단
 * - 진입/익절/손절 가격 계산
 */

// ── OB 감지 ───────────────────────────────────────
function detectOrderBlocks(candles, config) {
  const {
    impulseMinPct = 2.0,
    impulseLookback = 6,
    volumeMultiplier = 1.0,
    volumeAvgWindow = 20,
    obMaxAge = 24,
  } = config;

  // 평균 거래량 계산
  const avgVol = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < volumeAvgWindow) { avgVol.push(null); continue; }
    let sum = 0;
    for (let j = i - volumeAvgWindow; j < i; j++) sum += candles[j].volume;
    avgVol.push(sum / volumeAvgWindow);
  }

  const obs = [];
  const startIdx = volumeAvgWindow;
  const endIdx = candles.length - impulseLookback;

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i];

    // 음봉만
    if (c.close >= c.open) continue;

    // 거래량 조건
    if (volumeMultiplier > 1 && avgVol[i] && c.volume < avgVol[i] * volumeMultiplier) continue;

    // 이후 impulse 상승 확인
    let maxHigh = 0;
    for (let j = i + 1; j <= i + impulseLookback && j < candles.length; j++) {
      if (candles[j].high > maxHigh) maxHigh = candles[j].high;
    }

    const impulsePct = (maxHigh - c.close) / c.close * 100;
    if (impulsePct < impulseMinPct) continue;

    obs.push({
      index: i,
      time: c.time,
      top: c.open,       // 음봉 시가 = OB 상단
      bottom: c.close,    // 음봉 종가 = OB 하단
      swingHigh: maxHigh, // 직전 스윙 고점 (익절 타겟)
      impulsePct: +impulsePct.toFixed(2),
      used: false,
      broken: false,      // OB 무너졌는지
    });
  }

  return obs;
}

// ── OB 상태 업데이트 (무너진 OB 마킹) ─────────────
function updateOrderBlocks(obs, currentPrice, currentIndex, config) {
  const { obMaxAge = 24 } = config;

  for (const ob of obs) {
    if (ob.used || ob.broken) continue;

    // 유효기간 초과
    if (currentIndex - ob.index > obMaxAge) {
      ob.broken = true;
      continue;
    }

    // OB 하단 이탈 = 무너짐
    if (currentPrice < ob.bottom * (1 - (config.slPct || 0.8) / 100)) {
      ob.broken = true;
    }
  }

  return obs.filter(ob => !ob.broken && !ob.used);
}

// ── OB 터치 확인 ──────────────────────────────────
function checkOBTouch(activeOBs, currentPrice) {
  for (const ob of activeOBs) {
    if (ob.used) continue;

    // 가격이 OB존 범위 안에 들어왔는가
    if (currentPrice <= ob.top && currentPrice >= ob.bottom) {
      return ob;
    }
  }
  return null;
}

// ── 진입/익절/손절 가격 계산 ──────────────────────
function calcEntryExitPrices(ob, entryPrice, config) {
  const slPrice = ob.bottom * (1 - (config.slPct || 0.8) / 100);

  let tpPrice;
  if (config.tpMode === 'swing') {
    tpPrice = ob.swingHigh;
  } else if (config.tpMode === 'ratio') {
    const slDist = entryPrice - slPrice;
    tpPrice = entryPrice + slDist * (config.tpRatio || 2);
  } else {
    tpPrice = entryPrice * (1 + (config.tpFixedPct || 1.5) / 100);
  }

  return {
    entryPrice,
    tpPrice: +tpPrice.toFixed(2),
    slPrice: +slPrice.toFixed(2),
    riskPct: +((entryPrice - slPrice) / entryPrice * 100).toFixed(2),
    rewardPct: +((tpPrice - entryPrice) / entryPrice * 100).toFixed(2),
  };
}

// ── 5분봉 데이터 정규화 (업비트 API 형식 → 내부 형식) ──
function normalizeCandles(rawCandles) {
  return rawCandles
    .map(c => ({
      time: c.candle_date_time_kst,
      open: c.opening_price,
      high: c.high_price,
      low: c.low_price,
      close: c.trade_price,
      volume: c.candle_acc_trade_volume,
      value: c.candle_acc_trade_price,
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

module.exports = {
  detectOrderBlocks,
  updateOrderBlocks,
  checkOBTouch,
  calcEntryExitPrices,
  normalizeCandles,
};
