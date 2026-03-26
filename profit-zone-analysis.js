/**
 * 수익 구간 분석기 (Profit Zone Analyzer)
 *
 * 목적: 업비트 전 종목 1분봉 + 틱 데이터로
 *       5분 내 0.5~1% 수익 구간의 공통 패턴 발견
 *
 * 2단계 분석:
 *   Phase 1: 1분봉 7일치로 전 종목 수익 구간 스캔
 *   Phase 2: 발견된 수익 구간을 틱 레벨로 심층 분석
 */

const https = require('https');

// ── 설정 ────────────────────────────────────────
const TARGET_PROFIT_MIN = 0.5;   // 최소 수익률 %
const TARGET_PROFIT_MAX = 1.5;   // 최대 수익률 % (1% 약간 넘는 것도 포함)
const WINDOW_MINUTES = 5;        // 매매 윈도우 (분)
const CANDLE_DAYS = 7;           // 분석 기간 (일)
const MIN_VOLUME_KRW = 500000000; // 최소 24h 거래대금 5억원 (유동성 필터)
const API_DELAY = 120;           // API 호출 간격 ms (rate limit)
const MAX_COINS = 243;           // 전 종목

// ── HTTP 유틸 ───────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Phase 1: 1분봉 수익 구간 스캔 ──────────────
async function getCandles1m(market, count = 200, to = null) {
  let url = `https://api.upbit.com/v1/candles/minutes/1?market=${market}&count=${count}`;
  if (to) url += `&to=${to}`;
  return httpGet(url);
}

async function getAllCandles1m(market, days) {
  const totalCandles = days * 24 * 60; // 7일 = 10080봉
  const allCandles = [];
  let to = null;

  while (allCandles.length < totalCandles) {
    try {
      const batch = await getCandles1m(market, 200, to);
      if (!batch || !Array.isArray(batch) || batch.length === 0) break;
      if (batch.error) { console.error(`  API error for ${market}:`, batch.error.message); break; }
      allCandles.push(...batch);
      // to 파라미터: UTC 시간 그대로 (Z 안 붙임)
      to = batch[batch.length - 1].candle_date_time_utc;
      if (batch.length < 200) break;
      await sleep(API_DELAY);
    } catch (err) {
      console.error(`  fetch error for ${market}: ${err.message}`);
      break;
    }
  }

  // 시간순 정렬 (오래된 것 먼저)
  allCandles.sort((a, b) => new Date(a.candle_date_time_utc) - new Date(b.candle_date_time_utc));
  return allCandles;
}

/**
 * 1분봉에서 5분 윈도우 슬라이딩하며 수익 구간 탐색
 *
 * 진입: 각 봉의 시가(open)에 매수한다고 가정
 * 청산: 이후 5분(5봉) 내 최고가(high)에서 매도
 * 수익률 = (윈도우 내 최고가 - 진입가) / 진입가 * 100
 */
