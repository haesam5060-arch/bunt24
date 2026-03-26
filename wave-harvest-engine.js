/**
 * WaveHarvest 엔진 — 잔파도 수확 초단타
 *
 * 194,773건 수익 구간 분석 결과 기반 설계:
 *   - 5분 내 0.5~1% 미세 등락을 수확
 *   - 양봉 시작 + 직전 하락 반등 = DD 거의 없는 진입
 *   - 저변동성 구간에서 안전한 수익
 *
 * 독립 실행: server.js에서 require 후 start() 호출
 * 공유: upbit-api.js, email-service.js
 */

const fs = require('fs');
const path = require('path');
const upbit = require('./upbit-api');
const emailService = require('./email-service');

// ── 상수 ────────────────────────────────────────
const STATE_PATH = path.join(__dirname, 'data', 'wh-state.json');
const LOG_PATH = path.join(__dirname, 'data', 'wh-trade-log.json');
const CANDLE_FETCH_INTERVAL = 60 * 1000;   // 1분마다 캔들 조회
const POSITION_CHECK_INTERVAL = 3 * 1000;  // 3초마다 포지션 체크
const SCAN_INTERVAL = 30 * 60 * 1000;      // 30분마다 종목 재스캔
const FEE_RATE = 0.0005;                    // 업비트 수수료 0.05%

// ── 상태 ────────────────────────────────────────
let config = null;      // waveHarvest config (from config.json)
let apiKeys = null;     // { accessKey, secretKey }
let state = null;       // 영속 상태
let running = false;    // 엔진 가동 여부

// 실시간 데이터 (메모리만)
let candleCache = {};       // { 'KRW-BTC': [ {open,high,low,close,volume,time}, ... ] }
let latestPrices = {};      // { 'KRW-BTC': 71500 }
let pendingOrders = {};     // { coin: { orderId, market, volume, price, time } }
let cooldowns = {};         // { coin: timestamp } 쿨다운
let exitingCoins = new Set(); // 청산 진행 중인 코인 (race condition 방지)
let logBuffer = [];         // 로그 버퍼 (대시보드 전송용)

// 타이머 핸들
let candleTimer = null;
let positionTimer = null;
let scanTimer = null;
let stateTimer = null;
let pendingCheckTimer = null;

// ── 로깅 ────────────────────────────────────────
let externalLogFn = null;

function log(msg, level = 'info') {
  const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const prefix = `[WH][${ts}]`;
  const line = `${prefix} ${msg}`;

  if (level === 'error') console.error(line);
  else console.log(line);

  logBuffer.push({ time: new Date().toISOString(), msg: `[WH] ${msg}`, level });
  if (logBuffer.length > 200) logBuffer.shift();

  if (externalLogFn) externalLogFn(`[WH] ${msg}`, level);
}

// ── State 관리 ──────────────────────────────────
function createDefaultState() {
  return {
    positions: [],
    totalPnl: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    dailyPnl: [],
    watchlist: [],
    consecutiveLosses: 0,
    cooldownUntil: 0,
    todayPnl: 0,
    todayDate: '',
    enabled: false,
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // 기본값 병합 (새 필드 추가 대비)
    return { ...createDefaultState(), ...parsed };
  } catch {
    return createDefaultState();
  }
}

function saveState() {
  if (!state) return;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`state 저장 실패: ${e.message}`, 'error');
  }
}

// ── Trade Log ───────────────────────────────────
function appendTradeLog(trade) {
  try {
    let logs = [];
    try { logs = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8')); } catch {}
    logs.unshift(trade);
    if (logs.length > 500) logs = logs.slice(0, 500);
    fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2));
  } catch (e) {
    log(`trade-log 저장 실패: ${e.message}`, 'error');
  }
}

