/**
 * 업비트 API 서비스
 * - REST API: 주문, 잔고, 캔들 조회
 * - WebSocket: 실시간 체결가 수신
 */

const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// ── JWT 토큰 생성 ─────────────────────────────────
function createToken(accessKey, secretKey, query = null) {
  const payload = {
    access_key: accessKey,
    nonce: uuidv4(),
  };

  if (query) {
    const queryString = new URLSearchParams(query).toString();
    const hash = crypto.createHash('sha512').update(queryString, 'utf-8').digest('hex');
    payload.query_hash = hash;
    payload.query_hash_alg = 'SHA512';
  }

  return jwt.sign(payload, secretKey);
}

// ── HTTP 요청 ─────────────────────────────────────
function request(method, path, accessKey, secretKey, query = null, body = null) {
  return new Promise((resolve, reject) => {
    const token = createToken(accessKey, secretKey, query || body);
    let url = `https://api.upbit.com${path}`;
    if (query) url += '?' + new URLSearchParams(query).toString();

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.error?.message || `HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── 공개 API (인증 불필요) ────────────────────────
function publicGet(path) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.upbit.com${path}`, { headers: { accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// ── 계좌 조회 ─────────────────────────────────────
async function getAccounts(accessKey, secretKey) {
  return request('GET', '/v1/accounts', accessKey, secretKey);
}

// ── 잔고 (KRW) ────────────────────────────────────
async function getBalance(accessKey, secretKey) {
  const accounts = await getAccounts(accessKey, secretKey);
  const krw = accounts.find(a => a.currency === 'KRW');
  return krw ? parseFloat(krw.balance) : 0;
}

// ── 보유 코인 조회 ────────────────────────────────
async function getHoldings(accessKey, secretKey) {
  const accounts = await getAccounts(accessKey, secretKey);
  return accounts
    .filter(a => a.currency !== 'KRW' && parseFloat(a.balance) > 0)
    .map(a => ({
      currency: a.currency,
      market: `KRW-${a.currency}`,
      balance: parseFloat(a.balance),
      avgBuyPrice: parseFloat(a.avg_buy_price),
    }));
}

// ── 시장가 매수 (금액 기준) ───────────────────────
async function buyMarket(accessKey, secretKey, market, amount) {
  const body = {
    market,
    side: 'bid',
    price: String(Math.floor(amount)),
    ord_type: 'price', // 시장가 매수 (금액 지정)
  };
  return request('POST', '/v1/orders', accessKey, secretKey, null, body);
}

// ── 시장가 매도 (수량 기준) ───────────────────────
async function sellMarket(accessKey, secretKey, market, volume) {
  const body = {
    market,
    side: 'ask',
    volume: String(volume),
    ord_type: 'market', // 시장가 매도 (수량 지정)
  };
  return request('POST', '/v1/orders', accessKey, secretKey, null, body);
}

// ── 주문 조회 ─────────────────────────────────────
async function getOrder(accessKey, secretKey, uuid) {
  return request('GET', '/v1/order', accessKey, secretKey, { uuid });
}

// ── 캔들 조회 (5분봉) ─────────────────────────────
async function getCandles(market, minutes = 5, count = 200) {
  return publicGet(`/v1/candles/minutes/${minutes}?market=${market}&count=${count}`);
}

// ── 거래대금 상위 코인 조회 ───────────────────────
async function getTopMarkets(limit = 20) {
  const markets = await publicGet('/v1/market/all?is_details=true');
  const krwMarkets = markets
    .filter(m => m.market.startsWith('KRW-') && !['KRW-BTC', 'KRW-USDT'].includes(m.market))
    .map(m => m.market);

  const tickers = await publicGet('/v1/ticker?markets=' + krwMarkets.join(','));
  tickers.sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);

  return tickers.slice(0, limit).map(t => ({
    market: t.market,
    coin: t.market.replace('KRW-', ''),
    price: t.trade_price,
    volume24h: t.acc_trade_price_24h,
    changeRate: t.signed_change_rate,
  }));
}

// ── 현재가 조회 ───────────────────────────────────
async function getTicker(market) {
  const data = await publicGet(`/v1/ticker?markets=${market}`);
  return data[0];
}

module.exports = {
  getAccounts,
  getBalance,
  getHoldings,
  buyMarket,
  sellMarket,
  getOrder,
  getCandles,
  getTopMarkets,
  getTicker,
};
