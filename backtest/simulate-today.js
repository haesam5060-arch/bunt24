/**
 * 오늘(3/24) 실적을 N시나리오(5M 기본)로 돌렸으면 어떻게 됐는지 시뮬레이션
 * 1분봉 데이터를 5분봉으로 합성하여 사용
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-1m');
const COMMISSION = 0.0005;
const MIN_PRICE = 500;

// ── 1분봉 → 5분봉 합성 ──
function aggregate1mTo5m(data1m) {
  const grouped = {};
  for (const c of data1m) {
    // 5분 단위로 그룹핑
    const d = new Date(c.time);
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
    const key = d.toISOString().replace('Z', '').slice(0, 19);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  }

  const result = [];
  for (const [time, candles] of Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))) {
    if (candles.length < 3) continue; // 불완전 봉 제외
    result.push({
      time,
      open: candles[0].open,
      high: Math.max(...candles.map(c => c.high)),
      low: Math.min(...candles.map(c => c.low)),
      close: candles[candles.length - 1].close,
      volume: candles.reduce((s, c) => s + c.volume, 0),
      value: candles.reduce((s, c) => s + (c.value || 0), 0),
    });
  }
  return result;
}

// ── 데이터 로드 ──
function loadAllData() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const allData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const raw1m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    if (raw1m.length < 500) continue;
    const avgPrice = raw1m.slice(-200).reduce((s, c) => s + c.close, 0) / 200;
    if (avgPrice < MIN_PRICE) continue;
    const data5m = aggregate1mTo5m(raw1m);
    allData.push({ coin, data: data5m });
  }
  return allData;
}

// ── OB 감지 ──
function detectOB(data, cfg) {
  const obs = [];
  for (let i = cfg.volumeAvgWindow; i < data.length - cfg.impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue;
    if (cfg.volumeMultiplier > 1) {
      let volSum = 0;
      for (let j = i - cfg.volumeAvgWindow; j < i; j++) volSum += data[j].volume;
      const avgVol = volSum / cfg.volumeAvgWindow;
      if (c.volume < avgVol * cfg.volumeMultiplier) continue;
    }
    let maxHigh = 0;
    for (let j = i + 1; j <= i + cfg.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHigh) maxHigh = data[j].high;
    }
    const imp = (maxHigh - c.close) / c.close * 100;
    if (imp < cfg.impulseMinPct) continue;
    obs.push({ index: i, top: c.open, bottom: c.close, swingHigh: maxHigh, impulsePct: imp, used: false });
  }
  return obs;
}

// ── 백테스트 ──
function runBacktest(allData, cfg) {
  const events = [];
  for (const { coin, data } of allData) {
    const obs = detectOB(data, cfg);
    for (let i = 0; i < data.length; i++) {
      events.push({ time: data[i].time, coin, idx: i, candle: data[i], obs });
    }
  }
  events.sort((a, b) => a.time.localeCompare(b.time));

  const positions = [];
  const trades = [];
  let cash = cfg.initialCapital;
  const cooldowns = {};
  const usedOBs = new Set();

  for (const ev of events) {
    const { coin, idx, candle, obs } = ev;
    const price = candle.close;

    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      if (pos.coin !== coin) continue;
      const holdBars = idx - pos.entryIdx;
      if (candle.high > pos.highSinceEntry) pos.highSinceEntry = candle.high;

      let exitReason = null, exitPrice = price;

      if (candle.high >= pos.tpPrice) { exitReason = 'TP'; exitPrice = pos.tpPrice; }
      if (!exitReason && cfg.trailActivatePct > 0) {
        const gain = (pos.highSinceEntry - pos.entryPrice) / pos.entryPrice * 100;
        if (gain >= cfg.trailActivatePct) {
          const trailStop = pos.highSinceEntry * (1 - cfg.trailPct / 100);
          if (candle.low <= trailStop) { exitReason = 'TRAIL'; exitPrice = trailStop; }
        }
      }
      if (!exitReason && candle.low <= pos.slPrice) { exitReason = 'SL'; exitPrice = pos.slPrice; }
      if (!exitReason && holdBars >= cfg.maxHoldBars) { exitReason = 'TIMEOUT'; exitPrice = price; }

      if (exitReason) {
        const netExit = exitPrice * (1 - COMMISSION);
        const pnl = (netExit - pos.entryPrice) / pos.entryPrice * pos.amount;
        const pnlPct = (netExit - pos.entryPrice) / pos.entryPrice * 100;
        cash += pos.amount + pnl;
        trades.push({
          coin, entryPrice: pos.entryPrice, exitPrice, reason: exitReason,
          pnl, pnlPct, holdBars, time: candle.time, entryTime: pos.entryTime,
        });
        positions.splice(pi, 1);
        cooldowns[coin] = idx + cfg.cooldownBars;
      }
    }

    if (positions.length >= cfg.maxPositions) continue;
    if (positions.some(p => p.coin === coin)) continue;
    if (cooldowns[coin] && idx < cooldowns[coin]) continue;

    const maxAgeIdx = idx - cfg.obMaxAge;
    const activeOBs = obs.filter(o =>
      !o.used && !usedOBs.has(`${coin}_${o.index}`) &&
      o.index >= maxAgeIdx && o.index < idx
    );

    for (const ob of activeOBs) {
      if (price <= ob.top && price >= ob.bottom) {
        const tpPrice = Math.max(ob.swingHigh, price * (1 + cfg.minTpPct / 100));
        const expectedPct = (tpPrice - price) / price * 100;
        if (expectedPct < cfg.minTpPct) continue;

        const availSlots = cfg.maxPositions - positions.length;
        const allocAmount = Math.floor(cash * 0.995 / availSlots);
        if (allocAmount < cfg.minOrderAmount) continue;

        const entryPrice = price * (1 + COMMISSION);
        const slPrice = ob.bottom * (1 - cfg.slPct / 100);

        positions.push({
          coin, entryPrice, tpPrice, slPrice,
          amount: allocAmount, entryIdx: idx, highSinceEntry: candle.high,
          entryTime: candle.time,
        });
        cash -= allocAmount;
        usedOBs.add(`${coin}_${ob.index}`);
        cooldowns[coin] = idx + cfg.cooldownBars;
        break;
      }
    }
  }

  return { trades, positions, cash };
}

// ═══ 실행 ═══
const allData = loadAllData();
console.log('═══════════════════════════════════════════════════════════════');
console.log('  오늘(3/24) N시나리오 시뮬레이션');
console.log('  5분봉(1분봉 합성) | 500원↑ | imp1.5% | SL1% | TP2% | trail1.5/0.5%');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`\n코인: ${allData.map(d => `${d.coin}(${d.data.length}봉)`).join(', ')}\n`);

const cfg = {
  impulseMinPct: 1.5, impulseLookback: 6, volumeAvgWindow: 20, volumeMultiplier: 1.5,
  obMaxAge: 48, slPct: 1.0, maxHoldBars: 36, cooldownBars: 3,
  maxPositions: 2, initialCapital: 100000, minOrderAmount: 5000,
  minTpPct: 2.0, trailActivatePct: 1.5, trailPct: 0.5,
};

const { trades, positions, cash } = runBacktest(allData, cfg);

// 오늘 거래만 필터
const todayTrades = trades.filter(t => t.time && t.time.startsWith('2026-03-24'));
const allClosed = trades.filter(t => t.time);

console.log(`전체 거래: ${allClosed.length}건`);
console.log(`오늘(3/24) 거래: ${todayTrades.length}건\n`);

// 전체 기간 일별 요약
const daily = {};
for (const t of allClosed) {
  const date = t.time.slice(0, 10);
  if (!daily[date]) daily[date] = { pnl: 0, trades: 0, wins: 0, details: [] };
  daily[date].pnl += t.pnl;
  daily[date].trades++;
  if (t.pnl > 0) daily[date].wins++;
  daily[date].details.push(t);
}

console.log('── 일별 요약 ──');
let totalPnl = 0;
for (const [date, d] of Object.entries(daily).sort(([a], [b]) => a.localeCompare(b))) {
  totalPnl += d.pnl;
  const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(0) : 0;
  const marker = date === '2026-03-24' ? ' ← 오늘' : '';
  console.log(`  ${date}: ${d.pnl > 0 ? '+' : ''}${Math.round(d.pnl).toLocaleString().padStart(7)}원 (${d.trades}건, 승률${wr}%) | 누적: ${totalPnl > 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}원${marker}`);
}

// 오늘 상세
if (todayTrades.length > 0) {
  console.log('\n── 오늘(3/24) 거래 상세 ──');
  for (const t of todayTrades) {
    const icon = t.reason === 'TP' ? '🟢' : t.reason === 'TRAIL' ? '🔵' : t.reason === 'SL' ? '🔴' : '🟡';
    const entryTime = t.entryTime ? t.entryTime.split('T')[1]?.slice(0, 5) : '??';
    const exitTime = t.time.split('T')[1]?.slice(0, 5) || '??';
    console.log(`  ${icon} ${t.coin.padEnd(5)} | ${entryTime}→${exitTime} | ${t.reason.padEnd(7)} | ` +
      `${Math.round(t.entryPrice).toLocaleString()}→${Math.round(t.exitPrice).toLocaleString()}원 | ` +
      `${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(2)}% | ` +
      `${t.pnl > 0 ? '+' : ''}${Math.round(t.pnl).toLocaleString()}원 | ${t.holdBars * 5}분`);
  }
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
  const todayWins = todayTrades.filter(t => t.pnl > 0).length;
  console.log(`\n  오늘 합계: ${todayPnl > 0 ? '+' : ''}${Math.round(todayPnl).toLocaleString()}원 (${todayTrades.length}건, ${todayWins}승${todayTrades.length - todayWins}패)`);
} else {
  console.log('\n오늘(3/24) 거래 없음 — 조건을 충족하는 OB 터치가 없었음');
}

// 현재 설정 vs N시나리오 비교
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  실제 실적 vs N시나리오 비교 (3/24)');
console.log('═══════════════════════════════════════════════════════════════');
const todayPnlN = todayTrades.reduce((s, t) => s + t.pnl, 0);
console.log(`  실제 실적 (1M 현재설정): -4,922원 (56건, 승률 25%)`);
console.log(`  N시나리오 (5M 기본):     ${todayPnlN > 0 ? '+' : ''}${Math.round(todayPnlN).toLocaleString()}원 (${todayTrades.length}건, 승률 ${todayTrades.length > 0 ? (todayTrades.filter(t=>t.pnl>0).length/todayTrades.length*100).toFixed(0) : 0}%)`);
console.log(`  차이:                    ${Math.round(todayPnlN - (-4922)) > 0 ? '+' : ''}${Math.round(todayPnlN - (-4922)).toLocaleString()}원`);