// ── 일일 PnL 리셋 ──────────────────────────────
function checkDailyReset() {
  const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  if (state.todayDate !== today) {
    if (state.todayDate && state.todayPnl !== 0) {
      state.dailyPnl.push({ date: state.todayDate, pnl: state.todayPnl });
      if (state.dailyPnl.length > 90) state.dailyPnl.shift();
    }
    state.todayPnl = 0;
    state.todayDate = today;
    state.consecutiveLosses = 0;
    state.cooldownUntil = 0;
    cooldowns = {};  // 코인별 쿨다운도 초기화
    log(`일일 리셋: ${today}`);
  }
}

// ── 종목 스캔 ───────────────────────────────────
async function scanWatchlist() {
  if (!apiKeys) return;
  try {
    const topMarkets = await upbit.getTopMarkets(60);
    const minVolume = config.minVolume24h || 500000000;
    const minPrice = config.minCoinPrice || 100;
    const excludeCoins = new Set((config.excludeCoins || []).map(c => c.toUpperCase()));

    const candidates = topMarkets.filter(m => {
      const coin = m.coin.toUpperCase();
      if (excludeCoins.has(coin)) return false;
      if (m.price < minPrice) return false;
      if (m.volume24h < minVolume) return false;
      if (coin === 'USDT' || coin === 'USDC') return false; // 스테이블코인 제외
      return true;
    });

    // 보유 포지션 코인이 watchlist에 없으면 추가
    const watchMarkets = new Set(candidates.map(c => c.market));
    for (const pos of state.positions) {
      if (!watchMarkets.has(pos.market)) {
        candidates.push({ market: pos.market, coin: pos.coin, price: pos.entryPrice, volume24h: 0 });
      }
    }

    state.watchlist = candidates.slice(0, config.maxWatchlist || 30).map(c => ({
      market: c.market,
      coin: c.coin,
      price: c.price,
      volume24h: c.volume24h,
    }));

    log(`종목 스캔 완료: ${state.watchlist.length}개 (거래대금 ${minVolume / 1e8}억 이상)`);
    return state.watchlist.map(w => w.market);
  } catch (e) {
    log(`종목 스캔 실패: ${e.message}`, 'error');
    return state.watchlist.map(w => w.market);
  }
}

// ── 1분봉 수집 ──────────────────────────────────
async function fetchCandles() {
  if (!state.watchlist || state.watchlist.length === 0) return;

  for (const item of state.watchlist) {
    try {
      const raw = await upbit.getCandles(item.market, 1, 20);
      if (!Array.isArray(raw) || raw.length === 0) continue;

      // 시간순 정렬 (오래된 것 먼저)
      raw.sort((a, b) => new Date(a.candle_date_time_utc) - new Date(b.candle_date_time_utc));

      candleCache[item.market] = raw.map(c => ({
        open: c.opening_price,
        high: c.high_price,
        low: c.low_price,
        close: c.trade_price,
        volume: c.candle_acc_trade_volume,
        volumeKrw: c.candle_acc_trade_price,
        time: c.candle_date_time_utc,
      }));

      // 최신 가격 업데이트
      const latest = raw[raw.length - 1];
      latestPrices[item.market] = latest.trade_price;

      // API rate limit 존중
      await sleep(80);
    } catch (e) {
      // 개별 종목 실패는 로그 남기고 계속
      if (e.message && !e.message.includes('Parse error')) {
        log(`${item.market} 캔들 조회 실패: ${e.message}`, 'warn');
      }
    }
  }
}