function findProfitZones(candles, market) {
  const zones = [];

  for (let i = 0; i < candles.length - WINDOW_MINUTES; i++) {
    const entryCandle = candles[i];
    const entryPrice = entryCandle.opening_price;
    if (entryPrice <= 0) continue;

    // 5분 윈도우 내 최고가/최저가 찾기
    let windowHigh = entryPrice;
    let windowLow = entryPrice;
    let windowHighIdx = i;
    let windowLowIdx = i;
    let windowVolume = 0;
    let windowTradeCount = 0;

    for (let j = i; j < Math.min(i + WINDOW_MINUTES, candles.length); j++) {
      const c = candles[j];
      if (c.high_price > windowHigh) {
        windowHigh = c.high_price;
        windowHighIdx = j;
      }
      if (c.low_price < windowLow) {
        windowLow = c.low_price;
        windowLowIdx = j;
      }
      windowVolume += c.candle_acc_trade_volume || 0;
      windowTradeCount += 1;
    }

    // 롱(매수) 수익률
    const longProfit = (windowHigh - entryPrice) / entryPrice * 100;

    // 숏(저점 매수 → 고점 매도) 수익률 (저점이 고점보다 먼저 나온 경우)
    // = 윈도우 내에서 먼저 떨어지고 올라간 경우

    if (longProfit >= TARGET_PROFIT_MIN && longProfit <= TARGET_PROFIT_MAX) {
      // 진입 전 5봉 컨텍스트 (직전 상황)
      const prevCandles = candles.slice(Math.max(0, i - 10), i);

      // 직전 5봉 가격 변화율
      const prev5Price = i >= 5 ? candles[i - 5].opening_price : candles[0].opening_price;
      const prevTrend = (entryPrice - prev5Price) / prev5Price * 100;

      // 직전 10봉 가격 변화율
      const prev10Price = i >= 10 ? candles[i - 10].opening_price : candles[0].opening_price;
      const prevTrend10 = (entryPrice - prev10Price) / prev10Price * 100;

      // 직전 5봉 거래량 평균
      const prevVolumes = prevCandles.slice(-5).map(c => c.candle_acc_trade_volume || 0);
      const avgPrevVolume = prevVolumes.length > 0 ? prevVolumes.reduce((a, b) => a + b, 0) / prevVolumes.length : 0;

      // 진입봉 거래량 대비 직전 평균
      const volumeRatio = avgPrevVolume > 0 ? (entryCandle.candle_acc_trade_volume || 0) / avgPrevVolume : 0;

      // 직전 변동성 (high-low range 평균)
      const prevRanges = prevCandles.map(c => c.high_price > 0 ? (c.high_price - c.low_price) / c.low_price * 100 : 0);
      const avgPrevRange = prevRanges.length > 0 ? prevRanges.reduce((a, b) => a + b, 0) / prevRanges.length : 0;

      // 진입봉 위치 (봉 내에서 시가 위치: 0=저점, 1=고점)
      const candleRange = entryCandle.high_price - entryCandle.low_price;
      const openPosition = candleRange > 0 ? (entryCandle.opening_price - entryCandle.low_price) / candleRange : 0.5;

      // 봉 색상 (양봉/음봉)
      const isBullish = entryCandle.trade_price >= entryCandle.opening_price;

      // 시간대
      const hour = new Date(entryCandle.candle_date_time_kst || entryCandle.candle_date_time_utc).getHours();
      const dayOfWeek = new Date(entryCandle.candle_date_time_kst || entryCandle.candle_date_time_utc).getDay();

      // 최고가 도달 시간 (진입 후 몇 분)
      const minutesToPeak = windowHighIdx - i;

      // RSI-like: 직전 14봉의 상승/하락 비율
      const rsiCandles = candles.slice(Math.max(0, i - 14), i);
      let gains = 0, lossSum = 0, gainCount = 0, lossCount = 0;
      for (let k = 1; k < rsiCandles.length; k++) {
        const diff = rsiCandles[k].trade_price - rsiCandles[k - 1].trade_price;
        if (diff > 0) { gains += diff; gainCount++; }
        else { lossSum += Math.abs(diff); lossCount++; }
      }
      const avgGain = rsiCandles.length > 1 ? gains / (rsiCandles.length - 1) : 0;
      const avgLoss = rsiCandles.length > 1 ? lossSum / (rsiCandles.length - 1) : 0;
      const rsi14 = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

      // 연속 음봉/양봉 카운트
      let consecutiveBear = 0;
      for (let k = prevCandles.length - 1; k >= 0; k--) {
        if (prevCandles[k].trade_price < prevCandles[k].opening_price) consecutiveBear++;
        else break;
      }
      let consecutiveBull = 0;
      for (let k = prevCandles.length - 1; k >= 0; k--) {
        if (prevCandles[k].trade_price >= prevCandles[k].opening_price) consecutiveBull++;
        else break;
      }

      // 윈도우 내 최저가 (최대 손실 = 드로우다운)
      const maxDrawdown = (entryPrice - windowLow) / entryPrice * 100;

      zones.push({
        market,
        time: entryCandle.candle_date_time_kst || entryCandle.candle_date_time_utc,
        hour,
        dayOfWeek,
        entryPrice,
        exitPrice: windowHigh,
        profit: longProfit,
        maxDrawdown,
        minutesToPeak,

        // 컨텍스트 피처
        prevTrend5m: prevTrend,
        prevTrend10m: prevTrend10,
        volumeRatio,
        avgPrevRange,
        openPosition,
        isBullish,
        rsi14,
        consecutiveBear,
        consecutiveBull,
        windowVolume,
        entryVolume: entryCandle.candle_acc_trade_volume || 0,
      });
    }
  }

  return zones;
}

