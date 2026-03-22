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
    cash: 100000,          // 가용 현금
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

// ── 로깅 ──────────────────────────────────────────
const logs = [];
function log(msg, level = 'info') {
  const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const entry = { time, level, msg };
  logs.unshift(entry);
  if (logs.length > 500) logs.length = 500;
  const icon = { info: '📋', warn: '⚠️', error: '❌', trade: '💰' }[level] || '📋';
  console.log(`[${time}] ${icon} ${msg}`);

  // WebSocket으로 대시보드에 전송
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
const latestPrices = {}; // { 'KRW-ANKR': 530, ... }

function connectUpbitWebSocket(markets) {
  if (upbitWs) { try { upbitWs.close(); } catch {} }
  if (!markets || markets.length === 0) return;

  upbitWs = new WebSocket('wss://api.upbit.com/websocket/v1');

  upbitWs.on('open', () => {
    log(`업비트 WebSocket 연결 (${markets.length}개 코인 실시간 감시)`);
    const msg = JSON.stringify([
      { ticket: 'scalper-' + Date.now() },
      { type: 'ticker', codes: markets, isOnlyRealtime: true },
    ]);
    upbitWs.send(msg);
  });

  upbitWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'ticker') {
        const market = parsed.code;
        const price = parsed.trade_price;
        latestPrices[market] = price;

        // 실시간 OB 터치 체크 + 포지션 TP/SL 체크
        if (config.autoTrading) {
          checkEntrySignal(market, price);
          checkExitSignal(market, price);
        }
      }
    } catch {}
  });

  upbitWs.on('close', () => {
    log('업비트 WebSocket 연결 끊김 — 5초 후 재연결', 'warn');
    setTimeout(() => connectUpbitWebSocket(markets), 5000);
  });

  upbitWs.on('error', (e) => {
    log(`업비트 WebSocket 에러: ${e.message}`, 'error');
  });
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

    // WebSocket 재연결 (새 종목 리스트로)
    connectUpbitWebSocket(markets);

    // 각 코인 OB 업데이트
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

      // 최근 것만 유지 (obMaxAge 이내)
      const activeOBs = obs.filter(o => !o.used && !o.broken)
        .slice(-10); // 최대 10개

      state.orderBlocks[item.coin] = activeOBs;

      if (activeOBs.length > 0) {
        log(`${item.coin}: ${activeOBs.length}개 OB 활성 (최근: ${activeOBs[activeOBs.length - 1].top.toLocaleString()}~${activeOBs[activeOBs.length - 1].bottom.toLocaleString()}원)`);
      }

      await sleep(200); // rate limit
    } catch (e) {
      log(`${item.coin} OB 업데이트 에러: ${e.message}`, 'error');
    }
  }

  saveState(state);
  broadcastToClients({ type: 'state', data: getPublicState() });
}