// ── 진입 신호 분석 ──────────────────────────────
function analyzeEntry(market) {
  const candles = candleCache[market];
  if (!candles || candles.length < 10) return null;

  const coin = market.replace('KRW-', '');
  const currentPrice = latestPrices[market];
  if (!currentPrice || currentPrice <= 0) return null;

  const len = candles.length;
  const curr = candles[len - 1];  // 최신 1분봉 (진행 중)
  const prev1 = candles[len - 2]; // 직전 완성 봉
  if (!curr || !prev1) return null;

  // ── 조건 1: 현재 봉이 양봉 (현재가 > 시가) ──
  if (currentPrice <= curr.open) return null;

  // 현재 봉 양봉 강도 (시가 대비 얼마나 올랐나)
  const currentGain = (currentPrice - curr.open) / curr.open * 100;

  // ── 조건 2: 직전 3~5분간 하락 후 반등 ──
  // 직전 3봉 중 최저 close 찾기
  const lookback = Math.min(5, len - 1);
  const prevCandles = candles.slice(len - 1 - lookback, len - 1);
  const prevCloses = prevCandles.map(c => c.close);
  const prevLow = Math.min(...prevCloses);
  const prevHigh = Math.max(...prevCandles.map(c => c.high));

  // 직전 구간 하락폭
  const entryFromPrevHigh = prevCandles.length > 0
    ? (curr.open - prevHigh) / prevHigh * 100
    : 0;

  // 최소 하락폭 체크 (직전 고점 대비 현재 시가가 하락해 있어야 함)
  const minDipPct = config.minDipPct || 0.3;
  if (entryFromPrevHigh > -minDipPct) return null;

  // ── 조건 3: 저변동성 구간 ──
  // 직전 5봉의 평균 range (high-low)/low
  const prevRanges = prevCandles.map(c => c.low > 0 ? (c.high - c.low) / c.low * 100 : 0);
  const avgRange = prevRanges.reduce((a, b) => a + b, 0) / (prevRanges.length || 1);
  const maxAvgRange = config.maxAvgRange || 0.5;
  if (avgRange > maxAvgRange) return null;

  // ── 조건 4: 가격 유효성 ──
  if (currentPrice < (config.minCoinPrice || 100)) return null;

  // ── 보조 지표: RSI(14) 간이 계산 ──
  const rsi = calcRSI(candles, 14);

  // ── 보조 지표: 거래량 변화 ──
  const avgVolume = prevCandles.reduce((s, c) => s + (c.volumeKrw || 0), 0) / (prevCandles.length || 1);
  const currVolume = curr.volumeKrw || 0;
  const volumeRatio = avgVolume > 0 ? currVolume / avgVolume : 1;

  // ── 신호 점수 계산 ──
  let score = 0;

  // 양봉 강도 (0.1~0.3% 정도면 좋은 시작)
  if (currentGain >= 0.05 && currentGain <= 0.5) score += 30;
  else if (currentGain > 0.5) score += 10; // 너무 올라간 건 감점

  // 직전 하락폭 (깊을수록 반등 여력 높음)
  if (entryFromPrevHigh <= -0.5) score += 25;
  else if (entryFromPrevHigh <= -0.3) score += 15;

  // 저변동성 보너스
  if (avgRange < 0.2) score += 20;
  else if (avgRange < 0.3) score += 10;

  // RSI 보너스 (과매도 쪽이면 추가 점수)
  if (rsi !== null) {
    if (rsi < 35) score += 15;
    else if (rsi < 45) score += 10;
    else if (rsi > 70) score -= 5; // 과매수 주의
  }

  // 거래량 확인 (거래량 급증이면 추가 점수)
  if (volumeRatio > 2) score += 10;

  // 최소 점수 체크
  const minScore = config.minScore || 50;
  if (score < minScore) return null;

  return {
    market,
    coin,
    price: currentPrice,
    score,
    dip: entryFromPrevHigh,
    avgRange,
    rsi,
    volumeRatio,
    currentGain,
  };
}

