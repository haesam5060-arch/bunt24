/**
 * 포지션 분할 수 백테스트
 * 2분할 vs 3분할 vs 4분할 vs 5분할 비교
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m');
const COMMISSION = 0.0005;

const BASE = {
  impulseMinPct: 2, impulseLookback: 6, volumeAvgWindow: 20,
  obMaxAge: 24, slPct: 0.8, maxHoldCandles: 60, cooldownCandles: 6,
  initialCapital: 100000, minOrderAmount: 5000, minTpPct: 0.8,
};

function detectOB(data) {
  const obs = [];
  for (let i = BASE.volumeAvgWindow; i < data.length - BASE.impulseLookback; i++) {
    const c = data[i];
    if (c.close >= c.open) continue;
    let maxHigh = 0;
    for (let j = i + 1; j <= i + BASE.impulseLookback && j < data.length; j++) {
      if (data[j].high > maxHigh) maxHigh = data[j].high;
    }
    const imp = (maxHigh - c.close) / c.close * 100;
    if (imp < BASE.impulseMinPct) continue;
    obs.push({ index: i, top: c.open, bottom: c.close, swingHigh: maxHigh, used: false });
  }
  return obs;
}

function check1HTrend(data, idx) {
  if (idx < 72) return true;
  let maSum = 0;
  for (let j = idx - 72; j < idx; j++) maSum += data[j].close;
  const ma72 = maSum / 72;
  if (data[idx].close < ma72) return false;
  const h1 = Math.max(...data.slice(Math.max(idx-12,0), idx).map(c => c.high));
  const h2 = Math.max(...data.slice(Math.max(idx-24,0), idx-12).map(c => c.high));
  const h3 = Math.max(...data.slice(Math.max(idx-36,0), idx-24).map(c => c.high));
  if (h1 < h2 && h2 < h3) return false;
  return true;
}

function runTest(allData, maxPos) {
  const timeline = {};
  for (const { coin, data } of allData) {
    const obs = detectOB(data).map(o => ({ ...o, used: false }));
    const cooldowns = {};
    for (let i = 72; i < data.length; i++) {
      if (cooldowns[coin] && i < cooldowns[coin]) continue;
      const candle = data[i];
      for (const ob of obs) {
        if (ob.index >= i || i - ob.index > BASE.obMaxAge || ob.used) continue;
        if (!(candle.low <= ob.top && candle.close >= ob.bottom)) continue;
        const entry = Math.max(candle.close, ob.bottom);
        const sl = ob.bottom * (1 - BASE.slPct / 100);
        const tp = ob.swingHigh;
        if ((tp - entry) / entry * 100 < BASE.minTpPct) continue;
        if (!check1HTrend(data, i)) continue;
        let exitP = null, exitR = null, exitI = null;
        for (let j = i + 1; j < Math.min(i + BASE.maxHoldCandles, data.length); j++) {
          if (data[j].low <= sl) { exitP = sl; exitR = 'SL'; exitI = j; break; }
          if (data[j].high >= tp) { exitP = tp; exitR = 'TP'; exitI = j; break; }
        }
        if (!exitP) { exitI = Math.min(i + BASE.maxHoldCandles, data.length - 1); exitP = data[exitI].close; exitR = 'TIMEOUT'; }
        const key = candle.time;
        if (!timeline[key]) timeline[key] = [];
        timeline[key].push({ coin, entryIndex: i, exitIndex: exitI, entryTime: candle.time, exitTime: data[exitI].time, entryPrice: entry, exitPrice: exitP, reason: exitR, holdMinutes: (exitI - i) * 5 });
        ob.used = true;
        cooldowns[coin] = exitI + BASE.cooldownCandles;
        break;
      }
    }
  }

  let cash = BASE.initialCapital;
  const trades = [], events = [];
  for (const time of Object.keys(timeline).sort()) {
    for (const sig of timeline[time]) {
      events.push({ type: 'ENTRY', time: sig.entryTime, signal: sig });
      events.push({ type: 'EXIT', time: sig.exitTime, signal: sig });
    }
  }
  events.sort((a, b) => a.time !== b.time ? a.time.localeCompare(b.time) : a.type === 'EXIT' ? -1 : 1);
  const active = new Map();
  let missed = 0;
  for (const ev of events) {
    const s = ev.signal, key = s.coin + '_' + s.entryTime;
    if (ev.type === 'EXIT') {
      const pos = active.get(key); if (!pos) continue;
      const net = (s.exitPrice - s.entryPrice) / s.entryPrice - COMMISSION * 2;
      cash += pos.amount + pos.amount * net; active.delete(key);
      trades.push({ pnl: Math.round(pos.amount * net), netPct: +(net * 100).toFixed(3), reason: s.reason, holdMinutes: s.holdMinutes, coin: s.coin });
    }
    if (ev.type === 'ENTRY') {
      if ([...active.values()].some(p => p.coin === s.coin)) continue;
      if (active.size >= maxPos) { missed++; continue; }
      const alloc = Math.floor(cash * 0.995 / (maxPos - active.size));
      if (alloc < BASE.minOrderAmount) continue;
      cash -= alloc; active.set(key, { coin: s.coin, amount: alloc });
    }
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgEv = trades.length > 0 ? trades.reduce((s, t) => s + t.netPct, 0) / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const tp = trades.filter(t => t.reason === 'TP').length;
  const sl = trades.filter(t => t.reason === 'SL').length;
  const to = trades.filter(t => t.reason === 'TIMEOUT').length;
  const ret = (totalPnl / BASE.initialCapital * 100);
  let peak = BASE.initialCapital, mdd = 0, run = BASE.initialCapital;
  for (const t of trades) { run += t.pnl; if (run > peak) peak = run; const dd = (peak - run) / peak * 100; if (dd > mdd) mdd = dd; }
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0;
  const uniqueCoins = new Set(trades.map(t => t.coin)).size;

  return { total: trades.length, winRate: +(wins.length / trades.length * 100).toFixed(1),
    tp, sl, to, totalPnl, ret: +ret.toFixed(1), avgEv: +avgEv.toFixed(3),
    avgWin: +avgWin.toFixed(3), avgLoss: +avgLoss.toFixed(3), mdd: +mdd.toFixed(2),
    avgHold: +avgHold.toFixed(0), missed, uniqueCoins };
}

// 데이터 로드
const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !['BTC.json','ETH.json','USDT.json'].includes(f));
const allData = files.map(f => {
  const coin = f.replace('.json', '');
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
  const data = raw.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })).sort((a, b) => a.time.localeCompare(b.time));
  return data.length >= 100 ? { coin, data } : null;
}).filter(Boolean);

const SEP = '═'.repeat(100);
const LINE = '─'.repeat(94);

console.log('\n' + SEP);
console.log('  포지션 분할 수 백테스트 — 10만원 기준, swing TP, 1H 추세 필터');
console.log(SEP);
console.log('  코인: ' + allData.length + '개 | SL 0.8% | 최대보유 5시간\n');

console.log('  ' + '분할'.padEnd(8) + '투자단위'.padStart(10) + '거래'.padStart(6) + '승률'.padStart(7) + '  TP/SL/TO'.padStart(11) + '총수익'.padStart(12) + '수익률'.padStart(9) + ' EV/건'.padStart(8) + '  MDD'.padStart(8) + '미진입'.padStart(7) + '종목'.padStart(5));
console.log('  ' + LINE);

const results = [];
for (const maxPos of [1, 2, 3, 4, 5]) {
  const r = runTest(allData, maxPos);
  r.maxPos = maxPos;
  results.push(r);
  const unit = Math.floor(BASE.initialCapital / maxPos).toLocaleString() + '원';
  const best = r.avgEv === Math.max(...results.map(x => x.avgEv)) ? ' ⭐' : '';
  console.log('  ' + (maxPos + '분할').padEnd(8) + unit.padStart(10) + String(r.total).padStart(6) + (r.winRate+'%').padStart(7) + ('  '+r.tp+'/'+r.sl+'/'+r.to).padStart(11) + ((r.totalPnl>0?'+':'')+r.totalPnl.toLocaleString()).padStart(12) + ((r.ret>0?'+':'')+r.ret+'%').padStart(9) + ((r.avgEv>0?' +':' ')+r.avgEv+'%').padStart(8) + ('  -'+r.mdd+'%').padStart(8) + String(r.missed).padStart(7) + String(r.uniqueCoins).padStart(5) + best);
}

console.log('\n  💡 미진입 = 포지션이 꽉 차서 놓친 매매 기회');
console.log('  💡 투자단위 = 10만원을 N등분한 건당 투자금\n');

// 분석
const best = results.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
const cur = results.find(r => r.maxPos === 2);
console.log('  📊 분석:');
console.log('  ' + '─'.repeat(50));
console.log('  총수익 최고: ' + best.maxPos + '분할 (+' + best.totalPnl.toLocaleString() + '원)');
console.log('  현행 2분할: +' + cur.totalPnl.toLocaleString() + '원, ' + cur.missed + '건 놓침');
console.log('  4분할 대비: ' + (results.find(r=>r.maxPos===4).totalPnl > cur.totalPnl ? '4분할이 유리' : '2분할이 유리'));
console.log(SEP + '\n');
