/**
 * 오더블록(OB) 스캘핑 백테스트 엔진
 *
 * 오더블록: 큰 상승 직전의 마지막 음봉 → 기관 매집 흔적
 * 전략: OB존 리테스트 시 매수, OB 무너지면 손절, 직전고점 익절
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005; // 업비트 수수료 0.05% (편도)

// ── OB 감지 파라미터 ──────────────────────────────
const CONFIG = {
  // OB 형성 조건
  impulseMinPct: 1.5,     // OB 뒤 최소 상승폭 (%)
  impulseLookback: 6,     // 상승 확인 캔들 수 (5분 × 6 = 30분)
  volumeMultiplier: 1.5,  // OB 캔들 거래량 ≥ 평균의 N배
  volumeAvgWindow: 20,    // 거래량 평균 계산 윈도우

  // 진입 조건
  obMaxAge: 48,           // OB 유효기간 (캔들 수, 48 × 5분 = 4시간)
  entryZone: 'body',      // 'body' = 시가~종가 범위, 'wick' = 저가~고가 범위

  // 익절/손절
  tpMode: 'swing',        // 'swing' = 직전 스윙 고점, 'fixed' = 고정 %
  tpFixedPct: 1.5,        // 고정 익절 %
  slPct: 0.3,             // OB 하단 아래 추가 % (총 손절 = OB 높이 + slPct)

  // 필터
  useTrendFilter: true,   // 상위 타임프레임 추세 필터
  trendMaPeriod: 50,      // MA 기간 (5분봉 50개 = ~4시간)
  useRsiFilter: false,    // RSI 필터
  rsiPeriod: 14,
  rsiMaxEntry: 55,        // RSI 이하일 때만 진입

  // 리스크
  maxHoldCandles: 60,     // 최대 보유 (60 × 5분 = 5시간)
  cooldownCandles: 6,     // 매매 후 쿨다운 (30분)
};

// ── 보조 지표 ─────────────────────────────────────
function calcMA(data, period, field = 'close') {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j][field];
    result.push(sum / period);
  }
  return result;
}

function calcRSI(data, period = 14) {
  const result = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function calcAvgVolume(data, window) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < window) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - window; j < i; j++) sum += data[j].volume;
    result.push(sum / window);
  }
  return result;
}

// ── OB 감지 ───────────────────────────────────────
function detectOrderBlocks(data, avgVol) {
  const obs = []; // { index, high, low, open, close, top, bottom, swingHigh }

  for (let i = CONFIG.volumeAvgWindow; i < data.length - CONFIG.impulseLookback; i++) {
    const candle = data[i];

    // 1) 음봉인가?
    if (candle.close >= candle.open) continue;

    // 2) 거래량 조건
    if (avgVol[i] && candle.volume < avgVol[i] * CONFIG.volumeMultiplier) continue;

    // 3) 이후 impulse 상승 확인
    let maxHighAfter = 0;
    for (let j = i + 1; j <= i + CONFIG.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHighAfter) maxHighAfter = data[j].high;
    }
    const impulsePct = (maxHighAfter - candle.close) / candle.close * 100;
    if (impulsePct < CONFIG.impulseMinPct) continue;

    // OB존 정의 (body 기준)
    const top = candle.open;    // 음봉의 시가 = 상단
    const bottom = candle.close; // 음봉의 종가 = 하단

    // 직전 스윙 고점 찾기 (익절 타겟)
    const swingHigh = maxHighAfter;

    obs.push({
      index: i,
      time: candle.time,
      high: candle.high,
      low: candle.low,
      open: candle.open,
      close: candle.close,
      top,
      bottom,
      swingHigh,
      impulsePct: +impulsePct.toFixed(2),
      volume: candle.volume,
    });
  }

  return obs;
}

// ── 백테스트 실행 ─────────────────────────────────
function backtest(data, coin) {
  const ma = calcMA(data, CONFIG.trendMaPeriod);
  const rsi = calcRSI(data, CONFIG.rsiPeriod);
  const avgVol = calcAvgVolume(data, CONFIG.volumeAvgWindow);

  const obs = detectOrderBlocks(data, avgVol);
  const trades = [];
  let cooldownUntil = 0;

  for (let i = CONFIG.volumeAvgWindow + CONFIG.impulseLookback; i < data.length; i++) {
    if (i < cooldownUntil) continue;

    const candle = data[i];

    // 활성 OB 중 리테스트 되는 것 찾기
    for (const ob of obs) {
      // OB는 현재 캔들 이전에 형성되어야 함
      if (ob.index >= i) continue;
      // OB 유효기간 체크
      if (i - ob.index > CONFIG.obMaxAge) continue;
      // OB가 이미 사용됐으면 스킵 (한 번만 사용)
      if (ob.used) continue;

      // 가격이 OB존에 진입했는가?
      const touchedOB = candle.low <= ob.top && candle.close >= ob.bottom;
      if (!touchedOB) continue;

      // 추세 필터
      if (CONFIG.useTrendFilter && ma[i] !== null && candle.close < ma[i]) continue;

      // RSI 필터
      if (CONFIG.useRsiFilter && rsi[i] !== null && rsi[i] > CONFIG.rsiMaxEntry) continue;

      // 진입!
      const entryPrice = Math.max(candle.close, ob.bottom); // OB존 내 진입
      const slPrice = ob.bottom * (1 - CONFIG.slPct / 100);
      const tpPrice = CONFIG.tpMode === 'swing' ? ob.swingHigh : entryPrice * (1 + CONFIG.tpFixedPct / 100);

      // 시뮬레이션: 이후 캔들에서 TP/SL 확인
      let exitPrice = null;
      let exitReason = null;
      let exitIndex = null;

      for (let j = i + 1; j < Math.min(i + CONFIG.maxHoldCandles, data.length); j++) {
        // 손절 먼저 확인 (같은 캔들에서 SL, TP 동시 시 손절 우선)
        if (data[j].low <= slPrice) {
          exitPrice = slPrice;
          exitReason = 'SL';
          exitIndex = j;
          break;
        }
        // 익절
        if (data[j].high >= tpPrice) {
          exitPrice = tpPrice;
          exitReason = 'TP';
          exitIndex = j;
          break;
        }
      }

      // 시간 초과 → 현재가로 청산
      if (!exitPrice) {
        const lastIdx = Math.min(i + CONFIG.maxHoldCandles, data.length - 1);
        exitPrice = data[lastIdx].close;
        exitReason = 'TIMEOUT';
        exitIndex = lastIdx;
      }

      const grossPct = (exitPrice - entryPrice) / entryPrice * 100;
      const netPct = grossPct - (COMMISSION * 2 * 100); // 왕복 수수료
      const holdMinutes = (exitIndex - i) * 5;

      trades.push({
        coin,
        obTime: ob.time,
        entryTime: candle.time,
        exitTime: data[exitIndex].time,
        entryPrice: +entryPrice.toFixed(2),
        exitPrice: +exitPrice.toFixed(2),
        tpPrice: +tpPrice.toFixed(2),
        slPrice: +slPrice.toFixed(2),
        grossPct: +grossPct.toFixed(3),
        netPct: +netPct.toFixed(3),
        reason: exitReason,
        holdMinutes,
        obImpulse: ob.impulsePct,
      });

      ob.used = true;
      cooldownUntil = exitIndex + CONFIG.cooldownCandles;
      break; // 한 캔들에서 하나만 진입
    }
  }

  return trades;
}

// ── 결과 분석 ─────────────────────────────────────
function analyzeResults(allTrades) {
  if (allTrades.length === 0) {
    console.log('거래 없음');
    return;
  }

  const wins = allTrades.filter(t => t.netPct > 0);
  const losses = allTrades.filter(t => t.netPct <= 0);
  const tpTrades = allTrades.filter(t => t.reason === 'TP');
  const slTrades = allTrades.filter(t => t.reason === 'SL');
  const toTrades = allTrades.filter(t => t.reason === 'TIMEOUT');

  const totalPct = allTrades.reduce((s, t) => s + t.netPct, 0);
  const avgPct = totalPct / allTrades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgHold = allTrades.reduce((s, t) => s + t.holdMinutes, 0) / allTrades.length;

  // 일별 수익률
  const dailyPnl = {};
  allTrades.forEach(t => {
    const date = t.entryTime.slice(0, 10);
    if (!dailyPnl[date]) dailyPnl[date] = 0;
    dailyPnl[date] += t.netPct;
  });
  const days = Object.keys(dailyPnl).sort();
  const dailyAvg = days.length > 0 ? Object.values(dailyPnl).reduce((s, v) => s + v, 0) / days.length : 0;
  const profitDays = days.filter(d => dailyPnl[d] > 0).length;

  // MDD 계산
  let cumPct = 0, peak = 0, mdd = 0;
  allTrades.forEach(t => {
    cumPct += t.netPct;
    if (cumPct > peak) peak = cumPct;
    const dd = peak - cumPct;
    if (dd > mdd) mdd = dd;
  });

  // 10만원 기준 시뮬레이션
  let balance = 100000;
  allTrades.forEach(t => {
    balance *= (1 + t.netPct / 100);
  });

  console.log('\n════════════════════════════════════════════════');
  console.log('  오더블록 스캘핑 백테스트 결과');
  console.log('════════════════════════════════════════════════');
  console.log(`  기간: ${allTrades[0].entryTime.slice(0, 10)} ~ ${allTrades[allTrades.length - 1].entryTime.slice(0, 10)}`);
  console.log(`  대상: 거래량 상위 20개 알트코인`);
  console.log(`  타임프레임: 5분봉`);
  console.log('────────────────────────────────────────────────');
  console.log(`  총 거래: ${allTrades.length}회`);
  console.log(`  승률: ${(wins.length / allTrades.length * 100).toFixed(1)}% (${wins.length}승 ${losses.length}패)`);
  console.log(`  TP/SL/TIMEOUT: ${tpTrades.length} / ${slTrades.length} / ${toTrades.length}`);
  console.log('────────────────────────────────────────────────');
  console.log(`  총 수익률: ${totalPct > 0 ? '+' : ''}${totalPct.toFixed(2)}% (수수료 차감)`);
  console.log(`  평균 수익률/건: ${avgPct > 0 ? '+' : ''}${avgPct.toFixed(3)}%`);
  console.log(`  평균 수익(승): +${avgWin.toFixed(3)}%`);
  console.log(`  평균 손실(패): ${avgLoss.toFixed(3)}%`);
  console.log(`  손익비: 1:${Math.abs(avgWin / avgLoss).toFixed(2)}`);
  console.log(`  평균 보유시간: ${avgHold.toFixed(0)}분`);
  console.log('────────────────────────────────────────────────');
  console.log(`  일평균 수익률: ${dailyAvg > 0 ? '+' : ''}${dailyAvg.toFixed(2)}%`);
  console.log(`  수익일/총일: ${profitDays}/${days.length}일 (${(profitDays / days.length * 100).toFixed(0)}%)`);
  console.log(`  MDD: -${mdd.toFixed(2)}%`);
  console.log('────────────────────────────────────────────────');
  console.log(`  💰 10만원 → ${Math.round(balance).toLocaleString()}원 (${((balance / 100000 - 1) * 100).toFixed(1)}%)`);
  console.log('════════════════════════════════════════════════');

  // 코인별 성과
  const byCoin = {};
  allTrades.forEach(t => {
    if (!byCoin[t.coin]) byCoin[t.coin] = { trades: 0, pnl: 0, wins: 0 };
    byCoin[t.coin].trades++;
    byCoin[t.coin].pnl += t.netPct;
    if (t.netPct > 0) byCoin[t.coin].wins++;
  });

  console.log('\n  코인별 성과:');
  console.log('  ─────────────────────────────────────────');
  Object.entries(byCoin)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .forEach(([coin, s]) => {
      const wr = (s.wins / s.trades * 100).toFixed(0);
      console.log(`  ${coin.padEnd(8)} ${s.trades}건  승률 ${wr}%  수익 ${s.pnl > 0 ? '+' : ''}${s.pnl.toFixed(2)}%`);
    });

  // 일별 수익률 출력
  console.log('\n  일별 수익률:');
  console.log('  ─────────────────────────────────────────');
  days.forEach(d => {
    const pnl = dailyPnl[d];
    const bar = pnl > 0 ? '█'.repeat(Math.min(Math.round(pnl), 30)) : '░'.repeat(Math.min(Math.round(-pnl), 30));
    console.log(`  ${d}  ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%  ${pnl > 0 ? '🟢' : '🔴'} ${bar}`);
  });

  return { totalPct, avgPct, winRate: wins.length / allTrades.length, mdd, dailyAvg, balance };
}

// ── 메인 ──────────────────────────────────────────
function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('데이터 없음. 먼저 upbit-fetch.js를 실행하세요.');
    return;
  }

  console.log(`\n${files.length}개 코인 데이터 로드...`);
  console.log(`설정: impulse≥${CONFIG.impulseMinPct}%, vol≥${CONFIG.volumeMultiplier}x, TP=${CONFIG.tpMode}, SL=OB-${CONFIG.slPct}%`);

  let allTrades = [];

  for (const file of files) {
    const coin = file.replace('.json', '');
    if (coin === 'BTC') continue; // BTC는 추세 판단용

    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    if (data.length < 100) { console.log(`  ${coin}: 데이터 부족 (${data.length}개), 스킵`); continue; }

    const trades = backtest(data, coin);
    if (trades.length > 0) {
      console.log(`  ${coin}: ${trades.length}건 (승률 ${(trades.filter(t => t.netPct > 0).length / trades.length * 100).toFixed(0)}%)`);
    }
    allTrades.push(...trades);
  }

  // 시간순 정렬
  allTrades.sort((a, b) => a.entryTime.localeCompare(b.entryTime));

  analyzeResults(allTrades);

  // 결과 저장
  const resultPath = path.join(__dirname, '..', 'data', 'backtest-result.json');
  fs.writeFileSync(resultPath, JSON.stringify({ config: CONFIG, trades: allTrades }, null, 2));
  console.log(`\n상세 결과 저장: ${resultPath}`);
}

main();