// ── RSI 계산 ────────────────────────────────────
function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  const closes = candles.slice(-period - 1).map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ── 진입 실행 ───────────────────────────────────
async function executeEntry(signal) {
  const { market, coin, price, score } = signal;

  // 중복 진입 방지
  if (state.positions.some(p => p.coin === coin)) {
    return;
  }
  if (pendingOrders[coin]) {
    return;
  }

  // 쿨다운 체크
  if (cooldowns[coin] && Date.now() < cooldowns[coin]) {
    return;
  }

  // 글로벌 쿨다운 (연속 손절 후)
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    return;
  }

  // 최대 포지션 수 체크
  const maxPos = config.maxPositions || 5;
  if (state.positions.length + Object.keys(pendingOrders).length >= maxPos) {
    return;
  }

  // 일일 손실 한도 체크: 총 운용금(5종목×5000원=25000원)의 1.5% = 375원
  const maxDailyLossPct = config.maxDailyLossPct || 1.5;
  const totalCapital = (config.maxPositions || 5) * (config.amountPerTrade || 5000);
  const dailyLossLimit = Math.round(totalCapital * maxDailyLossPct / 100);
  if (state.todayPnl < 0 && Math.abs(state.todayPnl) >= dailyLossLimit) {
    log(`일일 손실 한도 도달 (${state.todayPnl}원 / 한도 -${dailyLossLimit}원)`, 'warn');
    return;
  }

  // 잔고 체크
  try {
    const balance = await upbit.getBalance(apiKeys.accessKey, apiKeys.secretKey);
    const orderAmount = config.amountPerTrade || 5000;
    if (balance < orderAmount) {
      log(`잔고 부족: ${balance}원 < ${orderAmount}원`, 'warn');
      return;
    }

    // TP/SL 가격 계산
    const tpPct = config.tpPct || 0.5;
    const slPct = config.slPct || 0.5;
    const tpPrice = upbit.roundToTick(price * (1 + tpPct / 100), 'down');
    const slPrice = upbit.roundToTick(price * (1 - slPct / 100), 'down');

    // 시장가 매수 (초단타이므로 시장가로 즉시 체결)
    log(`매수 시도: ${coin} @ ${price.toLocaleString()}원 (점수: ${score}, 하락폭: ${signal.dip.toFixed(2)}%)`);

    const orderResult = await upbit.buyMarket(apiKeys.accessKey, apiKeys.secretKey, market, orderAmount);

    if (!orderResult || !orderResult.uuid) {
      log(`${coin} 매수 주문 실패: 응답 없음`, 'error');
      return;
    }

    // 대기 주문 등록 (체결 확인용)
    pendingOrders[coin] = {
      orderId: orderResult.uuid,
      market,
      coin,
      amount: orderAmount,
      tpPct,
      slPct,
      tpPrice,
      slPrice,
      score,
      signal,
      time: Date.now(),
    };

    log(`매수 주문 접수: ${coin} | 주문ID: ${orderResult.uuid.slice(0, 8)}...`);

  } catch (e) {
    log(`${coin} 매수 실행 실패: ${e.message}`, 'error');
  }
}

