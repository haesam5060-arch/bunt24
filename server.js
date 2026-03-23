/**
 * 24번트 — 업비트 오더블록 스캘핑 자동매매 봇
 *
 * 구조:
 *   1) 1시간마다 거래대금 상위 20개 코인 선별
 *   2) 5분마다 각 코인 캔들 수집 → OB 감지
 *   3) WebSocket 실시간 가격 → OB 터치 시 매수
 *   4) 포지션 감시 → TP/SL 도달 시 매도
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

// ── [FIX #1] 동시 실행 방지 락 ───────────────────
const entryLocks = new Set();  // 매수 중인 코인
const exitLocks = new Set();   // 매도 중인 코인

// ── [FIX #6] WebSocket 재연결용 마켓 리스트 저장 ──
let currentMarkets = [];

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

// ── 업비트 WebSocket (실시간 체결가) ──────────────
let upbitWs = null;
const latestPrices = {};

function connectUpbitWebSocket(markets) {
  if (upbitWs) { try { upbitWs.close(); } catch {} }
  if (!markets || markets.length === 0) return;

  // [FIX #6] 재연결용으로 저장
  currentMarkets = markets;

  upbitWs = new WebSocket('wss://api.upbit.com/websocket/v1');

  upbitWs.on('open', () => {
    log(`업비트 WebSocket 연결 (${markets.length}개 코인 실시간 감시)`);
    const msg = JSON.stringify([
      { ticket: 'scalper-' + Date.now() },
      { type: 'ticker', codes: markets, isOnlyRealtime: true },
    ]);
    upbitWs.send(msg);
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

    state.watchlist = topCoins.map(t => ({
      market: t.market,
      coin: t.coin,
      price: t.price,
      volume24h: t.volume24h,
    }));

    const markets = topCoins.map(t => t.market);
    log(`코인 스캔 완료: ${markets.map(m => m.replace('KRW-', '')).join(', ')}`);

    connectUpbitWebSocket(markets);
    await updateAllOBs();

    state.lastScan = new Date().toISOString();
    saveState(state);
    broadcastToClients({ type: 'state', data: getPublicState() });
  } catch (e) {
    log(`코인 스캔 에러: ${e.message}`, 'error');
  }
}

// ── OB 업데이트 (5분마다) ─────────────────────────
async function updateAllOBs() {
  const strat = config.strategy;

  for (const item of state.watchlist) {
    try {
      const rawCandles = await upbit.getCandles(item.market, 5, 200);
      const candles = ob.normalizeCandles(rawCandles);
      if (candles.length < 50) continue;

      const obs = ob.detectOrderBlocks(candles, strat);

      // [FIX #7] 시간 기반 유효기간 필터 (obMaxAge × 5분)
      const now = new Date();
      const maxAgeMs = (strat.obMaxAge || 24) * 5 * 60 * 1000;
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
async function checkEntrySignal(market, price) {
  const coin = market.replace('KRW-', '');
  const strat = config.strategy;

  // 제외 코인 필터 (절대 매매 금지)
  if (strat.excludeCoins && strat.excludeCoins.includes(coin)) return;

  // 시간대 필터
  if (strat.excludeHours && strat.excludeHours.length > 0) {
    const hour = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false });
    if (strat.excludeHours.includes(parseInt(hour))) return;
  }

  // 최대 포지션 수 체크
  if (state.positions.length >= strat.maxPositions) return;

  // 같은 코인 이미 보유 중이면 스킵
  if (state.positions.some(p => p.coin === coin)) return;

  // [FIX #1] 동시 실행 방지
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
    // [FIX #9] 거래량 활성도 체크 — 백테스트 결과 필터 제거가 더 높은 수익 (EV +1.696% vs +1.612%)
    // 거래량 필터가 좋은 신호까지 걸러내고 있었음 → 제거

    // [FIX #10] 1시간봉 추세 확인 — 하락 추세면 역추세 진입 방지
    const trendOk = await check1HTrend(market);
    if (!trendOk) {
      log(`${coin} OB 터치했으나 1H 하락추세 — 스킵`, 'warn');
      return;
    }

    // [FIX #2] 실제 업비트 잔고 조회
    const availCash = await getAvailableCash();
    const availSlots = strat.maxPositions - state.positions.length;
    const allocAmount = Math.floor(availCash / availSlots);

    if (allocAmount < strat.minOrderAmount) {
      log(`${coin} 자금 부족: ${availCash.toLocaleString()}원 (필요: ${strat.minOrderAmount.toLocaleString()}원)`, 'warn');
      return;
    }

    // 진입/익절/손절 가격
    const prices = ob.calcEntryExitPrices(touchedOB, price, strat);

    // [FIX #8] 최소 수익률 필터 — TP가 진입가 대비 0.8% 미만이면 스킵
    const expectedPct = (prices.tpPrice - price) / price * 100;
    if (expectedPct < 0.8) {
      log(`${coin} OB 터치했으나 TP 너무 가까움 (${expectedPct.toFixed(2)}%) — 스킵`, 'warn');
      return;
    }

    log(`🎯 ${coin} OB 터치! 현재가 ${price.toLocaleString()}원 (OB: ${touchedOB.bottom.toLocaleString()}~${touchedOB.top.toLocaleString()}) | 투자금 ${allocAmount.toLocaleString()}원`, 'trade');

    // 매수 실행
    const result = await upbit.buyMarket(
      config.upbit.accessKey, config.upbit.secretKey,
      market, allocAmount
    );

    // [FIX #5] 실제 체결가 확인 (1초 대기 후 주문 조회)
    await sleep(1500);
    let actualEntryPrice = price;
    try {
      const orderInfo = await upbit.getOrder(config.upbit.accessKey, config.upbit.secretKey, result.uuid);
      if (orderInfo.trades && orderInfo.trades.length > 0) {
        // 가중평균 체결가 계산
        let totalFunds = 0, totalVol = 0;
        for (const t of orderInfo.trades) {
          totalFunds += parseFloat(t.funds);
          totalVol += parseFloat(t.volume);
        }
        if (totalVol > 0) actualEntryPrice = totalFunds / totalVol;
      }
      log(`📊 ${coin} 실제 체결가: ${actualEntryPrice.toLocaleString()}원 (WebSocket: ${price.toLocaleString()}원)`, 'info');
    } catch (e) {
      log(`${coin} 체결가 조회 실패 — WebSocket 가격 사용: ${price.toLocaleString()}원`, 'warn');
    }

    touchedOB.used = true;

    // 실제 체결가 기준으로 TP/SL 재계산
    const finalPrices = ob.calcEntryExitPrices(touchedOB, actualEntryPrice, strat);

    const position = {
      coin,
      market,
      entryPrice: actualEntryPrice,
      tpPrice: finalPrices.tpPrice,
      slPrice: finalPrices.slPrice,
      amount: allocAmount,
      orderId: result.uuid,
      entryTime: new Date().toISOString(),
      obImpulse: touchedOB.impulsePct,
      sellRetries: 0,         // [FIX #3] 매도 재시도 횟수
    };

    state.positions.push(position);
    saveState(state);

    log(`✅ ${coin} 매수 완료: ${actualEntryPrice.toLocaleString()}원 × ${allocAmount.toLocaleString()}원 | TP: ${finalPrices.tpPrice.toLocaleString()} SL: ${finalPrices.slPrice.toLocaleString()}`, 'trade');

    // 이메일 알림
    emailService.sendBuyAlert(position).catch(() => {});

    appendTradeLog({
      action: 'BUY',
      coin, market,
      price: actualEntryPrice,
      amount: allocAmount,
      tpPrice: finalPrices.tpPrice,
      slPrice: finalPrices.slPrice,
    });

    broadcastToClients({ type: 'state', data: getPublicState() });
  } catch (e) {
    log(`❌ ${coin} 매수 실패: ${e.message}`, 'error');
  } finally {
    // [FIX #1] 락 해제
    entryLocks.delete(coin);
  }
}

// ── 청산 시그널 체크 (실시간) ─────────────────────
async function checkExitSignal(market, price) {
  const coin = market.replace('KRW-', '');

  // 제외 코인 필터 (절대 매도 금지)
  if (config.strategy.excludeCoins && config.strategy.excludeCoins.includes(coin)) return;

  const pos = state.positions.find(p => p.coin === coin);
  if (!pos) return;

  // [FIX #1] 동시 실행 방지
  if (exitLocks.has(coin)) return;

  let exitReason = null;

  // 손절
  if (price <= pos.slPrice) {
    exitReason = 'SL';
  }
  // 익절
  else if (price >= pos.tpPrice) {
    exitReason = 'TP';
  }
  // 시간 초과 (maxHoldCandles × 5분)
  else {
    const holdMs = Date.now() - new Date(pos.entryTime).getTime();
    const maxMs = (config.strategy.maxHoldCandles || 60) * 5 * 60 * 1000;
    if (holdMs >= maxMs) exitReason = 'TIMEOUT';
  }

  if (!exitReason) return;

  // 락 설정
  exitLocks.add(coin);

  try {
    // 보유 수량 조회 후 매도
    const holdings = await upbit.getHoldings(config.upbit.accessKey, config.upbit.secretKey);
    const holding = holdings.find(h => h.currency === coin);

    if (!holding || holding.balance <= 0) {
      log(`${coin} 보유 수량 없음 — 포지션 정리`, 'warn');
      state.positions = state.positions.filter(p => p.coin !== coin);
      saveState(state);
      return;
    }

    const result = await upbit.sellMarket(
      config.upbit.accessKey, config.upbit.secretKey,
      market, holding.balance
    );

    // [FIX #5] 실제 체결가 확인
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

    const pnl = (actualExitPrice - pos.entryPrice) / pos.entryPrice * pos.amount;
    const pnlPct = (actualExitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const holdMinutes = Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000);

    const icon = exitReason === 'TP' ? '🟢' : exitReason === 'SL' ? '🔴' : '🟡';
    log(`${icon} ${coin} ${exitReason} 매도: ${pos.entryPrice.toLocaleString()} → ${actualExitPrice.toLocaleString()}원 (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%, ${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원, ${holdMinutes}분)`, 'trade');

    // 상태 업데이트
    state.positions = state.positions.filter(p => p.coin !== coin);
    state.totalPnl += pnl;
    state.totalTrades++;
    if (pnl > 0) state.wins++; else state.losses++;

    // 일별 수익
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
      coin, market, reason: exitReason,
      entryPrice: pos.entryPrice, exitPrice: actualExitPrice,
      amount: pos.amount, pnl: Math.round(pnl),
      pnlPct: +pnlPct.toFixed(2),
      holdMinutes,
    };

    appendTradeLog(tradeRecord);

    // 이메일 알림
    emailService.sendSellAlert(tradeRecord).catch(() => {});

    broadcastToClients({ type: 'state', data: getPublicState() });
  } catch (e) {
    // [FIX #3] 매도 실패 시 재시도 횟수 관리
    pos.sellRetries = (pos.sellRetries || 0) + 1;
    log(`❌ ${coin} 매도 실패 (${pos.sellRetries}/5): ${e.message}`, 'error');

    if (pos.sellRetries >= 5) {
      log(`🚨 ${coin} 매도 5회 연속 실패 — 수동 확인 필요! 포지션 유지`, 'error');
      // 더 이상 자동 매도 시도하지 않도록 SL을 극단적으로 낮춤
      pos.slPrice = 0;
      pos.tpPrice = 999999999;
      saveState(state);
    }
  } finally {
    // [FIX #1] 락 해제
    exitLocks.delete(coin);
  }
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

      appendTradeLog({
        action: 'SELL', coin: pos.coin, market: pos.market, reason: 'MANUAL',
        entryPrice: pos.entryPrice, exitPrice: price,
        amount: pos.amount, pnl: Math.round(pnl), pnlPct: +pnlPct.toFixed(2),
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
    autoTrading: config.autoTrading,
    lastScan: state.lastScan,
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

  // 5분마다 OB 업데이트 (autoTrading ON일 때만)
  setInterval(() => { if (config.autoTrading) updateAllOBs(); }, 5 * 60 * 1000);
});

// WebSocket 서버
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  wsClients.push(ws);
  ws.send(JSON.stringify({ type: 'state', data: getPublicState() }));
  ws.send(JSON.stringify({ type: 'logs', data: logs.slice(0, 50) }));
});

log('24번트 — 업비트 오더블록 스캘핑 봇 초기화 완료');
