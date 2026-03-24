/**
 * 24번트 — 업비트 오더블록 스캘핑 자동매매 봇
 *
 * 구조:
 *   1) 1시간마다 거래대금 상위 30개 코인 선별
 *   2) 1분마다 각 코인 1분봉 캔들 수집 → OB 감지
 *   3) WebSocket 실시간 가격 → OB 터치 시 매수
 *   4) 포지션 감시 → TP/SL/트레일링 도달 시 매도
 *   5) 대시보드로 실시간 모니터링
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const upbit = require('./upbit-api');
const ob = require('./ob-engine');
const emailService = require('./email-service');

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

// ── 미체결 지정가 매수 주문 관리 ──────────────────
// { coin: { orderId, market, limitPrice, tpPrice, slPrice, amount, volume, placedAt } }
const pendingBuyOrders = {};

// ── WebSocket 재연결용 마켓 리스트 저장 ──
let currentMarkets = [];
let lastCashWarnTime = 0;

// ── 연속 손절 감시 ──────────────────────────────
let consecutiveLosses = 0;
let cooldownUntil = 0; // 자동매매 일시 중지 해제 시각

// ── 코인별 재진입 쿨다운 (cooldownCandles 구현) ──
const coinCooldowns = {}; // { coin: cooldownExpiresAt (timestamp) }

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
  if (state.positions.length > 0 && wsClients.length > 0) {
    broadcastToClients({ type: 'prices', data: latestPrices });
  }
}, 3000);

// ── 업비트 WebSocket (실시간 체결가) ──────────────
let upbitWs = null;
const latestPrices = {};

function connectUpbitWebSocket(markets) {
  if (upbitWs) { try { upbitWs.close(); } catch {} }
  if (!markets || markets.length === 0) return;

  // [FIX #6] 재연결용으로 저장
  currentMarkets = markets;

  upbitWs = new WebSocket('wss://api.upbit.com/websocket/v1');

  let pingInterval = null;

  upbitWs.on('open', () => {
    log(`업비트 WebSocket 연결 (${markets.length}개 코인 실시간 감시)`);
    const msg = JSON.stringify([
      { ticket: 'scalper-' + Date.now() },
      { type: 'ticker', codes: markets, isOnlyRealtime: true },
    ]);
    upbitWs.send(msg);

    // 30초마다 PING 전송 (연결 유지)
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      try { if (upbitWs.readyState === WebSocket.OPEN) upbitWs.ping(); } catch {}
    }, 30000);
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
          checkEntrySignal(market, price);
          checkExitSignal(market, price);
        }
      }
    } catch {}
  });

  upbitWs.on('close', () => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (!config.autoTrading) return; // OFF면 재연결 안 함
    log('업비트 WebSocket 연결 끊김 — 5초 후 재연결', 'warn');
    // [FIX #6] 저장된 마켓 리스트로 재연결
    setTimeout(() => connectUpbitWebSocket(currentMarkets), 5000);
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
    const topCoins = await upbit.getTopMarkets(strat.topCoinsCount || 20);

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
    log(`코인 스캔 완료: ${markets.map(m => m.replace('KRW-', '')).join(', ')}`);

    // watchlist 변경 시에만 WebSocket 재연결
    const oldMarkets = (currentMarkets || []).sort().join(',');
    const newMarkets = markets.sort().join(',');
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

// ── OB 업데이트 (1분마다) ─────────────────────────
async function updateAllOBs() {
  const strat = config.strategy;
  const candleMinute = strat.candleMinute || 1;

  for (const item of state.watchlist) {
    try {
      const rawCandles = await upbit.getCandles(item.market, candleMinute, 200);
      const candles = ob.normalizeCandles(rawCandles);
      if (candles.length < 50) continue;

      const obs = ob.detectOrderBlocks(candles, strat);

      // 시간 기반 유효기간 필터 (obMaxAge × candleMinute분)
      const now = new Date();
      const maxAgeMs = (strat.obMaxAge || 90) * candleMinute * 60 * 1000;
      const activeOBs = obs
        .filter(o => !o.used && !o.broken)
        .filter(o => {
          const obTime = new Date(o.time);
          return (now - obTime) < maxAgeMs;
        })
        .slice(-10);

      state.orderBlocks[item.coin] = activeOBs;

      if (activeOBs.length > 0) {
        log(`${item.coin}: ${activeOBs.length}개 OB 활성 (최근: ${activeOBs[activeOBs.length - 1].top.toLocaleString()}~${activeOBs[activeOBs.length - 1].bottom.toLocaleString()}원)`);
      }

      await sleep(200);
    } catch (e) {
      log(`${item.coin} OB 업데이트 에러: ${e.message}`, 'error');
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

// ── 진입 시그널 체크 (실시간) ─────────────────────
// 지정가 매수: OB 하단 가격으로 주문 → 체결 대기 → 5분 미체결 시 취소
async function checkEntrySignal(market, price) {
  const coin = market.replace('KRW-', '');
  const strat = config.strategy;

  // 연속 손절 쿨다운 체크
  if (cooldownUntil > 0) {
    if (Date.now() < cooldownUntil) return; // 아직 쿨다운 중
    // 쿨다운 해제
    log(`🔄 쿨다운 해제 → 자동매매 재시작 (연속 손절 카운터 초기화)`, 'info');
    consecutiveLosses = 0;
    cooldownUntil = 0;
  }

  // 제외 코인 필터
  if (strat.excludeCoins && strat.excludeCoins.includes(coin)) return;

  // 최소 가격 필터 (호가 단위 문제 방지)
  if (strat.minCoinPrice && price < strat.minCoinPrice) return;

  // 시간대 필터
  if (strat.excludeHours && strat.excludeHours.length > 0) {
    const hour = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false });
    if (strat.excludeHours.includes(parseInt(hour))) return;
  }

  // 최대 포지션 수 + 대기 주문 합산 체크
  const pendingCount = Object.keys(pendingBuyOrders).length;
  if (state.positions.length + pendingCount >= strat.maxPositions) return;

  // 같은 코인 이미 보유 or 대기 중이면 스킵
  if (state.positions.some(p => p.coin === coin)) return;
  if (pendingBuyOrders[coin]) return;

  // 코인별 재진입 쿨다운 체크
  if (coinCooldowns[coin] && Date.now() < coinCooldowns[coin]) return;

  // 동시 실행 방지
  if (entryLocks.has(coin)) return;

  // 활성 OB 확인
  const activeOBs = state.orderBlocks[coin];
  if (!activeOBs || activeOBs.length === 0) return;

  // OB 터치 확인
  const touchedOB = ob.checkOBTouch(activeOBs, price);
  if (!touchedOB) return;

  // 락 설정
  entryLocks.add(coin);

  try {
    // 추세 필터 (설정으로 ON/OFF)
    if (strat.useTrendFilter) {
      const trendOk = await check1HTrend(market);
      if (!trendOk) {
        log(`${coin} OB 터치했으나 1H 하락추세 — 스킵`, 'warn');
        return;
      }
    }

    // 지정가 매수 가격 = OB 하단 (현재가보다 낮은 가격, 호가 단위 맞춤)
    const buyDiscount = strat.buyDiscountPct || 0.5;
    const rawLimitPrice = Math.min(touchedOB.bottom, price * (1 - buyDiscount / 100));
    const limitPrice = upbit.roundToTick(rawLimitPrice, 'down');

    // TP = 지정가 매수가 기준 +2% 이상 (swingHigh와 비교해서 높은 쪽, 호가 단위 올림)
    const minTpPct = strat.minTpPct || 2.0;
    const tpFromSwing = touchedOB.swingHigh;
    const tpFromMinPct = limitPrice * (1 + minTpPct / 100);
    const tpPrice = upbit.roundToTick(Math.max(tpFromSwing, tpFromMinPct), 'up');

    // 예상 수익률 체크
    const expectedPct = (tpPrice - limitPrice) / limitPrice * 100;
    if (expectedPct < minTpPct) {
      log(`${coin} OB 터치했으나 TP 너무 가까움 (${expectedPct.toFixed(2)}%) — 스킵`, 'warn');
      return;
    }

    // SL = 지정가 매수가 기준 아래로 (호가 단위 내림)
    const slPrice = upbit.roundToTick(limitPrice * (1 - (strat.slPct || 0.5) / 100), 'down');

    // 잔고 조회
    const availCash = await getAvailableCash();
    const availSlots = strat.maxPositions - state.positions.length - pendingCount;
    const allocAmount = Math.floor(availCash * 0.995 / Math.max(availSlots, 1));

    if (allocAmount < strat.minOrderAmount) {
      const now = Date.now();
      if (!lastCashWarnTime || now - lastCashWarnTime > 5 * 60 * 1000) {
        log(`자금 부족: ${Math.round(availCash).toLocaleString()}원 (필요: ${strat.minOrderAmount.toLocaleString()}원)`, 'warn');
        lastCashWarnTime = now;
      }
      return;
    }

    // 매수 수량 계산 (소수점 8자리까지)
    const buyVolume = Math.floor(allocAmount / limitPrice * 100000000) / 100000000;

    log(`🎯 ${coin} 지정가 매수 주문! ${Math.round(limitPrice).toLocaleString()}원 × ${buyVolume.toFixed(4)}개 (현재가 ${price.toLocaleString()}원, 할인 ${buyDiscount}%) | TP: ${Math.round(tpPrice).toLocaleString()} SL: ${Math.round(slPrice).toLocaleString()}`, 'trade');

    // 지정가 매수 주문
    const result = await upbit.buyLimit(
      config.upbit.accessKey, config.upbit.secretKey,
      market, buyVolume, limitPrice
    );

    touchedOB.used = true;

    // 미체결 주문으로 등록 (5분 타이머)
    pendingBuyOrders[coin] = {
      orderId: result.uuid,
      market,
      limitPrice,
      tpPrice,
      slPrice,
      amount: allocAmount,
      volume: buyVolume,
      placedAt: Date.now(),
      obImpulse: touchedOB.impulsePct,
    };

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
          sellRetries: 0,
        };

        state.positions.push(position);
        delete pendingBuyOrders[coin];
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
        delete pendingBuyOrders[coin];
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

  // 제외 코인 필터 (절대 매도 금지)
  if (config.strategy.excludeCoins && config.strategy.excludeCoins.includes(coin)) return;

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
      // highSinceEntry 변경 시 state 저장 (서버 재시작 시 유지)
      saveState(state);
    }

    // 트레일링 스탑 체크
    const trailActivate = config.strategy.trailActivatePct || 0;
    const trailPct = config.strategy.trailPct || 0;
    if (trailActivate > 0 && trailPct > 0 && pos.highSinceEntry) {
      const gain = (pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100;
      if (gain >= trailActivate) {
        const trailStop = pos.highSinceEntry * (1 - trailPct / 100);
        if (price <= trailStop) {
          exitReason = 'TRAIL';
        }
      }
    }

    if (!exitReason && price <= pos.slPrice) {
      exitReason = 'SL';
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
        await sleep(500);
      } catch (e) {
        log(`${coin} TP 주문 취소 참고: ${e.message}`, 'warn');
      }
    }

    // 보유 수량 조회 후 시장가 매도
    const holdings = await upbit.getHoldings(config.upbit.accessKey, config.upbit.secretKey);
    const holding = holdings.find(h => h.currency === coin);
    const sellVolume = holding ? (holding.balance || holding.locked || 0) : 0;

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
  const candleMin = config.strategy.candleMinute || 5;
  const cooldownCandles = config.strategy.cooldownCandles || 3;
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

  const today = new Date().toISOString().slice(0, 10);
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

      if (!holding || holding.balance <= 0) {
        log(`${pos.coin} 보유 수량 없음 — 포지션 정리`, 'warn');
        state.positions = state.positions.filter(p => p.coin !== pos.coin);
        saveState(state);
        continue;
      }

      const result = await upbit.sellMarket(
        config.upbit.accessKey, config.upbit.secretKey,
        pos.market, holding.balance
      );

      const price = latestPrices[pos.market] || pos.entryPrice;
      const pnl = (price - pos.entryPrice) / pos.entryPrice * pos.amount;
      const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;

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
    const balance = await upbit.getBalance(config.upbit.accessKey, config.upbit.secretKey);

    log(`업비트 잔고 동기화: KRW ${Math.round(balance).toLocaleString()}원, 보유코인 ${holdings.length}개`);

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
      tpPrice: p.tpPrice, slPrice: p.slPrice, amount: p.amount,
      elapsed: Math.round((Date.now() - p.placedAt) / 1000),
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
    const holdings = accounts
      .filter(a => a.currency !== 'KRW' && parseFloat(a.balance) > 0)
      .map(a => {
        const market = `KRW-${a.currency}`;
        const currentPrice = latestPrices[market] || parseFloat(a.avg_buy_price);
        const balance = parseFloat(a.balance);
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
    const krwBalance = krw ? parseFloat(krw.balance) : 0;
    const totalEval = holdings.reduce((s, h) => s + h.evalAmount, 0);
    res.json({
      krw: Math.round(krwBalance),
      totalAsset: Math.round(krwBalance + totalEval),
      holdings,
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
app.post('/api/sell-all', async (req, res) => {
  await sellAllPositions();
  res.json({ ok: true });
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
});

// WebSocket 서버
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  wsClients.push(ws);
  ws.send(JSON.stringify({ type: 'state', data: getPublicState() }));
  ws.send(JSON.stringify({ type: 'logs', data: logs.slice(0, 50) }));
});

log('24번트 — 업비트 오더블록 스캘핑 봇 초기화 완료');