// ── 대기 주문 체결 확인 ─────────────────────────
async function checkPendingOrders() {
  const coins = Object.keys(pendingOrders);
  if (coins.length === 0) return;

  for (const coin of coins) {
    const order = pendingOrders[coin];
    try {
      const info = await upbit.getOrder(apiKeys.accessKey, apiKeys.secretKey, order.orderId);

      if (info.state === 'done' || info.state === 'cancel') {
        // 업비트 시장가 매수(ord_type='price')는 체결 후 잔여금 반환 시 state='cancel'
        // → executed_volume > 0 이면 실제 체결된 것이므로 포지션 등록 필요
        const executedVolume = parseFloat(info.executed_volume) || 0;
        if (executedVolume > 0) {
          // 업비트: /v1/order 단건 조회 시 시장가(ord_type='price')는 executed_funds가 undefined
          // → trades 배열에서 funds 합산으로 fallback
          let executedFunds = parseFloat(info.executed_funds || 0);
          if (!executedFunds && info.trades && info.trades.length > 0) {
            executedFunds = info.trades.reduce((sum, t) => sum + parseFloat(t.funds || 0), 0);
          }
          const paidFee = parseFloat(info.paid_fee || 0);
          // 실제 진입가 = 체결금액 / 체결수량 (수수료 제외 순단가)
          const entryPrice = executedFunds / executedVolume;
          // 총 투입금 = 체결금액 + 수수료
          const totalCost = executedFunds + paidFee;

          // TP/SL 재계산 (실제 체결가 기준)
          let tpPrice = upbit.roundToTick(entryPrice * (1 + order.tpPct / 100), 'down');
          let slPrice = upbit.roundToTick(entryPrice * (1 - order.slPct / 100), 'down');
          // TP와 SL이 같으면 TP를 1틱 올림
          if (tpPrice <= slPrice) {
            tpPrice = upbit.roundToTick(entryPrice * (1 + order.tpPct / 100), 'up');
          }

          const position = {
            coin,
            market: order.market,
            entryPrice,
            tpPrice,
            slPrice,
            amount: Math.round(totalCost),
            totalCost,       // 정확한 매수 총비용 (체결금 + 수수료)
            buyFee: paidFee, // 매수 수수료
            volume: executedVolume,
            orderId: order.orderId,
            entryTime: new Date().toISOString(),
            score: order.score,
            highSinceEntry: entryPrice,
            signal: {
              dip: order.signal.dip,
              avgRange: order.signal.avgRange,
              rsi: order.signal.rsi,
            },
          };

          state.positions.push(position);
          saveState();

          log(`매수 체결: ${coin} @ ${entryPrice.toLocaleString()}원 | TP: ${tpPrice.toLocaleString()} SL: ${slPrice.toLocaleString()} | 수량: ${executedVolume}`);

          // 매수 로그
          appendTradeLog({
            engine: 'WH',
            action: 'BUY',
            coin,
            market: order.market,
            price: entryPrice,
            amount: Math.round(totalCost),
            volume: executedVolume,
            tpPrice,
            slPrice,
            score: order.score,
            timestamp: new Date().toISOString(),
          });

          // 이메일 알림
          emailService.sendBuyAlert({
            coin,
            entryPrice,
            amount: Math.round(totalCost),
            tpPrice,
            slPrice,
            obImpulse: `WH score:${order.score}`,
          }).catch(() => {});
        } else {
          // 진짜 미체결 취소 (executed_volume === 0)
          log(`${coin} 주문 미체결 취소 (체결량 0)`, 'warn');
        }

        delete pendingOrders[coin];
      } else if (Date.now() - order.time > 30 * 1000) {
        // 30초 미체결 → 취소 (시장가라서 거의 없겠지만 안전장치)
        log(`${coin} 주문 30초 미체결 → 취소 시도`, 'warn');
        try {
          await upbit.cancelOrder(apiKeys.accessKey, apiKeys.secretKey, order.orderId);
        } catch {}
        delete pendingOrders[coin];
      }
    } catch (e) {
      // 일시적 API 에러는 다음 주기에 재시도
      if (Date.now() - order.time > 60 * 1000) {
        log(`${coin} 주문 확인 1분 초과 → 정리`, 'error');
        delete pendingOrders[coin];
      }
    }
  }
}