// ── 진입 시그널 체크 (실시간) ─────────────────────
async function checkEntrySignal(market, price) {
  const coin = market.replace('KRW-', '');
  const strat = config.strategy;

  // 시간대 필터
  if (strat.excludeHours && strat.excludeHours.length > 0) {
    const hour = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false });
    if (strat.excludeHours.includes(parseInt(hour))) return;
  }

  // 최대 포지션 수 체크
  if (state.positions.length >= strat.maxPositions) return;

  // 같은 코인 이미 보유 중이면 스킵
  if (state.positions.some(p => p.coin === coin)) return;

  // 활성 OB 확인
  const activeOBs = state.orderBlocks[coin];
  if (!activeOBs || activeOBs.length === 0) return;

  // OB 터치 확인
  const touchedOB = ob.checkOBTouch(activeOBs, price);
  if (!touchedOB) return;

  // 가용 자금 계산
  const availSlots = strat.maxPositions - state.positions.length;
  const allocAmount = Math.floor(state.cash / availSlots);
  if (allocAmount < strat.minOrderAmount) return;

  // 진입/익절/손절 가격
  const prices = ob.calcEntryExitPrices(touchedOB, price, strat);

  log(`🎯 ${coin} OB 터치! 현재가 ${price.toLocaleString()}원 (OB: ${touchedOB.bottom.toLocaleString()}~${touchedOB.top.toLocaleString()})`, 'trade');

  try {
    // 매수 실행
    const result = await upbit.buyMarket(
      config.upbit.accessKey, config.upbit.secretKey,
      market, allocAmount
    );

    touchedOB.used = true;

    const position = {
      coin,
      market,
      entryPrice: price,
      tpPrice: prices.tpPrice,
      slPrice: prices.slPrice,
      amount: allocAmount,
      orderId: result.uuid,
      entryTime: new Date().toISOString(),
      obImpulse: touchedOB.impulsePct,
    };

    state.positions.push(position);
    state.cash -= allocAmount;
    saveState(state);

    log(`✅ ${coin} 매수 완료: ${price.toLocaleString()}원 × ${allocAmount.toLocaleString()}원 | TP: ${prices.tpPrice.toLocaleString()} SL: ${prices.slPrice.toLocaleString()}`, 'trade');

    appendTradeLog({
      action: 'BUY',
      coin, market,
      price, amount: allocAmount,
      tpPrice: prices.tpPrice,
      slPrice: prices.slPrice,
    });

    broadcastToClients({ type: 'state', data: getPublicState() });
  } catch (e) {
    log(`❌ ${coin} 매수 실패: ${e.message}`, 'error');
  }
}

// ── 청산 시그널 체크 (실시간) ─────────────────────
async function checkExitSignal(market, price) {
  const coin = market.replace('KRW-', '');
  const pos = state.positions.find(p => p.coin === coin);
  if (!pos) return;

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

    const pnl = (price - pos.entryPrice) / pos.entryPrice * pos.amount;
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;
    const holdMinutes = Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000);

    const icon = exitReason === 'TP' ? '🟢' : exitReason === 'SL' ? '🔴' : '🟡';
    log(`${icon} ${coin} ${exitReason} 매도: ${pos.entryPrice.toLocaleString()} → ${price.toLocaleString()}원 (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%, ${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원, ${holdMinutes}분)`, 'trade');

    // 상태 업데이트
    state.positions = state.positions.filter(p => p.coin !== coin);
    state.cash += pos.amount + pnl;
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

    appendTradeLog({
      action: 'SELL',
      coin, market, reason: exitReason,
      entryPrice: pos.entryPrice, exitPrice: price,
      amount: pos.amount, pnl: Math.round(pnl),
      pnlPct: +pnlPct.toFixed(2),
      holdMinutes,
    });

    broadcastToClients({ type: 'state', data: getPublicState() });
  } catch (e) {
    log(`❌ ${coin} 매도 실패: ${e.message}`, 'error');
  }
}

// ── 유틸 ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getPublicState() {
  return {
    cash: Math.round(state.cash),
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

// API 엔드포인트
app.get('/api/state', (req, res) => res.json(getPublicState()));
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
  broadcastToClients({ type: 'state', data: getPublicState() });
  res.json({ autoTrading: config.autoTrading });
});

app.post('/api/force-scan', async (req, res) => {
  await scanTopCoins();
  res.json({ ok: true });
});

app.post('/api/sell-all', async (req, res) => {
  log('수동 전체 매도 요청', 'warn');
  for (const pos of [...state.positions]) {
    const price = latestPrices[pos.market] || pos.entryPrice;
    await checkExitSignal(pos.market, price - 999999); // force SL
    await sleep(300);
  }
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
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

  // 초기 스캔
  await scanTopCoins();

  // 1시간마다 종목 재스캔
  setInterval(scanTopCoins, 60 * 60 * 1000);

  // 5분마다 OB 업데이트
  setInterval(updateAllOBs, 5 * 60 * 1000);
});

// WebSocket 서버
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  wsClients.push(ws);
  ws.send(JSON.stringify({ type: 'state', data: getPublicState() }));
  ws.send(JSON.stringify({ type: 'logs', data: logs.slice(0, 50) }));
});

log('24번트 — 업비트 오더블록 스캘핑 봇 초기화 완료');