// ── Phase 2: 틱 레벨 심층 분석 ─────────────────
async function getTickData(market, count = 500, to = null) {
  let url = `https://api.upbit.com/v1/trades/ticks?market=${market}&count=${count}`;
  if (to) url += `&cursor=${to}`;
  return httpGet(url);
}

// ── 통계 분석 함수 ─────────────────────────────
function analyzePatterns(allZones) {
  if (allZones.length === 0) {
    console.log('수익 구간이 발견되지 않았습니다.');
    return;
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  수 익 구 간 공 통 패 턴 분 석 리 포 트');
  console.log('═'.repeat(70));
  console.log(`\n총 발견 수익 구간: ${allZones.length}건`);
  console.log(`분석 대상: 5분 내 ${TARGET_PROFIT_MIN}~${TARGET_PROFIT_MAX}% 수익 구간\n`);

  // ── 1. 기본 통계 ──
  const profits = allZones.map(z => z.profit);
  const drawdowns = allZones.map(z => z.maxDrawdown);
  console.log('── 1. 수익률 분포 ──');
  console.log(`  평균 수익률: ${avg(profits).toFixed(3)}%`);
  console.log(`  중앙값 수익률: ${median(profits).toFixed(3)}%`);
  console.log(`  평균 최대 드로우다운: ${avg(drawdowns).toFixed(3)}%`);
  console.log(`  드로우다운 중앙값: ${median(drawdowns).toFixed(3)}%`);
  console.log(`  수익/드로우다운 비율: ${(avg(profits) / Math.max(avg(drawdowns), 0.001)).toFixed(2)}`);

  // ── 2. 최고가 도달 시간 ──
  const peakTimes = allZones.map(z => z.minutesToPeak);
  console.log('\n── 2. 최고가 도달 시간 (진입 후 몇 분) ──');
  for (let m = 0; m < WINDOW_MINUTES; m++) {
    const count = peakTimes.filter(t => t === m).length;
    const pct = (count / allZones.length * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(count / allZones.length * 40));
    console.log(`  ${m}분: ${count}건 (${pct}%) ${bar}`);
  }

  // ── 3. 시간대별 분포 ──
  console.log('\n── 3. 시간대별 분포 (KST) ──');
  const hourBuckets = {};
  allZones.forEach(z => {
    const h = z.hour;
    if (!hourBuckets[h]) hourBuckets[h] = { count: 0, totalProfit: 0 };
    hourBuckets[h].count++;
    hourBuckets[h].totalProfit += z.profit;
  });
  const sortedHours = Object.keys(hourBuckets).map(Number).sort((a, b) => a - b);
  for (const h of sortedHours) {
    const b = hourBuckets[h];
    const pct = (b.count / allZones.length * 100).toFixed(1);
    const avgP = (b.totalProfit / b.count).toFixed(3);
    const bar = '█'.repeat(Math.round(b.count / allZones.length * 30));
    console.log(`  ${String(h).padStart(2, '0')}시: ${String(b.count).padStart(5)}건 (${pct.padStart(5)}%) 평균${avgP}% ${bar}`);
  }

  // ── 4. 요일별 분포 ──
  console.log('\n── 4. 요일별 분포 ──');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayBuckets = {};
  allZones.forEach(z => {
    const d = z.dayOfWeek;
    if (!dayBuckets[d]) dayBuckets[d] = { count: 0, totalProfit: 0 };
    dayBuckets[d].count++;
    dayBuckets[d].totalProfit += z.profit;
  });
  for (let d = 0; d < 7; d++) {
    if (dayBuckets[d]) {
      const b = dayBuckets[d];
      const pct = (b.count / allZones.length * 100).toFixed(1);
      console.log(`  ${dayNames[d]}요일: ${b.count}건 (${pct}%) 평균${(b.totalProfit / b.count).toFixed(3)}%`);
    }
  }

  // ── 5. 직전 추세별 분석 (핵심!) ──
  console.log('\n── 5. 직전 5분 추세별 분석 (핵심 피처) ──');
  const trendBuckets = [
    { name: '급락 (<-1%)', filter: z => z.prevTrend5m < -1 },
    { name: '하락 (-1~-0.3%)', filter: z => z.prevTrend5m >= -1 && z.prevTrend5m < -0.3 },
    { name: '약하락 (-0.3~0%)', filter: z => z.prevTrend5m >= -0.3 && z.prevTrend5m < 0 },
    { name: '약상승 (0~0.3%)', filter: z => z.prevTrend5m >= 0 && z.prevTrend5m < 0.3 },
    { name: '상승 (0.3~1%)', filter: z => z.prevTrend5m >= 0.3 && z.prevTrend5m < 1 },
    { name: '급상승 (>1%)', filter: z => z.prevTrend5m >= 1 },
  ];
  for (const bucket of trendBuckets) {
    const matched = allZones.filter(bucket.filter);
    if (matched.length > 0) {
      const pct = (matched.length / allZones.length * 100).toFixed(1);
      const avgProfit = avg(matched.map(z => z.profit)).toFixed(3);
      const avgDD = avg(matched.map(z => z.maxDrawdown)).toFixed(3);
      console.log(`  ${bucket.name.padEnd(20)}: ${String(matched.length).padStart(5)}건 (${pct.padStart(5)}%) 수익${avgProfit}% DD${avgDD}%`);
    }
  }

  // ── 6. RSI 구간별 분석 ──
  console.log('\n── 6. RSI(14) 구간별 분석 ──');
  const rsiBuckets = [
    { name: '과매도 (<30)', filter: z => z.rsi14 < 30 },
    { name: '약과매도 (30-40)', filter: z => z.rsi14 >= 30 && z.rsi14 < 40 },
    { name: '중립하단 (40-50)', filter: z => z.rsi14 >= 40 && z.rsi14 < 50 },
    { name: '중립상단 (50-60)', filter: z => z.rsi14 >= 50 && z.rsi14 < 60 },
    { name: '약과매수 (60-70)', filter: z => z.rsi14 >= 60 && z.rsi14 < 70 },
    { name: '과매수 (>70)', filter: z => z.rsi14 >= 70 },
  ];
  for (const bucket of rsiBuckets) {
    const matched = allZones.filter(bucket.filter);
    if (matched.length > 0) {
      const pct = (matched.length / allZones.length * 100).toFixed(1);
      const avgProfit = avg(matched.map(z => z.profit)).toFixed(3);
      console.log(`  ${bucket.name.padEnd(20)}: ${String(matched.length).padStart(5)}건 (${pct.padStart(5)}%) 평균수익${avgProfit}%`);
    }
  }

  // ── 7. 거래량 비율별 분석 ──
  console.log('\n── 7. 진입봉 거래량 비율 (직전5봉 평균 대비) ──');
  const volBuckets = [
    { name: '매우 적음 (<0.5x)', filter: z => z.volumeRatio < 0.5 },
    { name: '적음 (0.5-1x)', filter: z => z.volumeRatio >= 0.5 && z.volumeRatio < 1 },
    { name: '보통 (1-1.5x)', filter: z => z.volumeRatio >= 1 && z.volumeRatio < 1.5 },
    { name: '많음 (1.5-3x)', filter: z => z.volumeRatio >= 1.5 && z.volumeRatio < 3 },
    { name: '폭증 (3-5x)', filter: z => z.volumeRatio >= 3 && z.volumeRatio < 5 },
    { name: '급폭증 (>5x)', filter: z => z.volumeRatio >= 5 },
  ];
  for (const bucket of volBuckets) {
    const matched = allZones.filter(bucket.filter);
    if (matched.length > 0) {
      const pct = (matched.length / allZones.length * 100).toFixed(1);
      const avgProfit = avg(matched.map(z => z.profit)).toFixed(3);
      const avgDD = avg(matched.map(z => z.maxDrawdown)).toFixed(3);
      console.log(`  ${bucket.name.padEnd(20)}: ${String(matched.length).padStart(5)}건 (${pct.padStart(5)}%) 수익${avgProfit}% DD${avgDD}%`);
    }
  }

  // ── 8. 연속 음봉 분석 ──
  console.log('\n── 8. 진입 전 연속 음봉 수 ──');
  const bearBuckets = {};
  allZones.forEach(z => {
    const key = Math.min(z.consecutiveBear, 5); // 5+ 합산
    if (!bearBuckets[key]) bearBuckets[key] = { count: 0, totalProfit: 0 };
    bearBuckets[key].count++;
    bearBuckets[key].totalProfit += z.profit;
  });
  for (const k of Object.keys(bearBuckets).sort((a, b) => a - b)) {
    const b = bearBuckets[k];
    const label = k == 5 ? '5+' : k;
    console.log(`  ${label}연속 음봉: ${b.count}건 (${(b.count / allZones.length * 100).toFixed(1)}%) 평균수익${(b.totalProfit / b.count).toFixed(3)}%`);
  }

  // ── 9. 변동성 구간별 ──
  console.log('\n── 9. 직전 평균 변동성(봉 range) 구간별 ──');
  const rangeBuckets = [
    { name: '매우 낮음 (<0.2%)', filter: z => z.avgPrevRange < 0.2 },
    { name: '낮음 (0.2-0.5%)', filter: z => z.avgPrevRange >= 0.2 && z.avgPrevRange < 0.5 },
    { name: '보통 (0.5-1%)', filter: z => z.avgPrevRange >= 0.5 && z.avgPrevRange < 1 },
    { name: '높음 (1-2%)', filter: z => z.avgPrevRange >= 1 && z.avgPrevRange < 2 },
    { name: '매우 높음 (>2%)', filter: z => z.avgPrevRange >= 2 },
  ];
  for (const bucket of rangeBuckets) {
    const matched = allZones.filter(bucket.filter);
    if (matched.length > 0) {
      const pct = (matched.length / allZones.length * 100).toFixed(1);
      const avgProfit = avg(matched.map(z => z.profit)).toFixed(3);
      const avgDD = avg(matched.map(z => z.maxDrawdown)).toFixed(3);
      console.log(`  ${bucket.name.padEnd(22)}: ${String(matched.length).padStart(5)}건 (${pct.padStart(5)}%) 수익${avgProfit}% DD${avgDD}%`);
    }
  }

  // ── 10. 진입봉 양봉/음봉 ──
  console.log('\n── 10. 진입봉 양봉/음봉 ──');
  const bulls = allZones.filter(z => z.isBullish);
  const bears = allZones.filter(z => !z.isBullish);
  console.log(`  양봉 진입: ${bulls.length}건 (${(bulls.length / allZones.length * 100).toFixed(1)}%) 평균수익${avg(bulls.map(z => z.profit)).toFixed(3)}% DD${avg(bulls.map(z => z.maxDrawdown)).toFixed(3)}%`);
  console.log(`  음봉 진입: ${bears.length}건 (${(bears.length / allZones.length * 100).toFixed(1)}%) 평균수익${avg(bears.map(z => z.profit)).toFixed(3)}% DD${avg(bears.map(z => z.maxDrawdown)).toFixed(3)}%`);

  // ── 11. 종목별 수익 구간 빈도 TOP 20 ──
  console.log('\n── 11. 종목별 수익 구간 빈도 TOP 30 ──');
  const coinCounts = {};
  allZones.forEach(z => {
    const coin = z.market.replace('KRW-', '');
    if (!coinCounts[coin]) coinCounts[coin] = { count: 0, totalProfit: 0, totalDD: 0 };
    coinCounts[coin].count++;
    coinCounts[coin].totalProfit += z.profit;
    coinCounts[coin].totalDD += z.maxDrawdown;
  });
  const sortedCoins = Object.entries(coinCounts).sort((a, b) => b[1].count - a[1].count);
  for (const [coin, d] of sortedCoins.slice(0, 30)) {
    const avgP = (d.totalProfit / d.count).toFixed(3);
    const avgDD = (d.totalDD / d.count).toFixed(3);
    console.log(`  ${coin.padEnd(10)}: ${String(d.count).padStart(5)}건 평균수익${avgP}% DD${avgDD}%`);
  }

  // ── 12. 복합 조건 분석 (가장 중요!) ──
  console.log('\n── 12. 고승률 복합 조건 탐색 ──');

  // 조건 조합을 테스트
  const conditions = [
    { name: 'RSI<40 + 거래량>1.5x', filter: z => z.rsi14 < 40 && z.volumeRatio > 1.5 },
    { name: 'RSI<40 + 급락후', filter: z => z.rsi14 < 40 && z.prevTrend5m < -0.3 },
    { name: 'RSI<30 + 연속음봉3+', filter: z => z.rsi14 < 30 && z.consecutiveBear >= 3 },
    { name: '거래량폭증>3x + 양봉', filter: z => z.volumeRatio > 3 && z.isBullish },
    { name: '거래량폭증>3x + 상승추세', filter: z => z.volumeRatio > 3 && z.prevTrend5m > 0 },
    { name: '급락>1% + RSI<40', filter: z => z.prevTrend5m < -1 && z.rsi14 < 40 },
    { name: '급락>1% + 거래량>2x', filter: z => z.prevTrend5m < -1 && z.volumeRatio > 2 },
    { name: '변동성높음>1% + RSI<40', filter: z => z.avgPrevRange > 1 && z.rsi14 < 40 },
    { name: '변동성높음>1% + 거래량>2x', filter: z => z.avgPrevRange > 1 && z.volumeRatio > 2 },
    { name: '연속음봉3+ + 거래량>1.5x', filter: z => z.consecutiveBear >= 3 && z.volumeRatio > 1.5 },
    { name: 'RSI<35 + 변동성>0.5% + 거래량>1.5x', filter: z => z.rsi14 < 35 && z.avgPrevRange > 0.5 && z.volumeRatio > 1.5 },
    { name: '급락+RSI<35+거래량>2x', filter: z => z.prevTrend5m < -0.5 && z.rsi14 < 35 && z.volumeRatio > 2 },
    { name: '상승추세+거래량폭증+양봉', filter: z => z.prevTrend5m > 0.3 && z.volumeRatio > 3 && z.isBullish },
    { name: '09-11시 + RSI<40', filter: z => z.hour >= 9 && z.hour <= 11 && z.rsi14 < 40 },
    { name: '급락>0.5% + DD<0.3%', filter: z => z.prevTrend5m < -0.5 && z.maxDrawdown < 0.3 },
    { name: '변동성>1% + DD<0.3%', filter: z => z.avgPrevRange > 1 && z.maxDrawdown < 0.3 },
  ];

  console.log(`  ${'조건'.padEnd(35)} ${'건수'.padStart(6)} ${'비율'.padStart(7)} ${'평균수익'.padStart(8)} ${'평균DD'.padStart(8)} ${'수익/DD'.padStart(8)}`);
  console.log('  ' + '-'.repeat(80));

  for (const cond of conditions) {
    const matched = allZones.filter(cond.filter);
    if (matched.length >= 5) { // 최소 5건 이상
      const pct = (matched.length / allZones.length * 100).toFixed(1);
      const avgProfit = avg(matched.map(z => z.profit));
      const avgDD = avg(matched.map(z => z.maxDrawdown));
      const ratio = avgDD > 0 ? (avgProfit / avgDD).toFixed(2) : '∞';
      console.log(`  ${cond.name.padEnd(35)} ${String(matched.length).padStart(6)} ${(pct + '%').padStart(7)} ${avgProfit.toFixed(3).padStart(8)}% ${avgDD.toFixed(3).padStart(7)}% ${String(ratio).padStart(8)}`);
    }
  }

  // ── 13. "이상적 구간" 프로파일 (DD < 수익의 절반) ──
  console.log('\n── 13. 이상적 구간 (DD < 수익/2) 프로파일 ──');
  const ideal = allZones.filter(z => z.maxDrawdown < z.profit / 2);
  console.log(`  이상적 구간: ${ideal.length}건 / ${allZones.length}건 (${(ideal.length / allZones.length * 100).toFixed(1)}%)`);
  if (ideal.length > 0) {
    console.log(`  평균 수익: ${avg(ideal.map(z => z.profit)).toFixed(3)}%`);
    console.log(`  평균 DD: ${avg(ideal.map(z => z.maxDrawdown)).toFixed(3)}%`);
    console.log(`  평균 RSI: ${avg(ideal.map(z => z.rsi14)).toFixed(1)}`);
    console.log(`  평균 거래량비율: ${avg(ideal.map(z => z.volumeRatio)).toFixed(2)}x`);
    console.log(`  평균 직전추세: ${avg(ideal.map(z => z.prevTrend5m)).toFixed(3)}%`);
    console.log(`  평균 변동성: ${avg(ideal.map(z => z.avgPrevRange)).toFixed(3)}%`);
    console.log(`  양봉 비율: ${(ideal.filter(z => z.isBullish).length / ideal.length * 100).toFixed(1)}%`);
    console.log(`  평균 연속음봉: ${avg(ideal.map(z => z.consecutiveBear)).toFixed(1)}`);

    // 이상적 구간 시간대 TOP 5
    const idealHours = {};
    ideal.forEach(z => { idealHours[z.hour] = (idealHours[z.hour] || 0) + 1; });
    const topHours = Object.entries(idealHours).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  TOP 시간대: ${topHours.map(([h, c]) => `${h}시(${c}건)`).join(', ')}`);

    // 이상적 구간 종목 TOP 10
    const idealCoins = {};
    ideal.forEach(z => { idealCoins[z.market] = (idealCoins[z.market] || 0) + 1; });
    const topCoins = Object.entries(idealCoins).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  TOP 종목: ${topCoins.map(([m, c]) => `${m.replace('KRW-', '')}(${c}건)`).join(', ')}`);
  }

  // ── 14. 비수익 구간과 비교 (대조군) ──
  // 이건 별도로 수집해야 하므로 여기서는 요약만
  console.log('\n── 14. 엔진 설계를 위한 핵심 인사이트 ──');
  console.log('  (위 데이터 기반으로 자동 도출)');

  // 가장 유의미한 피처 자동 판별
  const features = [
    { name: 'RSI(14)', values: allZones.map(z => z.rsi14), unit: '' },
    { name: '거래량비율', values: allZones.map(z => z.volumeRatio), unit: 'x' },
    { name: '직전5분추세', values: allZones.map(z => z.prevTrend5m), unit: '%' },
    { name: '변동성', values: allZones.map(z => z.avgPrevRange), unit: '%' },
    { name: '연속음봉', values: allZones.map(z => z.consecutiveBear), unit: '개' },
    { name: '드로우다운', values: allZones.map(z => z.maxDrawdown), unit: '%' },
  ];

  for (const f of features) {
    const q25 = percentile(f.values, 25);
    const q50 = percentile(f.values, 50);
    const q75 = percentile(f.values, 75);
    console.log(`  ${f.name.padEnd(12)}: Q25=${q25.toFixed(2)}${f.unit} | 중앙=${q50.toFixed(2)}${f.unit} | Q75=${q75.toFixed(2)}${f.unit}`);
  }

  return { allZones, ideal };
}

