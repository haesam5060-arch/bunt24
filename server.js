/**
 * 24번트 v2 — 멀티 전략 스코어링 자동매매 봇
 *
 * 구조:
 *   1) 15분마다 거래대금 상위 코인 선별 (적합성 점수)
 *   2) 5분마다 각 코인 캔들 수집 → 지표 계산 + OB 감지
 *   3) WebSocket 실시간 가격 → 5개 전략 스코어 합산 → 매수
 *   4) 포지션 감시 → ATR 기반 동적 SL/TP/트레일링 → 매도
 *   5) 대시보드로 실시간 모니터링
 *
 * v2 변경점:
 *   - OB-only → 멀티 전략 스코어링 (RSI, BB, 변동성돌파, EMA, OB)
 *   - 고정 SL → ATR 기반 동적 SL/TP
 *   - 단일 전략 의존 → 최소 2개 전략 확인 필수
 *   - 변동성 기반 포지션 사이징
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const upbit = require('./upbit-api');
const ob = require('./ob-engine');
const stratEngine = require('./strategy-engine');
const emailService = require('./email-service');
const waveHarvest = require('./wave-harvest-engine');

// ── 설정 로드 ─────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');
const STATE_PATH = path.join(__dirname, 'data', 'state.json');
const LOG_PATH = path.join(__dirname, 'data', 'trade-log.json');

function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); }
  catch { return createDefaultState(); }
}
function saveState(st) { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)); }

function createDefaultState() {
  return {
    positions: [],         // 현재 보유 포지션
    totalPnl: 0,           // 누적 손익
    totalTrades: 0,        // 총 거래 수
    wins: 0,               // 승리 수
    losses: 0,             // 패배 수
    dailyPnl: [],          // 일별 손익
    watchlist: [],          // 감시 중인 코인
    orderBlocks: {},        // 코인별 활성 OB { coin: [ob, ...] }
    lastScan: null,
    tradingDays: 0,
  };
}

let config = loadConfig();
let state = loadState();

// ── 이메일 알림 초기화 ─────────────────────────────
if (config.email) {
  emailService.init(config.email);
}

// ── 동시 실행 방지 락 ───────────────────
const entryLocks = new Set();  // 매수 중인 코인
const exitLocks = new Set();   // 매도 중인 코인

// ── 미체결 지정가 매수 주문 관리 (파일로 영구 저장) ──
const PENDING_PATH = path.join(__dirname, 'data', 'pending-orders.json');
function loadPendingOrders() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8')); }
  catch { return {}; }
}
function savePendingOrders() {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pendingBuyOrders, null, 2));
}
const pendingBuyOrders = loadPendingOrders();

// ── WebSocket 재연결용 마켓 리스트 저장 ──
let currentMarkets = [];
let lastCashWarnTime = 0;
let lastDailyLossWarnTime = 0;

// ── 연속 손절 감시 ──────────────────────────────
let consecutiveLosses = 0;
let cooldownUntil = 0; // 자동매매 일시 중지 해제 시각

// ── 코인별 재진입 쿨다운 (cooldownCandles 구현) ──
const coinCooldowns = {}; // { coin: cooldownExpiresAt (timestamp) }

// ── v2: 코인별 지표 캐시 ──
const indicatorsCache = {}; // { coin: { ind, candles, updatedAt } }
const signalCache = {};     // { coin: { signal, updatedAt } }

// ── 로깅 ──────────────────────────────────────────
const logs = [];
function log(msg, level = 'info') {
  const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const entry = { time, level, msg };
  logs.unshift(entry);
  if (logs.length > 500) logs.length = 500;
  const icon = { info: '📋', warn: '⚠️', error: '❌', trade: '💰' }[level] || '📋';
  console.log(`[${time}] ${icon} ${msg}`);
  broadcastToClients({ type: 'log', data: entry });
}

// ── 거래 기록 ─────────────────────────────────────
function appendTradeLog(trade) {
  let trades = [];
  try { trades = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8')); } catch {}
  trades.unshift({ ...trade, timestamp: new Date().toISOString() });
  if (trades.length > 1000) trades.length = 1000;
  fs.writeFileSync(LOG_PATH, JSON.stringify(trades, null, 2));
}

// ── WebSocket 서버 (대시보드 실시간 업데이트) ──────
let wsClients = [];
function broadcastToClients(data) {
  const msg = JSON.stringify(data);
  wsClients = wsClients.filter(ws => ws.readyState === WebSocket.OPEN);
  wsClients.forEach(ws => { try { ws.send(msg); } catch {} });
}

// 3초마다 포지션 보유 중이면 가격 업데이트 브로드캐스트
setInterval(() => {
  if (wsClients.length > 0) {
    broadcastToClients({ type: 'prices', data: latestPrices });
  }
}, 3000);

// ── 업비트 WebSocket (실시간 체결가) ──────────────
let upbitWs = null;
const latestPrices = {};

// v2: 실시간 체결 데이터 (체결강도, 매수/매도 비율)
const tradeIntensity = {}; // { market: { buyVol, sellVol, lastUpdate, bigBuy } }

let wsReconnectDelay = 5000; // 초기 재연결 대기시간
const WS_MAX_DELAY = 60000; // 최대 60초

function connectUpbitWebSocket(markets) {
  if (upbitWs) { try { upbitWs.close(); } catch {} }
  if (!markets || markets.length === 0) return;

  // [FIX #6] 재연결용으로 저장
  currentMarkets = markets;

  upbitWs = new WebSocket('wss://api.upbit.com/websocket/v1');

  let pingInterval = null;

  upbitWs.on('open', () => {
    wsReconnectDelay = 5000; // 연결 성공 시 딜레이 초기화
    log(`업비트 WebSocket 연결 (${markets.length}개 코인 — ticker+trade 실시간 감시)`);
    const msg = JSON.stringify([
      { ticket: 'scalper-v2-' + Date.now() },
      { type: 'ticker', codes: markets, isOnlyRealtime: true },
      { type: 'trade', codes: markets, isOnlyRealtime: true },
    ]);
    upbitWs.send(msg);

    // 20초마다 PING 전송 (연결 유지)
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      try { if (upbitWs.readyState === WebSocket.OPEN) upbitWs.ping(); } catch {}
    }, 20000);
  });

  // 업비트 WebSocket ping → pong 응답 (연결 유지)
  upbitWs.on('ping', (data) => {
    try { upbitWs.pong(data); } catch {}
  });

  upbitWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === 'ticker') {
        const market = parsed.code;
        const price = parsed.trade_price;
        latestPrices[market] = price;

        if (config.autoTrading) {
          checkEntrySignal(market, price).catch(e => log(`진입 체크 에러(${market}): ${e.message}`, 'error'));
          checkExitSignal(market, price).catch(e => log(`청산 체크 에러(${market}): ${e.message}`, 'error'));
        }

        // WaveHarvest에 실시간 가격 전달
        waveHarvest.onPriceUpdate(market, price);
      }

      // v2: 체결 데이터 → 체결강도 집계
      if (parsed.type === 'trade') {
        const market = parsed.code;
        const vol = parsed.trade_volume || 0;
        const isBuy = parsed.ask_bid === 'BID';

        if (!tradeIntensity[market]) {
          tradeIntensity[market] = { buyVol: 0, sellVol: 0, lastUpdate: Date.now(), bigBuyCount: 0, totalTrades: 0 };
        }
        const ti = tradeIntensity[market];

        // 5분 윈도우 리셋
        if (Date.now() - ti.lastUpdate > 5 * 60 * 1000) {
          ti.buyVol = 0;
          ti.sellVol = 0;
          ti.bigBuyCount = 0;
          ti.totalTrades = 0;
          ti.lastUpdate = Date.now();
        }

        if (isBuy) ti.buyVol += vol;
        else ti.sellVol += vol;
        ti.totalTrades++;

        // 대량 매수 감지 (평균 체결량의 5배 이상)
        const avgVol = (ti.buyVol + ti.sellVol) / Math.max(ti.totalTrades, 1);
        if (isBuy && vol > avgVol * 5) {
          ti.bigBuyCount++;
        }
      }
    } catch {}
  });

  upbitWs.on('close', () => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (!config.autoTrading) return; // OFF면 재연결 안 함
    log(`업비트 WebSocket 연결 끊김 — ${wsReconnectDelay/1000}초 후 재연결`, 'warn');
    // [FIX #6] 저장된 마켓 리스트로 재연결 (backoff)
    setTimeout(() => connectUpbitWebSocket(currentMarkets), wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_DELAY);
  });

  upbitWs.on('error', (e) => {
    log(`업비트 WebSocket 에러: ${e.message}`, 'error');
  });
}

// ── [FIX #2] 실제 업비트 잔고 조회 ───────────────
async function getAvailableCash() {
  try {
    const balance = await upbit.getBalance(config.upbit.accessKey, config.upbit.secretKey);
    return balance;
  } catch (e) {
    log(`잔고 조회 실패: ${e.message} — 포지션 기반 추정 사용`, 'warn');
    // 폴백: 포지션 기반 추정
    const invested = state.positions.reduce((s, p) => s + p.amount, 0);
    return Math.max(config.strategy.initialCapital - invested + state.totalPnl, 0);
  }
}

// ── 코인 스캔 (1시간마다) ─────────────────────────
async function scanTopCoins() {
  try {
    const strat = config.strategy;
    const topCoins = await upbit.getTopMarkets(0); // 전체 KRW 코인 감시

    // 최소 코인 가격 필터 (500원 미만 코인 제외 — 호가 단위 문제)
    const minCoinPrice = strat.minCoinPrice || 0;
    const filtered = minCoinPrice > 0
      ? topCoins.filter(t => t.price >= minCoinPrice)
      : topCoins;

    if (filtered.length < topCoins.length) {
      const excluded = topCoins.filter(t => t.price < minCoinPrice).map(t => t.coin);
      log(`${excluded.length}개 저가 코인 제외 (${minCoinPrice}원 미만): ${excluded.join(', ')}`, 'info');
    }

    state.watchlist = filtered.map(t => ({
      market: t.market,
      coin: t.coin,
      price: t.price,
      volume24h: t.volume24h,
    }));

    const markets = topCoins.map(t => t.market);

    // 보유 포지션 코인을 WebSocket 감시 목록에 반드시 포함 (watchlist에 없어도 SL/TP/TIMEOUT 작동)
    const posMarkets = state.positions.map(p => p.market).filter(m => !markets.includes(m));
    if (posMarkets.length > 0) {
      markets.push(...posMarkets);
      log(`보유 포지션 ${posMarkets.map(m => m.replace('KRW-', '')).join(', ')} → WebSocket 감시에 추가`, 'info');
    }

    log(`코인 스캔 완료: 전체 ${topCoins.length}개 중 매매대상 ${filtered.length}개 (${minCoinPrice}원↑)`);

    // watchlist 변경 시에만 WebSocket 재연결
    const oldMarkets = [...(currentMarkets || [])].sort().join(',');
    const newMarkets = [...markets].sort().join(',');
    if (oldMarkets !== newMarkets || !upbitWs || upbitWs.readyState !== WebSocket.OPEN) {
      connectUpbitWebSocket(markets);
    }
    await updateAllOBs();

    state.lastScan = new Date().toISOString();
    saveState(state);
    broadcastToClients({ type: 'state', data: getPublicState() });
  } catch (e) {
    log(`코인 스캔 에러: ${e.message}`, 'error');
  }
}

// ── OB + 지표 업데이트 (5분마다) ─────────────────
async function updateAllOBs() {
  const strat = config.strategy;
  const candleMinute = strat.candleMinute || 5;

  for (const item of state.watchlist) {
    try {
      const rawCandles = await upbit.getCandles(item.market, candleMinute, 200);
      const candles = ob.normalizeCandles(rawCandles);
      if (candles.length < 50) continue;

      // OB 감지
      const obs = ob.detectOrderBlocks(candles, strat);
      const now = new Date();
      const maxAgeMs = (strat.obMaxAge || 24) * candleMinute * 60 * 1000;
      const activeOBs = obs
        .filter(o => !o.used && !o.broken)
        .filter(o => {
          const obTime = new Date(o.time);
          return (now - obTime) < maxAgeMs;
        })
        .slice(-10);

      state.orderBlocks[item.coin] = activeOBs;

      // v2: 지표 계산 + 캐시
      const ind = stratEngine.computeIndicators(candles);
      indicatorsCache[item.coin] = { ind, candles, updatedAt: Date.now() };

      // 최근 봉 저장 (하위 호환)
      if (!state.recentCandles) state.recentCandles = {};
      state.recentCandles[item.coin] = candles.slice(-5);

      // v2: 시그널 미리 계산 (마지막 봉 기준)
      const v2 = strat.v2 || {};
      const signal = stratEngine.generateSignal(ind, candles.length - 1, candles, activeOBs, {
        minScore: v2.minScore || 20,        // v3: 가중합 구조 반영 (config 우선, 폴백 20)
        atrSlMultiplier: v2.atrSlMultiplier || 2.5,  // v3: 1.5 → 2.5
        rrRatio: v2.rrRatio || 2.0,         // v3: 1.5 → 2.0
        volatilityK: v2.volatilityK || 0.5,
        maxAtrSlPct: v2.maxAtrSlPct || 3.0,
        minAtrSlPct: v2.minAtrSlPct || 1.5, // v3: 0.5 → 1.5
      });

      signalCache[item.coin] = { signal, updatedAt: Date.now() };

      if (signal) {
        const stratNames = signal.strategies.map(s => s.name).join('+');
        log(`🎯 ${item.coin}: 시그널 score=${signal.score} [${stratNames}] SL=${signal.slPct}% TP=${signal.tpPct}%`);
      }

      if (activeOBs.length > 0 && !signal) {
        log(`${item.coin}: ${activeOBs.length}개 OB 활성 (시그널 미달)`);
      }

      await sleep(200);
    } catch (e) {
      log(`${item.coin} 업데이트 에러: ${e.message}`, 'error');
    }
  }

  saveState(state);
  broadcastToClients({ type: 'state', data: getPublicState() });
}

// ── [FIX #9] 거래량 활성도 체크 ──────────────────
// 최근 1시간 거래량 / 직전 1시간 거래량 >= 1.2x 인지 확인
async function checkVolumeActivity(market) {
  try {
    const rawCandles = await upbit.getCandles(market, 5, 24); // 최근 2시간 (24 × 5분)
    if (!Array.isArray(rawCandles) || rawCandles.length < 24) return true; // 데이터 부족 시 통과

    // 최근 12봉(1시간) 거래량
    let recentVol = 0;
    for (let i = 0; i < 12; i++) recentVol += rawCandles[i].candle_acc_trade_volume || 0;

    // 직전 12봉(1시간) 거래량
    let prevVol = 0;
    for (let i = 12; i < 24; i++) prevVol += rawCandles[i].candle_acc_trade_volume || 0;

    if (prevVol <= 0) return true;
    const ratio = recentVol / prevVol;
    return ratio >= 1.2;
  } catch {
    return true; // API 에러 시 통과
  }
}

// ── [FIX #10] 1시간봉 추세 확인 (MTF 크로스체크) ──
// 최근 2시간 추세 확인 (백테스트 최적: 승률80.6%, EV+1.703%, MDD-3.17%)
async function check1HTrend(market) {
  try {
    const rawCandles = await upbit.getCandles(market, 60, 4); // 1시간봉 4개 (최근 2시간+여유)
    if (!Array.isArray(rawCandles) || rawCandles.length < 2) return true;

    const candles = rawCandles
      .map(c => ({ close: c.trade_price, high: c.high_price }))
      .reverse(); // 오래된 순으로 정렬

    const len = candles.length;

    // 2시간 MA 계산
    const maLen = Math.min(len, 2);
    let maSum = 0;
    for (let i = len - maLen; i < len; i++) maSum += candles[i].close;
    const ma2 = maSum / maLen;

    // 현재 종가가 MA 아래면 하락 추세
    if (candles[len - 1].close < ma2) return false;

    // 최근 고점 연속 하락 체크 (3봉 이상일 때)
    if (len >= 3) {
      const h1 = candles[len - 1].high;
      const h2 = candles[len - 2].high;
      const h3 = candles[len - 3].high;
      if (h1 < h2 && h2 < h3) return false;
    }

    return true;
  } catch {
    return true; // API 에러 시 통과
  }
}

// ── v2: 멀티 전략 진입 시그널 체크 (실시간) ─────────
async function checkEntrySignal(market, price) {
  const coin = market.replace('KRW-', '');
  const strat = config.strategy;
  const v2 = strat.v2 || {};

  // 연속 손절 쿨다운 체크
  if (cooldownUntil > 0) {
    if (Date.now() < cooldownUntil) return;
    log(`🔄 쿨다운 해제 → 자동매매 재시작 (연속 손절 카운터 초기화)`, 'info');
    consecutiveLosses = 0;
    cooldownUntil = 0;
  }

  // 일일 최대 손실 한도 체크 (-3%)
  const dailyLossLimit = v2.maxDailyLossPct || 3.0;
  if (stratEngine.checkDailyLossLimit && state.dailyPnl) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const todayEntry = state.dailyPnl.find(d => d.date === today);
    if (todayEntry && todayEntry.pnl < 0) {
      // Get approximate total capital from config
      const approxCapital = config.strategy.initialCapital || 100000;
      const dailyLossPct = Math.abs(todayEntry.pnl) / approxCapital * 100;
      if (dailyLossPct >= dailyLossLimit) {
        const now = Date.now();
        if (!lastDailyLossWarnTime || now - lastDailyLossWarnTime > 30 * 60 * 1000) {
          log(`🚫 일일 손실 한도 도달 (-${dailyLossPct.toFixed(1)}% >= -${dailyLossLimit}%) — 오늘 매매 중단`, 'warn');
          lastDailyLossWarnTime = now;
        }
        return;
      }
    }
  }

  // 기본 필터
  if (strat.excludeCoins && strat.excludeCoins.includes(coin)) return;
  if (strat.minCoinPrice && price < strat.minCoinPrice) return;

  // 시간대 필터 (v2: 새벽 3~7시 비활성)
  const kstHour = parseInt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false }));
  if (!stratEngine.isGoodTradingHour(kstHour)) return;
  if (strat.excludeHours && strat.excludeHours.includes(kstHour)) return;

  // 최대 포지션 수 체크
  const pendingCount = Object.keys(pendingBuyOrders).length;
  if (state.positions.length + pendingCount >= strat.maxPositions) return;
  if (state.positions.some(p => p.coin === coin)) return;
  if (pendingBuyOrders[coin]) return;

  // 쿨다운 체크
  if (coinCooldowns[coin] && Date.now() < coinCooldowns[coin]) return;
  if (entryLocks.has(coin)) return;

  // v2: 캐시된 시그널 확인 (5분 이내 유효)
  const cached = signalCache[coin];
  if (!cached || !cached.signal) return;
  if (Date.now() - cached.updatedAt > 5 * 60 * 1000) return; // 5분 초과 시그널 무시

  const signal = cached.signal;

  // v3: 레짐 정보 로깅 (전략 필터링은 generateSignal 내부에서 수행됨)

  // v2: 체결강도 확인 (매수세 > 매도세 필요)
  const ti = tradeIntensity[market];
  if (ti && ti.totalTrades > 10) {
    const intensity = ti.sellVol > 0 ? (ti.buyVol / ti.sellVol * 100) : 100;
    if (intensity < 80) {
      // 매도세가 강하면 진입하지 않음
      return;
    }
    // 체결강도 120% 이상이면 로그
    if (intensity >= 120 || ti.bigBuyCount > 0) {
      log(`${coin} 체결강도 ${intensity.toFixed(0)}% (매수세 강함${ti.bigBuyCount > 0 ? ', 대량매수 ' + ti.bigBuyCount + '건' : ''})`, 'info');
    }
  }

  // 락 설정
  entryLocks.add(coin);

  try {
    // v2: 시그널의 SL/TP 사용 (ATR 기반 동적)
    const buyDiscount = v2.buyDiscountPct || strat.buyDiscountPct || 0.5;
    const rawLimitPrice = price * (1 - buyDiscount / 100);
    const limitPrice = upbit.roundToTick(rawLimitPrice, 'down');

    // ATR 기반 동적 SL/TP
    const slPrice = upbit.roundToTick(limitPrice * (1 - signal.slPct / 100), 'down');
    const tpPrice = upbit.roundToTick(limitPrice * (1 + signal.tpPct / 100), 'up');

    // 최소 TP 확인 (수수료 0.1% 왕복 커버 + 최소 마진)
    const expectedPct = (tpPrice - limitPrice) / limitPrice * 100;
    if (expectedPct < 0.3) {
      log(`${coin} 시그널 있으나 TP 너무 가까움 (${expectedPct.toFixed(2)}%) — 스킵`, 'warn');
      return;
    }

    // SL이 진입가 이상이면 스킵
    if (slPrice >= limitPrice) return;

    // v2: 변동성 기반 포지션 사이징
    const accounts = await upbit.getAccounts(config.upbit.accessKey, config.upbit.secretKey);
    const krwAcc = accounts.find(a => a.currency === 'KRW');
    const krwTotal = krwAcc ? parseFloat(krwAcc.balance) + parseFloat(krwAcc.locked || 0) : 0;
    const krwAvail = krwAcc ? parseFloat(krwAcc.balance) : 0;

    // 포지션 사이징: ATR 기반 리스크 1%
    const maxRiskPct = v2.maxRiskPct || 1.0;
    const atrBasedAmount = stratEngine.calcPositionSize(krwTotal, signal.atr, limitPrice, slPrice, maxRiskPct);
    const allocAmount = Math.floor(Math.min(atrBasedAmount, krwTotal * 0.995 / strat.maxPositions));

    const orderAmount = Math.min(allocAmount, Math.floor(krwAvail * 0.995));
    if (orderAmount < strat.minOrderAmount) {
      const now = Date.now();
      if (!lastCashWarnTime || now - lastCashWarnTime > 5 * 60 * 1000) {
        log(`자금 부족: 가용 ${Math.round(krwAvail).toLocaleString()}원 / 배분 ${allocAmount.toLocaleString()}원`, 'warn');
        lastCashWarnTime = now;
      }
      return;
    }

    const buyVolume = Math.floor(orderAmount / limitPrice * 100000000) / 100000000;
    const stratNames = signal.strategies.map(s => s.name).join('+');

    log(`🎯 ${coin} v2 매수! score=${signal.score} [${stratNames}] ${Math.round(limitPrice).toLocaleString()}원 × ${orderAmount.toLocaleString()}원 | TP:+${signal.tpPct}% SL:-${signal.slPct}%`, 'trade');

    const result = await upbit.buyLimit(
      config.upbit.accessKey, config.upbit.secretKey,
      market, buyVolume, limitPrice
    );

    if (signal.touchedOB) signal.touchedOB.used = true;

    pendingBuyOrders[coin] = {
      orderId: result.uuid,
      market,
      limitPrice,
      tpPrice,
      slPrice,
      amount: orderAmount,
      volume: buyVolume,
      placedAt: Date.now(),
      signalScore: signal.score,
      strategies: stratNames,
      atr: signal.atr,  // v4: 트레일링 동적 계산용
    };
    savePendingOrders();

    // 시그널 소비 (다음 업데이트까지 재진입 방지)
    signalCache[coin] = { signal: null, updatedAt: Date.now() };

    log(`📋 ${coin} 지정가 매수 대기 중 (5분 내 미체결 시 자동 취소)`, 'info');
    broadcastToClients({ type: 'state', data: getPublicState() });
  } catch (e) {
    log(`❌ ${coin} 매수 주문 실패: ${e.message}`, 'error');
  } finally {
    entryLocks.delete(coin);
  }
}

// ── 대기 주문 전체 취소 (쿨다운 시) ─────────────────
async function cancelAllPendingOrders() {
  const keys = Object.keys(pendingBuyOrders);
  for (const coin of keys) {
    const pending = pendingBuyOrders[coin];
    try {
      await upbit.cancelOrder(config.upbit.accessKey, config.upbit.secretKey, pending.orderId);
      log(`🚫 쿨다운 → ${coin} 대기 매수 취소`, 'warn');
    } catch (e) {
      log(`${coin} 대기 주문 취소 실패: ${e.message}`, 'error');
    }
    delete pendingBuyOrders[coin];
  }
  savePendingOrders();
}

// ── 미체결 매수 주문 체결 확인 + 타임아웃 관리 ─────
async function checkPendingBuyOrders() {
  const keys = Object.keys(pendingBuyOrders);
  if (keys.length === 0) return;

  for (const coin of keys) {
    const pending = pendingBuyOrders[coin];
    if (!pending) continue;

    try {
      const orderInfo = await upbit.getOrder(
        config.upbit.accessKey, config.upbit.secretKey, pending.orderId
      );

      // 체결 완료
      if (orderInfo.state === 'done') {
        let actualEntryPrice = pending.limitPrice;
        let actualVolume = pending.volume;

        if (orderInfo.trades && orderInfo.trades.length > 0) {
          let totalFunds = 0, totalVol = 0;
          for (const t of orderInfo.trades) {
            totalFunds += parseFloat(t.funds);
            totalVol += parseFloat(t.volume);
          }
          if (totalVol > 0) {
            actualEntryPrice = totalFunds / totalVol;
            actualVolume = totalVol;
          }
        }

        // TP 지정가 매도 예약 (호가 단위 적용)
        let tpOrderId = null;
        const tpSellPrice = upbit.roundToTick(pending.tpPrice, 'up');
        try {
          const tpOrder = await upbit.sellLimit(
            config.upbit.accessKey, config.upbit.secretKey,
            pending.market, actualVolume, tpSellPrice
          );
          tpOrderId = tpOrder.uuid;
          log(`📌 ${coin} TP 지정가 매도 예약: ${Math.round(pending.tpPrice).toLocaleString()}원`, 'info');
        } catch (e) {
          log(`${coin} TP 매도 예약 실패: ${e.message}`, 'warn');
        }

        // 매수 수수료 0.05% 반영 (실질 진입 단가)
        const entryWithCommission = actualEntryPrice * (1 + 0.0005);

        const position = {
          coin,
          market: pending.market,
          entryPrice: entryWithCommission,
          tpPrice: pending.tpPrice,
          slPrice: pending.slPrice,
          amount: pending.amount,
          volume: actualVolume,
          orderId: pending.orderId,
          tpOrderId,
          entryTime: new Date().toISOString(),
          obImpulse: pending.obImpulse,
          signalScore: pending.signalScore || 0,
          strategies: pending.strategies || 'OB',
          sellRetries: 0,
          atr: pending.atr || 0,  // v4: 동적 트레일링용
        };

        state.positions.push(position);
        delete pendingBuyOrders[coin];
        savePendingOrders();
        saveState(state);

        log(`✅ ${coin} 지정가 매수 체결! ${Math.round(actualEntryPrice).toLocaleString()}원 × ${pending.amount.toLocaleString()}원 | TP: ${Math.round(pending.tpPrice).toLocaleString()} SL: ${Math.round(pending.slPrice).toLocaleString()}`, 'trade');

        emailService.sendBuyAlert(position).catch(() => {});
        appendTradeLog({
          action: 'BUY', coin, market: pending.market,
          price: Math.round(actualEntryPrice), amount: pending.amount,
          tpPrice: Math.round(pending.tpPrice), slPrice: Math.round(pending.slPrice),
        });
        broadcastToClients({ type: 'state', data: getPublicState() });
        continue;
      }

      // 5분 초과 미체결 → 취소
      const elapsed = Date.now() - pending.placedAt;
      if (elapsed > 5 * 60 * 1000) {
        try {
          await upbit.cancelOrder(config.upbit.accessKey, config.upbit.secretKey, pending.orderId);
          log(`⏰ ${coin} 매수 주문 5분 미체결 — 취소 (${Math.round(pending.limitPrice).toLocaleString()}원)`, 'warn');
        } catch (e) {
          log(`${coin} 매수 취소 실패: ${e.message}`, 'warn');
        }

        // 부분 체결 확인 — 체결된 수량이 있으면 포지션 등록
        try {
          await sleep(500);
          const cancelledOrder = await upbit.getOrder(config.upbit.accessKey, config.upbit.secretKey, pending.orderId);
          const execVol = parseFloat(cancelledOrder.executed_volume || 0);
          if (execVol > 0) {
            let actualPrice = pending.limitPrice;
            if (cancelledOrder.trades && cancelledOrder.trades.length > 0) {
              let totalFunds = 0, totalVol = 0;
              for (const t of cancelledOrder.trades) {
                totalFunds += parseFloat(t.funds);
                totalVol += parseFloat(t.volume);
              }
              if (totalVol > 0) actualPrice = totalFunds / totalVol;
            }
            const entryWithComm = actualPrice * 1.0005;
            const tpSellPrice = upbit.roundToTick(pending.tpPrice, 'up');
            let tpOrderId = null;
            try {
              const tpOrder = await upbit.sellLimit(config.upbit.accessKey, config.upbit.secretKey, pending.market, execVol, tpSellPrice);
              tpOrderId = tpOrder.uuid;
            } catch (e2) { log(`${coin} 부분체결 TP 예약 실패: ${e2.message}`, 'warn'); }

            state.positions.push({
              coin, market: pending.market, entryPrice: entryWithComm,
              tpPrice: pending.tpPrice, slPrice: pending.slPrice,
              amount: Math.round(actualPrice * execVol), volume: execVol,
              orderId: pending.orderId, tpOrderId, entryTime: new Date().toISOString(),
              signalScore: pending.signalScore || 0, strategies: pending.strategies || '',
              sellRetries: 0,
              atr: pending.atr || 0,  // v4: 동적 트레일링용
            });
            saveState(state);
            log(`⚠️ ${coin} 부분체결 ${execVol}개 → 포지션 등록 (${Math.round(actualPrice).toLocaleString()}원)`, 'trade');
          }
        } catch (e3) {
          log(`${coin} 부분체결 확인 실패: ${e3.message}`, 'warn');
        }

        delete pendingBuyOrders[coin];
        savePendingOrders();
        broadcastToClients({ type: 'state', data: getPublicState() });
      }

    } catch (e) {
      log(`${coin} 매수 주문 조회 실패: ${e.message}`, 'warn');
    }

    await sleep(200); // API 속도 제한
  }
}

// ── 청산 시그널 체크 (실시간) ─────────────────────
// TP: 지정가 주문 체결 확인 (슬리피지 0)
// SL/TIMEOUT: 지정가 취소 → 시장가 매도 (빠른 탈출)
async function checkExitSignal(market, price) {
  const coin = market.replace('KRW-', '');

  const pos = state.positions.find(p => p.coin === coin);
  if (!pos) return;

  // [FIX #1] 동시 실행 방지 — 모든 async 작업 전에 락
  if (exitLocks.has(coin)) return;
  exitLocks.add(coin);

  try {
    // ── TP 지정가 주문 체결 확인 ──
    if (pos.tpOrderId) {
      try {
        const orderInfo = await upbit.getOrder(config.upbit.accessKey, config.upbit.secretKey, pos.tpOrderId);
        if (orderInfo.state === 'done') {
          let actualExitPrice = pos.tpPrice;
          if (orderInfo.trades && orderInfo.trades.length > 0) {
            let totalFunds = 0, totalVol = 0;
            for (const t of orderInfo.trades) {
              totalFunds += parseFloat(t.funds);
              totalVol += parseFloat(t.volume);
            }
            if (totalVol > 0) actualExitPrice = totalFunds / totalVol;
          }
          recordExit(pos, 'TP', actualExitPrice);
          return;
        }
      } catch (e) {
        log(`${coin} TP 주문 조회 실패: ${e.message}`, 'warn');
      }
    }

    // ── SL / TIMEOUT 체크 ──
    let exitReason = null;
    const candleMin = config.strategy.candleMinute || 1;

    // 최고가 추적 (트레일링 스탑용)
    if (!pos.highSinceEntry || price > pos.highSinceEntry) {
      pos.highSinceEntry = price;
      // 디바운스: 빈번한 저장 방지 (30초마다 자동 저장으로 대체)
    }

    // v4: ATR 동적 트레일링 스탑 (ATR×1.2, 0.5~2.0% 클램프)
    const v2s = config.strategy.v2 || {};
    const trailActivate = v2s.trailActivatePct || config.strategy.trailActivatePct || 1.5;
    if (trailActivate > 0 && pos.highSinceEntry && pos.atr) {
      const gain = (pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100;
      if (gain >= trailActivate) {
        // v4: ATR×1.2 동적 트레일, 0.5~2.0% 클램프
        let trailPctDynamic = (pos.atr * 1.2) / pos.highSinceEntry * 100;
        trailPctDynamic = Math.max(0.5, Math.min(2.0, trailPctDynamic));
        const trailStop = pos.highSinceEntry * (1 - trailPctDynamic / 100);
        if (price <= trailStop) {
          exitReason = 'TRAIL';
        }
      }
    }

    // v4: SL 5분 유예 — SL 도달 후 5분 대기, 여전히 아래면 실행
    if (!exitReason && price <= pos.slPrice) {
      if (!pos.slHitTime) {
        pos.slHitTime = Date.now();
        log(`${coin} SL 터치 — 5분 유예 시작 (${price.toLocaleString()} ≤ ${pos.slPrice.toLocaleString()})`, 'warn');
      } else if (Date.now() - pos.slHitTime >= 5 * 60 * 1000) {
        exitReason = 'SL';
      }
    } else if (price > pos.slPrice && pos.slHitTime) {
      // SL 위로 복귀 → 유예 리셋
      log(`${coin} SL 유예 취소 — 가격 복귀`, 'info');
      delete pos.slHitTime;
    }
    if (!exitReason) {
      const holdMs = Date.now() - new Date(pos.entryTime).getTime();
      const maxMs = (config.strategy.maxHoldCandles || 60) * candleMin * 60 * 1000;
      if (holdMs >= maxMs) exitReason = 'TIMEOUT';
    }

    if (!exitReason) return;

    // TP 지정가 주문 취소
    if (pos.tpOrderId) {
      try {
        await upbit.cancelOrder(config.upbit.accessKey, config.upbit.secretKey, pos.tpOrderId);
        log(`${coin} TP 지정가 주문 취소 완료`, 'info');
        await sleep(1500); // locked→balance 전환 대기 (충분히)
      } catch (e) {
        log(`${coin} TP 주문 취소 참고: ${e.message}`, 'warn');
        await sleep(1000);
      }
    }

    // 보유 수량 조회 후 시장가 매도 (balance + locked 합산)
    const holdings = await upbit.getHoldings(config.upbit.accessKey, config.upbit.secretKey);
    const holding = holdings.find(h => h.currency === coin);
    const sellVolume = holding ? (holding.balance + (holding.locked || 0)) : 0;

    if (!holding || sellVolume <= 0) {
      log(`${coin} 보유 수량 없음 — 포지션 정리`, 'warn');
      state.positions = state.positions.filter(p => p.coin !== coin);
      saveState(state);
      return;
    }

    const result = await upbit.sellMarket(
      config.upbit.accessKey, config.upbit.secretKey,
      market, sellVolume
    );

    await sleep(1500);
    let actualExitPrice = price;
    try {
      const orderInfo = await upbit.getOrder(config.upbit.accessKey, config.upbit.secretKey, result.uuid);
      if (orderInfo.trades && orderInfo.trades.length > 0) {
        let totalFunds = 0, totalVol = 0;
        for (const t of orderInfo.trades) {
          totalFunds += parseFloat(t.funds);
          totalVol += parseFloat(t.volume);
        }
        if (totalVol > 0) actualExitPrice = totalFunds / totalVol;
      }
    } catch {}

    recordExit(pos, exitReason, actualExitPrice);
  } catch (e) {
    pos.sellRetries = (pos.sellRetries || 0) + 1;
    log(`❌ ${coin} 매도 실패 (${pos.sellRetries}/5): ${e.message}`, 'error');

    if (pos.sellRetries >= 5) {
      log(`🚨 ${coin} 매도 5회 연속 실패 — 수동 확인 필요! 포지션 유지`, 'error');
      pos.slPrice = 0;
      pos.tpPrice = 999999999;
      saveState(state);
    }
  } finally {
    exitLocks.delete(coin);
  }
}

// ── 청산 기록 공통 함수 ──────────────────────────
function recordExit(pos, exitReason, actualExitPrice) {
  // 매도 수수료 0.05% 차감 (매수 수수료는 entryPrice에 이미 반영됨)
  const netExitPrice = actualExitPrice * (1 - 0.0005);

  // 코인별 재진입 쿨다운 설정
  const candleMin = config.strategy.candleMinute || 1;
  const v2 = config.strategy.v2 || {};
  const cooldownCandles = v2.cooldownCandles || config.strategy.cooldownCandles || 12;
  coinCooldowns[pos.coin] = Date.now() + (cooldownCandles * candleMin * 60 * 1000);
  const pnl = (netExitPrice - pos.entryPrice) / pos.entryPrice * pos.amount;
  const pnlPct = (netExitPrice - pos.entryPrice) / pos.entryPrice * 100;
  const holdMinutes = Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000);

  const icon = exitReason === 'TP' ? '🟢' : exitReason === 'TRAIL' ? '🔵' : exitReason === 'SL' ? '🔴' : '🟡';
  log(`${icon} ${pos.coin} ${exitReason} 매도: ${pos.entryPrice.toLocaleString()} → ${actualExitPrice.toLocaleString()}원 (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%, ${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원, ${holdMinutes}분)`, 'trade');

  state.positions = state.positions.filter(p => p.coin !== pos.coin);
  state.totalPnl += pnl;
  state.totalTrades++;
  if (pnl > 0) state.wins++; else state.losses++;

  // ── 연속 손절 카운터 ──
  if (exitReason === 'SL') {
    consecutiveLosses++;
    log(`⚠️ 연속 손절 ${consecutiveLosses}회`, 'warn');
    if (consecutiveLosses >= 10) {
      cooldownUntil = Date.now() + 3600000; // 1시간 쿨다운
      log(`🚨 연속 손절 ${consecutiveLosses}회 → 자동매매 1시간 중지 (${new Date(cooldownUntil).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 까지)`, 'warn');
      // 대기 중인 매수 주문 전부 취소
      cancelAllPendingOrders().catch(e => log(`대기 주문 취소 실패: ${e.message}`, 'error'));
    }
  } else if (exitReason === 'TP' || exitReason === 'TRAIL') {
    if (consecutiveLosses > 0) {
      log(`✅ 익절 발생 → 연속 손절 카운터 초기화 (${consecutiveLosses} → 0)`, 'info');
    }
    consecutiveLosses = 0;
  }

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  let todayEntry = state.dailyPnl.find(d => d.date === today);
  if (!todayEntry) {
    todayEntry = { date: today, pnl: 0, trades: 0 };
    state.dailyPnl.unshift(todayEntry);
  }
  todayEntry.pnl += pnl;
  todayEntry.trades++;
  if (state.dailyPnl.length > 365) state.dailyPnl.length = 365;

  saveState(state);

  const tradeRecord = {
    action: 'SELL',
    coin: pos.coin, market: pos.market, reason: exitReason,
    entryPrice: Math.round(pos.entryPrice), exitPrice: Math.round(actualExitPrice),
    amount: pos.amount, pnl: Math.round(pnl),
    pnlPct: +pnlPct.toFixed(2),
    holdMinutes,
    strategies: pos.strategies || '',
    signalScore: pos.signalScore || 0,
    slPct: pos.slPrice ? +((pos.entryPrice - pos.slPrice) / pos.entryPrice * 100).toFixed(2) : 0,
    tpPct: pos.tpPrice ? +((pos.tpPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : 0,
    highSinceEntry: pos.highSinceEntry || 0,
    maxUnrealizedPct: pos.highSinceEntry ? +((pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : 0,
  };

  appendTradeLog(tradeRecord);
  emailService.sendSellAlert(tradeRecord).catch(() => {});
  broadcastToClients({ type: 'state', data: getPublicState() });
}

// ── [FIX #4] 전체 매도 (안전한 방식) ─────────────
async function sellAllPositions() {
  log('🚨 수동 전체 매도 실행', 'warn');

  for (const pos of [...state.positions]) {
    // 제외 코인은 전체 매도에서도 보호
    if (config.strategy.excludeCoins && config.strategy.excludeCoins.includes(pos.coin)) {
      log(`🔒 ${pos.coin} 매도 제외 (보호 코인)`, 'warn');
      continue;
    }
    try {
      // TP 지정가 주문 취소
      if (pos.tpOrderId) {
        try { await upbit.cancelOrder(config.upbit.accessKey, config.upbit.secretKey, pos.tpOrderId); } catch {}
        await sleep(500);
      }

      const holdings = await upbit.getHoldings(config.upbit.accessKey, config.upbit.secretKey);
      const holding = holdings.find(h => h.currency === pos.coin);
      const totalBalance = holding ? (holding.balance + (holding.locked || 0)) : 0;

      if (!holding || totalBalance <= 0) {
        log(`${pos.coin} 보유 수량 없음 — 포지션 정리`, 'warn');
        state.positions = state.positions.filter(p => p.coin !== pos.coin);
        saveState(state);
        continue;
      }

      // locked가 있으면 balance만 매도 (TP 취소 후 대기해야 함)
      const sellVol = holding.balance > 0 ? holding.balance : totalBalance;
      const result = await upbit.sellMarket(
        config.upbit.accessKey, config.upbit.secretKey,
        pos.market, sellVol
      );

      const price = latestPrices[pos.market] || pos.entryPrice;
      const netPrice = price * (1 - 0.0005); // 매도 수수료 0.05% 반영
      const pnl = (netPrice - pos.entryPrice) / pos.entryPrice * pos.amount;
      const pnlPct = (netPrice - pos.entryPrice) / pos.entryPrice * 100;

      log(`✅ ${pos.coin} 강제 매도 완료 (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`, 'trade');

      state.positions = state.positions.filter(p => p.coin !== pos.coin);
      state.totalPnl += pnl;
      state.totalTrades++;
      if (pnl > 0) state.wins++; else state.losses++;
      saveState(state);

      const holdMinutes = Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000);
      appendTradeLog({
        action: 'SELL', coin: pos.coin, market: pos.market, reason: 'MANUAL',
        entryPrice: Math.round(pos.entryPrice), exitPrice: Math.round(price),
        amount: pos.amount, pnl: Math.round(pnl), pnlPct: +pnlPct.toFixed(2),
        holdMinutes,
      });

      await sleep(300);
    } catch (e) {
      log(`❌ ${pos.coin} 강제 매도 실패: ${e.message}`, 'error');
    }
  }

  broadcastToClients({ type: 'state', data: getPublicState() });
}

// ── [추가] 서버 시작 시 보유 코인 동기화 ──────────
async function syncPositionsWithUpbit() {
  try {
    const holdings = await upbit.getHoldings(config.upbit.accessKey, config.upbit.secretKey);
    const accounts = await upbit.getAccounts(config.upbit.accessKey, config.upbit.secretKey);
    const krwAcc = accounts.find(a => a.currency === 'KRW');
    const krwTotal = krwAcc ? parseFloat(krwAcc.balance) + parseFloat(krwAcc.locked || 0) : 0;
    const krwAvail = krwAcc ? parseFloat(krwAcc.balance) : 0;
    const krwLocked = krwAcc ? parseFloat(krwAcc.locked || 0) : 0;

    log(`업비트 잔고 동기화: KRW ${Math.round(krwTotal).toLocaleString()}원 (주문가능 ${Math.round(krwAvail).toLocaleString()}원, 주문대기 ${Math.round(krwLocked).toLocaleString()}원), 보유코인 ${holdings.length}개`);

    // state에 있는데 실제로 없는 포지션 정리
    const holdingCoins = holdings.map(h => h.currency);
    const orphaned = state.positions.filter(p => !holdingCoins.includes(p.coin));
    if (orphaned.length > 0) {
      log(`⚠️ 유령 포지션 ${orphaned.length}개 정리: ${orphaned.map(p => p.coin).join(', ')}`, 'warn');
      state.positions = state.positions.filter(p => holdingCoins.includes(p.coin));
      saveState(state);
    }

    // 실제 보유 중인데 state에 없는 코인 경고
    for (const h of holdings) {
      if (!state.positions.some(p => p.coin === h.currency)) {
        log(`⚠️ 업비트에 ${h.currency} ${h.balance}개 보유 중이나 봇 포지션에 없음 — 수동 매수 종목?`, 'warn');
      }
    }
  } catch (e) {
    log(`업비트 잔고 동기화 실패: ${e.message}`, 'error');
  }
}

// ── 유틸 ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getPublicState() {
  return {
    positions: state.positions.map(p => ({
      ...p,
      currentPrice: latestPrices[p.market] || p.entryPrice,
      unrealizedPnl: latestPrices[p.market]
        ? +((latestPrices[p.market] - p.entryPrice) / p.entryPrice * 100).toFixed(2)
        : 0,
    })),
    totalPnl: Math.round(state.totalPnl),
    totalTrades: state.totalTrades,
    winRate: state.totalTrades > 0 ? +(state.wins / state.totalTrades * 100).toFixed(1) : 0,
    wins: state.wins,
    losses: state.losses,
    dailyPnl: state.dailyPnl.slice(0, 30),
    watchlist: state.watchlist,
    activeOBs: Object.entries(state.orderBlocks).reduce((acc, [coin, obs]) => {
      const active = obs.filter(o => !o.used && !o.broken);
      if (active.length > 0) acc[coin] = active;
      return acc;
    }, {}),
    pendingOrders: Object.entries(pendingBuyOrders).map(([coin, p]) => ({
      coin, market: p.market, limitPrice: p.limitPrice,
      currentPrice: latestPrices[p.market] || 0,
      tpPrice: p.tpPrice, slPrice: p.slPrice, amount: p.amount,
      elapsed: Math.round((Date.now() - p.placedAt) / 1000),
      signalScore: p.signalScore || 0,
      strategies: p.strategies || '',
    })),
    // v2: 체결강도 상위 코인
    topIntensity: Object.entries(tradeIntensity)
      .filter(([, v]) => v.totalTrades > 10)
      .map(([market, v]) => ({
        coin: market.replace('KRW-', ''),
        intensity: v.sellVol > 0 ? +(v.buyVol / v.sellVol * 100).toFixed(0) : 100,
        bigBuys: v.bigBuyCount,
      }))
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 5),
    // v2: 활성 시그널 요약
    activeSignals: Object.entries(signalCache)
      .filter(([, v]) => v.signal && Date.now() - v.updatedAt < 5 * 60 * 1000)
      .map(([coin, v]) => ({
        coin,
        score: v.signal.score,
        strategies: v.signal.strategies.map(s => s.name),
        slPct: v.signal.slPct,
        tpPct: v.signal.tpPct,
      })),
    autoTrading: config.autoTrading,
    lastScan: state.lastScan,
    consecutiveLosses,
    cooldownUntil: cooldownUntil > 0 ? cooldownUntil : null,
    cooldownRemaining: cooldownUntil > Date.now() ? Math.round((cooldownUntil - Date.now()) / 1000) : 0,
  };
}

// ── Express 서버 ──────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

app.get('/api/state', (req, res) => res.json(getPublicState()));

// 실제 업비트 잔고 조회
app.get('/api/balance', async (req, res) => {
  try {
    const accounts = await upbit.getAccounts(config.upbit.accessKey, config.upbit.secretKey);
    const krw = accounts.find(a => a.currency === 'KRW');
    const hideCoins = ['ETC', 'DAWN', 'CTC']; // 장기 보유 — 대시보드에서 숨김
    const holdings = accounts
      .filter(a => a.currency !== 'KRW' && (parseFloat(a.balance) > 0 || parseFloat(a.locked) > 0) && !hideCoins.includes(a.currency))
      .map(a => {
        const market = `KRW-${a.currency}`;
        const currentPrice = latestPrices[market] || parseFloat(a.avg_buy_price);
        const balance = parseFloat(a.balance) + parseFloat(a.locked || 0);
        const avgPrice = parseFloat(a.avg_buy_price);
        const evalAmount = currentPrice * balance;
        const buyAmount = avgPrice * balance;
        return {
          currency: a.currency,
          balance,
          avgBuyPrice: avgPrice,
          currentPrice,
          evalAmount: Math.round(evalAmount),
          pnl: Math.round(evalAmount - buyAmount),
          pnlPct: avgPrice > 0 ? +((currentPrice - avgPrice) / avgPrice * 100).toFixed(2) : 0,
        };
      });
    const krwAvailable = krw ? parseFloat(krw.balance) : 0;
    const krwLocked = krw ? parseFloat(krw.locked || 0) : 0;
    const krwTotal = krwAvailable + krwLocked;
    const totalEval = holdings.reduce((s, h) => s + h.evalAmount, 0);
    res.json({
      krw: Math.round(krwTotal),
      krwAvailable: Math.round(krwAvailable),
      krwLocked: Math.round(krwLocked),
      totalAsset: Math.round(krwTotal + totalEval),
      holdings,
      pendingOrders: Object.entries(pendingBuyOrders).map(([coin, p]) => ({
        coin, market: p.market, price: p.limitPrice,
        amount: p.amount, placedAt: p.placedAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/logs', (req, res) => res.json(logs.slice(0, 100)));
app.get('/api/config', (req, res) => {
  const { upbit: _, ...safeConfig } = config;
  res.json(safeConfig);
});

app.get('/api/trades', (req, res) => {
  try {
    const trades = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
    res.json(trades.slice(0, 100));
  } catch { res.json([]); }
});

app.post('/api/toggle-trading', (req, res) => {
  config.autoTrading = !config.autoTrading;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  log(`자동매매 ${config.autoTrading ? 'ON 🟢' : 'OFF 🔴'}`, config.autoTrading ? 'trade' : 'warn');

  if (config.autoTrading) {
    // ON → WebSocket 재연결 + 스캔 시작
    if (currentMarkets && currentMarkets.length > 0) {
      connectUpbitWebSocket(currentMarkets);
    } else {
      scanTopCoins();
    }
  } else {
    // OFF → WebSocket 끊기
    if (upbitWs) { try { upbitWs.close(); } catch {} upbitWs = null; }
    log('WebSocket 연결 해제 — 대기 모드', 'warn');
  }

  broadcastToClients({ type: 'state', data: getPublicState() });
  res.json({ autoTrading: config.autoTrading });
});

app.post('/api/force-scan', async (req, res) => {
  await scanTopCoins();
  res.json({ ok: true });
});

// [FIX #4] 안전한 전체 매도
app.post('/api/cancel-pending', async (req, res) => {
  await cancelAllPendingOrders();
  log('📋 대기 주문 전체 수동 취소', 'info');
  res.json({ ok: true });
});

app.post('/api/sell-all', async (req, res) => {
  await sellAllPositions();
  res.json({ ok: true });
});

// ── WaveHarvest API ──────────────────────────────
app.get('/api/wh/state', (req, res) => {
  res.json(waveHarvest.getState());
});

app.get('/api/wh/logs', (req, res) => {
  res.json(waveHarvest.getLogs());
});

app.get('/api/wh/trades', (req, res) => {
  try {
    const whLogPath = path.join(__dirname, 'data', 'wh-trade-log.json');
    const trades = JSON.parse(fs.readFileSync(whLogPath, 'utf-8'));
    res.json(trades.slice(0, 100));
  } catch { res.json([]); }
});

app.post('/api/wh/toggle', (req, res) => {
  const whState = waveHarvest.getState();
  if (whState.running && whState.enabled) {
    waveHarvest.disable();
    log('[WH] WaveHarvest 비활성화', 'warn');
  } else if (whState.running && !whState.enabled) {
    waveHarvest.enable();
    log('[WH] WaveHarvest 활성화', 'trade');
  }
  res.json(waveHarvest.getState());
});

app.post('/api/wh/update-config', (req, res) => {
  const newCfg = req.body;
  if (newCfg && typeof newCfg === 'object') {
    // config.json에도 저장
    config.waveHarvest = { ...config.waveHarvest, ...newCfg };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    waveHarvest.updateConfig(config.waveHarvest);
    res.json({ ok: true, config: config.waveHarvest });
  } else {
    res.status(400).json({ error: 'invalid body' });
  }
});

app.post('/api/wh/add-position', (req, res) => {
  const result = waveHarvest.addPosition(req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/reset', (req, res) => {
  if (state.positions.length > 0) {
    return res.status(400).json({ error: '보유 포지션이 있으면 초기화할 수 없습니다. 먼저 전체 매도하세요.' });
  }
  state = createDefaultState();
  saveState(state);
  log('상태 초기화 완료');
  res.json({ ok: true });
});

// ── 서버 시작 ─────────────────────────────────────
const PORT = 3002;
const server = app.listen(PORT, async () => {
  log(`24번트 서버 시작: http://localhost:${PORT}`);
  log(`자동매매: ${config.autoTrading ? 'ON' : 'OFF'}`);

  // 업비트 잔고 동기화
  await syncPositionsWithUpbit();

  // TP 주문 없는 포지션에 TP 지정가 매도 재설정
  for (const pos of state.positions) {
    if (!pos.tpOrderId && pos.tpPrice && pos.tpPrice < 999999999) {
      try {
        const tpSellPrice = upbit.roundToTick(pos.tpPrice, 'up');
        const holding = await upbit.getHoldings(config.upbit.accessKey, config.upbit.secretKey);
        const h = holding.find(hh => hh.currency === pos.coin);
        if (h && h.balance > 0) {
          const tpOrder = await upbit.sellLimit(
            config.upbit.accessKey, config.upbit.secretKey,
            pos.market, h.balance, tpSellPrice
          );
          pos.tpOrderId = tpOrder.uuid;
          log(`📌 ${pos.coin} TP 지정가 매도 복구: ${tpSellPrice}원`, 'info');
          saveState(state);
        }
      } catch (e) {
        log(`${pos.coin} TP 복구 실패: ${e.message}`, 'error');
      }
    }
  }

  // 서버 시작 시 미체결 주문 복구 확인
  const pendingKeys = Object.keys(pendingBuyOrders);
  if (pendingKeys.length > 0) {
    log(`📋 미체결 매수 주문 ${pendingKeys.length}개 복구: ${pendingKeys.join(', ')}`, 'info');
    await checkPendingBuyOrders(); // 즉시 상태 확인
  }

  if (config.autoTrading) {
    // 초기 스캔
    await scanTopCoins();
  } else {
    log('자동매매 OFF — WebSocket 연결 대기 중. ON하면 시작합니다.', 'warn');
  }

  // 15분마다 종목 재스캔 (autoTrading ON일 때만)
  setInterval(() => { if (config.autoTrading) scanTopCoins(); }, 15 * 60 * 1000);

  // 1분마다 OB 업데이트 (autoTrading ON일 때만)
  const obInterval = (config.strategy.candleMinute || 1) * 60 * 1000;
  setInterval(() => { if (config.autoTrading) updateAllOBs(); }, obInterval);

  // 10초마다 미체결 매수 주문 체결 확인 + 5분 타임아웃
  setInterval(() => { if (config.autoTrading) checkPendingBuyOrders(); }, 10000);

  // 30초마다 state 자동 저장 (highSinceEntry 등 실시간 변경분)
  setInterval(() => { saveState(state); }, 30000);

  // ── WaveHarvest 엔진 시작 ──
  if (config.waveHarvest) {
    try {
      const whConfig = config.waveHarvest;
      const whKeys = { accessKey: config.upbit.accessKey, secretKey: config.upbit.secretKey };
      await waveHarvest.start(whConfig, whKeys, log);
      if (whConfig.enabled) {
        waveHarvest.enable();
        log('[WH] WaveHarvest 엔진 활성화 상태로 시작');
      } else {
        log('[WH] WaveHarvest 엔진 대기 상태로 시작 (enabled: false)');
      }
    } catch (e) {
      log(`[WH] WaveHarvest 시작 실패: ${e.message}`, 'error');
    }
  }
});

// WebSocket 서버
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  wsClients.push(ws);
  ws.send(JSON.stringify({ type: 'state', data: getPublicState() }));
  ws.send(JSON.stringify({ type: 'logs', data: logs.slice(0, 50) }));
});

log('24번트 — 업비트 오더블록 스캘핑 봇 초기화 완료');
