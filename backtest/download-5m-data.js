/**
 * 업비트 5분봉 데이터 대량 다운로드
 * 500원 이상 거래대금 상위 코인 대상, 최대한 많은 데이터 확보
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'candles-5m-ext');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse: ${d.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getTopCoins(minPrice = 500) {
  const markets = await fetchJSON('https://api.upbit.com/v1/market/all?is_details=true');
  const krw = markets.filter(m => m.market.startsWith('KRW-') && !['KRW-USDT'].includes(m.market)).map(m => m.market);

  const tickers = await fetchJSON('https://api.upbit.com/v1/ticker?markets=' + krw.join(','));
  return tickers
    .filter(t => t.trade_price >= minPrice)
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, 25) // 상위 25개
    .map(t => ({ market: t.market, coin: t.market.replace('KRW-', ''), price: t.trade_price }));
}

async function downloadCandles(market, count = 10000) {
  const candles = [];
  let to = null;
  const batchSize = 200;
  const batches = Math.ceil(count / batchSize);

  for (let i = 0; i < batches; i++) {
    let url = `https://api.upbit.com/v1/candles/minutes/5?market=${market}&count=${batchSize}`;
    if (to) url += `&to=${to}`;

    try {
      const data = await fetchJSON(url);
      if (!data || data.length === 0) break;

      for (const c of data) {
        candles.push({
          time: c.candle_date_time_kst,
          open: c.opening_price,
          high: c.high_price,
          low: c.low_price,
          close: c.trade_price,
          volume: c.candle_acc_trade_volume,
          value: c.candle_acc_trade_price,
        });
      }

      // 다음 배치를 위한 to 파라미터 (가장 오래된 캔들의 UTC 시간)
      to = data[data.length - 1].candle_date_time_utc;

      if (data.length < batchSize) break; // 더 이상 데이터 없음

      process.stdout.write(`\r  ${market}: ${candles.length}봉 다운로드 중...`);
      await sleep(120); // API rate limit
    } catch (e) {
      console.error(`\n  ${market} 에러: ${e.message}`);
      await sleep(500);
    }
  }

  // 시간순 정렬 (API는 최신순으로 반환)
  candles.sort((a, b) => a.time.localeCompare(b.time));
  return candles;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  업비트 5분봉 데이터 다운로드 (500원↑, 상위 25개)');
  console.log('═══════════════════════════════════════════════════\n');

  const coins = await getTopCoins(500);
  console.log(`대상 코인 ${coins.length}개:`);
  for (const c of coins) {
    console.log(`  ${c.coin.padEnd(8)} ${c.price.toLocaleString()}원`);
  }
  console.log('');

  for (const { market, coin, price } of coins) {
    const outFile = path.join(OUT_DIR, `${coin}.json`);

    // 10,000봉 = 약 35일 (5분 × 288봉/일)
    const candles = await downloadCandles(market, 10000);
    fs.writeFileSync(outFile, JSON.stringify(candles));

    const days = candles.length > 0
      ? ((new Date(candles[candles.length - 1].time) - new Date(candles[0].time)) / 86400000).toFixed(1)
      : 0;
    console.log(`\r  ${coin.padEnd(8)}: ${candles.length}봉 (${days}일) | ${candles[0]?.time?.slice(0, 10)} ~ ${candles[candles.length - 1]?.time?.slice(0, 10)}    `);
    await sleep(200);
  }

  console.log('\n다운로드 완료!');
}

main().catch(console.error);