// ── 유틸 함수 ──────────────────────────────────
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── 메인 실행 ──────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  업비트 전 종목 수익 구간 분석 시작');
  console.log('  설정: 5분 윈도우, 0.5~1.5% 수익, 7일치 1분봉');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. 전 종목 목록 가져오기
  console.log('\n[1/3] 종목 목록 조회 중...');
  const markets = await httpGet('https://api.upbit.com/v1/market/all?isDetails=true');
  const krwMarkets = markets.filter(m => m.market.startsWith('KRW-'));
  console.log(`  KRW 마켓: ${krwMarkets.length}개`);

  // 2. 24시간 거래대금 필터링
  console.log('\n[2/3] 거래대금 필터링 (최소 5억원)...');
  await sleep(200);
  const tickers = await httpGet(`https://api.upbit.com/v1/ticker?markets=${krwMarkets.map(m => m.market).join(',')}`);

  const activeMarkets = tickers
    .filter(t => t.acc_trade_price_24h >= MIN_VOLUME_KRW)
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);

  console.log(`  거래대금 5억 이상: ${activeMarkets.length}개`);
  console.log(`  TOP 10 거래대금:`);
  for (const t of activeMarkets.slice(0, 10)) {
    console.log(`    ${t.market.padEnd(12)} ${(t.acc_trade_price_24h / 1e8).toFixed(0).padStart(8)}억원`);
  }

  // 3. 전 종목 1분봉 수집 & 수익 구간 탐색
  console.log(`\n[3/3] 전 종목 1분봉 수집 & 수익 구간 탐색...`);
  console.log(`  대상: ${activeMarkets.length}개 종목 × 7일치 1분봉`);
  console.log(`  예상 소요: ~${Math.ceil(activeMarkets.length * 51 * API_DELAY / 60000)}분\n`);

  const allZones = [];
  let processed = 0;

  for (const ticker of activeMarkets) {
    const market = ticker.market;
    processed++;

    try {
      const candles = await getAllCandles1m(market, CANDLE_DAYS);

      if (candles.length < 100) {
        console.log(`  [${processed}/${activeMarkets.length}] ${market} - 데이터 부족 (${candles.length}봉), 스킵`);
        continue;
      }

      const zones = findProfitZones(candles, market);
      allZones.push(...zones);

      const zoneRate = candles.length > 0 ? (zones.length / candles.length * 100).toFixed(1) : '0';
      console.log(`  [${processed}/${activeMarkets.length}] ${market.padEnd(12)} ${String(candles.length).padStart(6)}봉 → ${String(zones.length).padStart(4)}구간 (${zoneRate}%) ${zones.length > 50 ? '★' : ''}`);

    } catch (err) {
      console.log(`  [${processed}/${activeMarkets.length}] ${market} ERROR: ${err.message}`);
    }
  }

  console.log(`\n총 수집: ${allZones.length}개 수익 구간`);

  // 4. 패턴 분석
  const result = analyzePatterns(allZones);

  // 5. 결과 저장
  const outputPath = '/Users/kakao/Desktop/project/24번트/data/profit-zone-analysis.json';
  const fs = require('fs');
  fs.writeFileSync(outputPath, JSON.stringify({
    meta: {
      analyzedAt: new Date().toISOString(),
      settings: { TARGET_PROFIT_MIN, TARGET_PROFIT_MAX, WINDOW_MINUTES, CANDLE_DAYS, MIN_VOLUME_KRW },
      totalCoins: activeMarkets.length,
      totalZones: allZones.length,
    },
    zones: allZones,
  }, null, 2));
  console.log(`\n결과 저장: ${outputPath}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  분석 완료');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(console.error);