// ── 포지션 청산 체크 ────────────────────────────
async function checkExits() {
  if (state.positions.length === 0) return;

  for (const pos of [...state.positions]) {
    const price = latestPrices[pos.market];
    if (!price || price <= 0) continue;

    // 최고가 갱신
    if (price > pos.highSinceEntry) {
      pos.highSinceEntry = price;
    }

    let exitReason = null;

    // ── TP: 익절 ──
    if (price >= pos.tpPrice) {
      exitReason = 'TP';
    }

    // ── SL: 손절 ──
    if (!exitReason && price <= pos.slPrice) {
      exitReason = 'SL';
    }

    // ── TIMEOUT: 5분 초과 ──
    if (!exitReason) {
      const holdMs = Date.now() - new Date(pos.entryTime).getTime();
      const timeoutMs = (config.timeoutMinutes || 5) * 60 * 1000;
      if (holdMs >= timeoutMs) {
        exitReason = 'TIMEOUT';
      }
    }

    // ── 트레일링 스탑 (TP 근접 시 수익 보호) ──
    if (!exitReason && pos.highSinceEntry > pos.entryPrice) {
      const gainFromEntry = (pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100;
      const trailActivate = (config.tpPct || 0.5) * 0.6; // TP의 60% 도달 시 트레일 활성화
      if (gainFromEntry >= trailActivate) {
        const trailPct = config.trailPct || 0.2;
        const trailStop = pos.highSinceEntry * (1 - trailPct / 100);
        if (price <= trailStop) {
          exitReason = 'TRAIL';
        }
      }
    }

    if (exitReason) {
      await executeExit(pos, exitReason, price);
    }
  }
}

// ── 청산 실행 ───────────────────────────────────
async function executeExit(pos, reason, currentPrice) {
  // 동일 코인 동시 청산 방지
  if (exitingCoins.has(pos.coin)) {
    return;
  }
  exitingCoins.add(pos.coin);

  try {
    // 실제 보유량 확인
    const holdings = await upbit.getHoldings(apiKeys.accessKey, apiKeys.secretKey);
    const holding = holdings.find(h => h.currency === pos.coin);
    const sellVolume = holding ? holding.balance : pos.volume;

    if (!sellVolume || sellVolume <= 0) {
      log(`${pos.coin} 보유량 없음 — 포지션 정리`, 'warn');
      removePosition(pos, reason, currentPrice, 0);
      return;
    }

    // 시장가 매도
    const sellResult = await upbit.sellMarket(apiKeys.accessKey, apiKeys.secretKey, pos.market, sellVolume);

    if (!sellResult || !sellResult.uuid) {
      log(`${pos.coin} 매도 주문 실패`, 'error');
      return;
    }

    // 체결 확인 대기 (최대 10초)
    let exitPrice = currentPrice;
    let actualSellAmount = 0;
    for (let i = 0; i < 5; i++) {
      await sleep(2000);
      try {
        const orderInfo = await upbit.getOrder(apiKeys.accessKey, apiKeys.secretKey, sellResult.uuid);
        if (orderInfo.state === 'done') {
          // 업비트 매도: executed_funds = 실제 입금액 (수수료 차감 후)
          const executedFunds = parseFloat(orderInfo.executed_funds || 0);
          const executedVol = parseFloat(orderInfo.executed_volume || sellVolume);
          const paidFee = parseFloat(orderInfo.paid_fee || 0);
          if (executedVol > 0) {
            // 순매도가 = (입금액 + 수수료) / 체결수량 (수수료 전 단가)
            exitPrice = (executedFunds + paidFee) / executedVol;
            actualSellAmount = executedFunds; // 실제 입금액
          }
          break;
        }
      } catch (e) {
        log(`${pos.coin} 매도 체결 조회 재시도 (${i + 1}/5): ${e.message}`, 'warn');
      }
    }

    if (!actualSellAmount) actualSellAmount = sellVolume * exitPrice * (1 - FEE_RATE);
    removePosition(pos, reason, exitPrice, actualSellAmount);

  } catch (e) {
    log(`${pos.coin} 매도 실행 실패: ${e.message}`, 'error');
  } finally {
    exitingCoins.delete(pos.coin);
  }
}

// ── 포지션 제거 + 기록 ──────────────────────────
function removePosition(pos, reason, exitPrice, sellAmount) {
  // 정확한 PnL: 실제 입금액 - 실제 총비용
  // sellAmount = 매도 후 실제 입금액 (수수료 차감됨), pos.totalCost = 매수 총비용 (수수료 포함)
  const buyCost = pos.totalCost || (pos.amount || pos.entryPrice * pos.volume * (1 + FEE_RATE));
  const sellReceived = sellAmount || (exitPrice * pos.volume * (1 - FEE_RATE));
  const pnl = Math.round(sellReceived - buyCost);
  const pnlPct = buyCost > 0 ? ((sellReceived - buyCost) / buyCost * 100) : 0;

  const holdMs = Date.now() - new Date(pos.entryTime).getTime();
  const holdSec = Math.round(holdMs / 1000);

  const reasonLabel = { TP: '익절', SL: '손절', TRAIL: '트레일', TIMEOUT: '타임아웃' }[reason] || reason;
  const icon = pnl > 0 ? '+' : '';
  log(`매도 [${reasonLabel}]: ${pos.coin} @ ${exitPrice.toLocaleString()}원 | ${icon}${pnl.toLocaleString()}원 (${icon}${pnlPct.toFixed(2)}%) | ${holdSec}초 보유`);

  // state 업데이트
  state.positions = state.positions.filter(p => p.orderId !== pos.orderId);
  state.totalTrades++;
  state.totalPnl += pnl;
  state.todayPnl += pnl;

  if (pnl > 0) {
    state.wins++;
    state.consecutiveLosses = 0;
  } else {
    state.losses++;
    state.consecutiveLosses++;

    // 연속 손절 쿨다운
    const maxConsecutive = config.maxConsecutiveLosses || 3;
    const cooldownMin = config.cooldownMinutes || 30;
    if (state.consecutiveLosses >= maxConsecutive) {
      state.cooldownUntil = Date.now() + cooldownMin * 60 * 1000;
      log(`연속 ${state.consecutiveLosses}패 → ${cooldownMin}분 쿨다운`, 'warn');
    }
  }

  // 코인별 재진입 쿨다운 (SL인 경우 10분, 아닌 경우 3분)
  const coinCooldownMs = reason === 'SL' ? 10 * 60 * 1000 : 3 * 60 * 1000;
  cooldowns[pos.coin] = Date.now() + coinCooldownMs;

  saveState();

  // trade log
  const trade = {
    engine: 'WH',
    action: 'SELL',
    coin: pos.coin,
    market: pos.market,
    reason,
    entryPrice: pos.entryPrice,
    exitPrice,
    amount: pos.amount,
    pnl,
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    holdSeconds: holdSec,
    score: pos.score,
    highSinceEntry: pos.highSinceEntry,
    maxUnrealizedPct: pos.highSinceEntry > 0
      ? parseFloat(((pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100).toFixed(2))
      : 0,
    timestamp: new Date().toISOString(),
  };

  appendTradeLog(trade);

  // 이메일 알림
  emailService.sendSellAlert({
    coin: pos.coin,
    reason,
    entryPrice: pos.entryPrice,
    exitPrice,
    amount: pos.amount,
    pnl,
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    holdMinutes: Math.round(holdSec / 60),
  }).catch(() => {});
}

// ── 메인 루프 ───────────────────────────────────
async function mainLoop() {
  if (!running || !state.enabled) return;

  checkDailyReset();

  // 1. 캔들 수집
  await fetchCandles();

  // 2. 각 종목에 대해 진입 신호 분석
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const remain = Math.round((state.cooldownUntil - Date.now()) / 60000);
    if (remain % 5 === 0) log(`쿨다운 중... ${remain}분 남음`);
    return;
  }

  for (const item of state.watchlist) {
    const signal = analyzeEntry(item.market);
    if (signal) {
      await executeEntry(signal);
      // 매수 후 바로 다음 종목으로 (rate limit 방지)
      await sleep(300);
    }
  }
}

// ── 가격 업데이트 (WebSocket에서 호출) ──────────
function onPriceUpdate(market, price) {
  if (!running) return;
  latestPrices[market] = price;
}

// ── 시작/중지 ───────────────────────────────────
async function start(cfg, keys, logFn) {
  if (running) {
    log('이미 실행 중');
    return;
  }

  config = cfg;
  apiKeys = keys;
  externalLogFn = logFn || null;
  state = loadState();
  running = true;

  log('WaveHarvest 엔진 시작');
  log(`설정: TP ${config.tpPct}% | SL ${config.slPct}% | 타임아웃 ${config.timeoutMinutes}분 | 최대 ${config.maxPositions}포지션 | 종목당 ${config.amountPerTrade}원`);

  // 초기 스캔
  const markets = await scanWatchlist();
  log(`감시 종목: ${markets.length}개`);

  // 즉시 첫 실행
  await mainLoop();

  // 정기 실행 타이머
  candleTimer = setInterval(mainLoop, CANDLE_FETCH_INTERVAL);
  positionTimer = setInterval(checkExits, POSITION_CHECK_INTERVAL);
  scanTimer = setInterval(scanWatchlist, SCAN_INTERVAL);
  stateTimer = setInterval(saveState, 30 * 1000);

  // 대기 주문 확인 (5초마다)
  pendingCheckTimer = setInterval(checkPendingOrders, 5 * 1000);

  return markets;
}

function stop() {
  running = false;
  if (candleTimer) clearInterval(candleTimer);
  if (positionTimer) clearInterval(positionTimer);
  if (scanTimer) clearInterval(scanTimer);
  if (stateTimer) clearInterval(stateTimer);
  if (pendingCheckTimer) clearInterval(pendingCheckTimer);
  candleTimer = positionTimer = scanTimer = stateTimer = pendingCheckTimer = null;

  saveState();
  log('WaveHarvest 엔진 중지');
}

// ── 상태/설정 변경 API ──────────────────────────
function enable() {
  state.enabled = true;
  saveState();
  log('WaveHarvest 활성화');
}

function disable() {
  state.enabled = false;
  saveState();
  log('WaveHarvest 비활성화');
}

function updateConfig(newCfg) {
  config = { ...config, ...newCfg };
  log(`설정 업데이트: ${JSON.stringify(newCfg)}`);
}

function getState() {
  if (!state) return { positions: [], running: false, enabled: false, totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, dailyPnl: [], watchlist: [], logs: [] };
  return {
    ...state,
    running,
    config,
    pendingOrders: Object.keys(pendingOrders).length,
    watchlistCount: state.watchlist ? state.watchlist.length : 0,
    candleCacheCount: Object.keys(candleCache).length,
    latestPrices,
    logs: logBuffer.slice(-30),
  };
}

function getLogs() {
  return logBuffer.slice(-100);
}

// ── 포지션 수동 등록 (기존 보유종목 편입) ────────
function addPosition(pos) {
  if (!state) return { error: 'engine not started' };
  if (state.positions.some(p => p.coin === pos.coin)) return { error: `${pos.coin} already exists` };
  const tpPct = config.tpPct || 0.5;
  const slPct = config.slPct || 0.5;
  const position = {
    coin: pos.coin,
    market: pos.market || `KRW-${pos.coin}`,
    entryPrice: pos.entryPrice,
    tpPrice: pos.tpPrice || upbit.roundToTick(pos.entryPrice * (1 + tpPct / 100), 'up'),
    slPrice: pos.slPrice || upbit.roundToTick(pos.entryPrice * (1 - slPct / 100), 'down'),
    amount: Math.round(pos.entryPrice * pos.volume),
    totalCost: pos.totalCost || pos.entryPrice * pos.volume * (1 + FEE_RATE),
    buyFee: pos.buyFee || pos.entryPrice * pos.volume * FEE_RATE,
    volume: pos.volume,
    orderId: pos.orderId || `manual-${Date.now()}`,
    entryTime: pos.entryTime || new Date().toISOString(),
    score: pos.score || 0,
    highSinceEntry: pos.entryPrice,
    signal: pos.signal || { dip: 0, avgRange: 0, rsi: 50 },
  };
  state.positions.push(position);
  saveState();
  log(`포지션 수동 등록: ${pos.coin} @ ${pos.entryPrice}원 × ${pos.volume}개`);
  return { ok: true, position };
}

// ── 유틸 ────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 모듈 export ─────────────────────────────────
module.exports = {
  start,
  stop,
  enable,
  disable,
  updateConfig,
  getState,
  getLogs,
  onPriceUpdate,
  addPosition,
};
