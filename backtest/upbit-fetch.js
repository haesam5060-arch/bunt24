/**
 * 업비트 5분봉 OHLCV 데이터 수집
 * - 거래량 상위 원화마켓 알트코인 자동 선별
 * - 최근 7일 5분봉 수집 (약 2,016개 캔들/종목)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTopMarkets(limit = 20) {
  // 원화마켓 전체 조회
  const markets = await fetch('https://api.upbit.com/v1/market/all?is_details=true');
  const krwMarkets = markets.filter(m => m.market.startsWith('KRW-') && m.market !== 'KRW-BTC');

  // 24시간 거래대금 기준 정렬
  const tickers = await fetch('https://api.upbit.com/v1/ticker?markets=' + krwMarkets.map(m => m.market).join(','));
  tickers.sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);

  const top = tickers.slice(0, limit);
  console.log(`\n거래대금 상위 ${limit}개 원화 알트코인:`);
  top.forEach((t, i) => {
    const vol = (t.acc_trade_price_24h / 1e8).toFixed(0);
    const chg = (t.signed_change_rate * 100).toFixed(2);
    console.log(`  ${i + 1}. ${t.market.padEnd(12)} 거래대금 ${vol}억  변동 ${chg}%`);
  });

  return top.map(t => t.market);
}

async function fetchCandles(market, minutes = 5, totalCount = 2000) {
  const allCandles = [];
  let to = '';
  const batchSize = 200; // 업비트 최대 200개

  while (allCandles.length < totalCount) {
    let url = `https://api.upbit.com/v1/candles/minutes/${minutes}?market=${market}&count=${batchSize}`;
    if (to) url += `&to=${to}`;

    const candles = await fetch(url);
    if (!candles || candles.length === 0) break;

    allCandles.push(...candles);
    to = candles[candles.length - 1].candle_date_time_utc + 'Z';

    await sleep(150); // rate limit
  }

  // 시간순 정렬 (오래된 것 먼저)
  allCandles.sort((a, b) => new Date(a.candle_date_time_kst) - new Date(b.candle_date_time_kst));

  return allCandles.map(c => ({
    time: c.candle_date_time_kst,
    open: c.opening_price,
    high: c.high_price,
    low: c.low_price,
    close: c.trade_price,
    volume: c.candle_acc_trade_volume,
    value: c.candle_acc_trade_price
  }));
}

async function main() {
  console.log('=== 업비트 5분봉 데이터 수집 시작 ===\n');

  const markets = await getTopMarkets(20);
  // BTC도 추세 판단용으로 추가
  const allMarkets = ['KRW-BTC', ...markets];

  let saved = 0;
  for (let i = 0; i < allMarkets.length; i++) {
    const market = allMarkets[i];
    const coin = market.replace('KRW-', '');

    try {
      process.stdout.write(`[${i + 1}/${allMarkets.length}] ${market} 수집 중...`);
      const candles = await fetchCandles(market, 5, 2000);

      const filePath = path.join(DATA_DIR, `${coin}.json`);
      fs.writeFileSync(filePath, JSON.stringify(candles, null, 2));
      console.log(` ✅ ${candles.length}개 캔들 저장`);
      saved++;

      await sleep(300);
    } catch (e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  console.log(`\n=== 완료: ${saved}/${allMarkets.length}개 저장 (${DATA_DIR}) ===`);
}

main().catch(console.error);
