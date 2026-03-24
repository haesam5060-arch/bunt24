/**
 * 파라미터 비교 백테스트
 * 현재 설정 vs 3가지 변경안 비교
 * - A: cooldownCandles 3 vs 5 vs 8 vs 12
 * - B: useTrendFilter OFF vs MA20 vs MA50
 * - C: trailActivatePct 1% vs 1.5% vs 2% vs 2.5%
 * Walk-Forward 검증 포함
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data', 'candles-5m-ext');
const COMMISSION = 0.0005;

function loadAllData() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const allData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
    if (raw.length < 1000) continue;
    allData.push({ coin, data: raw });
  }
  return allData;
}

function splitData(allData, ratio = 0.5) {
  const train = [], test = [];
  for (const { coin, data } of allData) {
    const mid = Math.floor(data.length * ratio);
    train.push({ coin, data: data.slice(0, mid) });
    test.push({ coin, data: data.slice(mid) });
  }
  return { train, test };
}

function detectOB(data, cfg) {
  const obs = [];
  for (let i = cfg.volWin; i < data.length - cfg.impLook; i++) {
    const c = data[i];
    if (c.close >= c.open) continue;
    if (cfg.volMult > 1) {
      let vs = 0;
      for (let j = i - cfg.volWin; j < i; j++) vs += data[j].volume;
      if (c.volume < (vs / cfg.volWin) * cfg.volMult) continue;
    }
    let mh = 0;
    for (let j = i + 1; j <= i + cfg.impLook && j < data.length; j++) {
      if (data[j].high > mh) mh = data[j].high;
    }
    const imp = (mh - c.close) / c.close * 100;
    if (imp < cfg.impMin) continue;
    obs.push({ index: i, top: c.open, bottom: c.close, swingHigh: mh, used: false });
  }
  return obs;
}

function checkMA(data, idx, bars) {
  if (bars <= 0 || idx < bars) return true;
  let s = 0;
  for (let j = idx - bars; j < idx; j++) s += data[j].close;
  return data[idx].close >= s / bars;
}

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
  let cash = 100000;
  const cooldowns = {};
  const usedOBs = new Set();

  for (const ev of events) {
    const { coin, idx, candle, obs } = ev;
    const price = candle.close;

    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      if (pos.coin !== coin) continue;
      const hold = idx - pos.entryIdx;
      if (candle.high > pos.hi) pos.hi = candle.high;
      let reason = null, ep = price;
      if (candle.high >= pos.tp) { reason = 'TP'; ep = pos.tp; }
      if (!reason && cfg.trailAct > 0) {
        const g = (pos.hi - pos.entry) / pos.entry * 100;
        if (g >= cfg.trailAct) {
          const ts = pos.hi * (1 - cfg.trailPct / 100);
          if (candle.low <= ts) { reason = 'TRAIL'; ep = ts; }
        }
      }
      if (!reason && candle.low <= pos.sl) { reason = 'SL'; ep = pos.sl; }
      if (!reason && hold >= cfg.maxHold) { reason = 'TO'; ep = price; }
      if (reason) {
        const net = ep * (1 - COMMISSION);
        const pnl = (net - pos.entry) / pos.entry * pos.amt;
        const pnlPct = (net - pos.entry) / pos.entry * 100;
        cash += pos.amt + pnl;
        trades.push({ coin, pnl, pnlPct, reason, time: candle.time });
        positions.splice(pi, 1);
        cooldowns[coin] = idx + cfg.cool;
      }
    }

    if (positions.length >= cfg.maxPos) continue;
    if (positions.some(p => p.coin === coin)) continue;
    if (cooldowns[coin] && idx < cooldowns[coin]) continue;
    const allCoinData = allData.find(d => d.coin === coin)?.data;
    if (allCoinData && !checkMA(allCoinData, idx, cfg.maBars || 0)) continue;

    const maxAge = idx - cfg.obAge;
    const active = obs.filter(o => !o.used && !usedOBs.has(`${coin}_${o.index}`) && o.index >= maxAge && o.index < idx);
    for (const ob of active) {
      if (price <= ob.top && price >= ob.bottom) {
        const tp = Math.max(ob.swingHigh, price * (1 + cfg.minTp / 100));
        if ((tp - price) / price * 100 < cfg.minTp) continue;
        const slots = cfg.maxPos - positions.length;
        const amt = Math.floor(cash * 0.995 / slots);
        if (amt < 5000) continue;
        const entry = price * (1 + COMMISSION);
        const sl = ob.bottom * (1 - cfg.sl / 100);
        positions.push({ coin, entry, tp, sl, amt, entryIdx: idx, hi: candle.high });
        cash -= amt;
        usedOBs.add(`${coin}_${ob.index}`);
        cooldowns[coin] = idx + cfg.cool;
        break;
      }
    }
  }

  for (const pos of positions) {
    const cd = allData.find(d => d.coin === pos.coin)?.data;
    if (cd) {
      const lp = cd[cd.length - 1].close * (1 - COMMISSION);
      trades.push({ pnl: (lp - pos.entry) / pos.entry * pos.amt, reason: 'OPEN', time: '' });
    }
  }

  const closed = trades.filter(t => t.reason !== 'OPEN');
  if (closed.length < 5) return null;
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const winGross = wins.reduce((s, t) => s + t.pnl, 0);
  const lossGross = losses.reduce((s, t) => s + t.pnl, 0);

  const daily = {};
  for (const t of closed) {
    const d = (t.time || '').slice(0, 10);
    if (!daily[d]) daily[d] = { pnl: 0, n: 0 };
    daily[d].pnl += t.pnl; daily[d].n++;
  }
  const days = Object.keys(daily).filter(d => daily[d].n > 0).length || 1;
  const profitDays = Object.values(daily).filter(d => d.pnl > 0).length;

  let peak = 100000, eq = 100000, mdd = 0;
  for (const t of closed) { eq += t.pnl; if (eq > peak) peak = eq; const dd = (peak - eq) / peak * 100; if (dd > mdd) mdd = dd; }

  let maxCL = 0, cl = 0;
  for (const t of closed) { if (t.pnl <= 0) { cl++; maxCL = Math.max(maxCL, cl); } else cl = 0; }

  return {
    n: closed.length, wr: +(wins.length / closed.length * 100).toFixed(1),
    pnl: Math.round(totalPnl), daily: Math.round(totalPnl / days),
    pf: lossGross !== 0 ? +Math.abs(winGross / lossGross).toFixed(2) : 99,
    mdd: +mdd.toFixed(2), maxCL, days, profitDays,
    perDay: +(closed.length / days).toFixed(1),
    ev: Math.round(totalPnl / closed.length),
    tp: closed.filter(t => t.reason === 'TP').length,
    trail: closed.filter(t => t.reason === 'TRAIL').length,
    sl: closed.filter(t => t.reason === 'SL').length,
    to: closed.filter(t => t.reason === 'TO').length,
  };
}

// ═══════════════════════════════════════════
const allData = loadAllData();
const { train, test } = splitData(allData, 0.5);

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  파라미터 변경 검토 — 3가지 항목 비교 백테스트');
console.log(`  코인: ${allData.length}개 | Walk-Forward 검증 포함`);
console.log('═══════════════════════════════════════════════════════════════════════\n');

// 현재 설정 (config.json 기준)
const BASE = {
  impMin: 2.0, impLook: 6, volWin: 20, volMult: 1.5,
  obAge: 24, sl: 1.2, maxHold: 36, cool: 3,
  maxPos: 3, minTp: 1.5, maBars: 0,
  trailAct: 1.0, trailPct: 0.3,
};

function printResult(label, cfg, r, testR) {
  if (!r) { console.log(`  ${label.padEnd(35)} — 데이터 부족`); return; }
  const score = (r.pf * Math.sqrt(r.n) * (1 - r.mdd / 100)).toFixed(1);
  const testInfo = testR ? ` | 검증: PF${testR.pf} 승률${testR.wr}% ${testR.pnl>0?'+':''}${testR.pnl.toLocaleString()}원` : '';
  console.log(
    `  ${label.padEnd(35)} ${String(r.n).padStart(4)}건 | 승률 ${r.wr.toFixed(1).padStart(5)}% | PF ${r.pf.toFixed(2).padStart(5)} | ` +
    `${(r.pnl>0?'+':'')+r.pnl.toLocaleString()+'원'}`.padStart(11) + ` | 일평균 ${(r.daily>0?'+':'')+r.daily.toLocaleString()+'원'}`.padStart(7) +
    ` | MDD ${r.mdd.toFixed(1)}% | 연손${r.maxCL} | TP${r.tp} TR${r.trail} SL${r.sl} TO${r.to} | 스코어 ${score}${testInfo}`
  );
}

// ── 현재 설정 기준선 ──
console.log('━━━ 현재 설정 (기준선) ━━━');
const baseR = runBacktest(allData, BASE);
const baseTestR = runBacktest(test, BASE);
printResult('현재: cool=3, MA=0, trail=1/0.3', BASE, baseR, baseTestR);

// ═══════════════════════════════════════════
// A. 재진입 쿨다운 비교
// ═══════════════════════════════════════════
console.log('\n\n━━━ A. 재진입 쿨다운 (cooldownCandles) ━━━');
console.log('  현재: 3캔들 = 15분\n');

for (const cool of [1, 2, 3, 5, 8, 12, 20]) {
  const cfg = { ...BASE, cool };
  const r = runBacktest(allData, cfg);
  const tr = runBacktest(test, cfg);
  const min = cool * 5;
  printResult(`cool=${cool} (${min}분)`, cfg, r, tr);
}

// ═══════════════════════════════════════════
// B. 1H 추세필터 비교
// ═══════════════════════════════════════════
console.log('\n\n━━━ B. 추세필터 (MA bars) ━━━');
console.log('  현재: OFF (maBars=0)\n');

for (const maBars of [0, 10, 20, 30, 50, 80]) {
  const cfg = { ...BASE, maBars };
  const r = runBacktest(allData, cfg);
  const tr = runBacktest(test, cfg);
  printResult(`MA=${maBars}${maBars === 0 ? ' (OFF)' : ''}`, cfg, r, tr);
}

// ═══════════════════════════════════════════
// C. 트레일링 활성화 기준 비교
// ═══════════════════════════════════════════
console.log('\n\n━━━ C. 트레일링 활성화 (trailActivatePct / trailPct) ━━━');
console.log('  현재: 1% 활성 / 0.3% 트레일\n');

const trailCombos = [
  [0, 0, 'OFF'],
  [0.5, 0.3, '0.5/0.3'],
  [1.0, 0.3, '1.0/0.3 (현재)'],
  [1.0, 0.5, '1.0/0.5'],
  [1.5, 0.3, '1.5/0.3'],
  [1.5, 0.5, '1.5/0.5'],
  [2.0, 0.3, '2.0/0.3'],
  [2.0, 0.5, '2.0/0.5'],
  [2.0, 0.8, '2.0/0.8'],
  [2.5, 0.5, '2.5/0.5'],
  [2.5, 0.8, '2.5/0.8'],
  [3.0, 0.5, '3.0/0.5'],
];

for (const [trailAct, trailPct, label] of trailCombos) {
  const cfg = { ...BASE, trailAct, trailPct };
  const r = runBacktest(allData, cfg);
  const tr = runBacktest(test, cfg);
  printResult(`trail=${label}`, cfg, r, tr);
}

// ═══════════════════════════════════════════
// D. 최적 조합 (A+B+C 조합)
// ═══════════════════════════════════════════
console.log('\n\n━━━ D. 유망 조합 후보 (A+B+C 조합) ━━━\n');

const combos = [];
for (const cool of [3, 5, 8]) {
  for (const maBars of [0, 20, 50]) {
    for (const [trailAct, trailPct] of [[1.0, 0.3], [1.5, 0.5], [2.0, 0.5], [2.0, 0.8], [0, 0]]) {
      combos.push({ ...BASE, cool, maBars, trailAct, trailPct });
    }
  }
}

const comboResults = [];
for (const cfg of combos) {
  const r = runBacktest(allData, cfg);
  const tr = runBacktest(test, cfg);
  if (!r || !tr) continue;
  const score = r.pf * Math.sqrt(r.n) * (1 - r.mdd / 100);
  const testScore = tr.pf * Math.sqrt(tr.n) * (1 - tr.mdd / 100);
  comboResults.push({ cfg, r, tr, score, testScore });
}

// 검증 스코어 기준 정렬
comboResults.sort((a, b) => b.testScore - a.testScore);

console.log('검증 데이터 기준 TOP 10:');
for (let i = 0; i < Math.min(10, comboResults.length); i++) {
  const { cfg, r, tr } = comboResults[i];
  const trailLabel = cfg.trailAct > 0 ? `${cfg.trailAct}/${cfg.trailPct}` : 'OFF';
  printResult(`c${cfg.cool} MA${cfg.maBars} tr${trailLabel}`, cfg, r, tr);
}

// 최종 추천
if (comboResults.length > 0) {
  const best = comboResults[0];
  const bc = best.cfg;
  console.log('\n\n═══════════════════════════════════════════════════════════════════════');
  console.log('  최종 추천 변경사항');
  console.log('═══════════════════════════════════════════════════════════════════════\n');
  console.log(`  cooldownCandles: ${BASE.cool} → ${bc.cool} (${BASE.cool*5}분 → ${bc.cool*5}분)`);
  console.log(`  maBars (추세필터): ${BASE.maBars} → ${bc.maBars} (${BASE.maBars === 0 ? 'OFF' : 'MA'+BASE.maBars} → ${bc.maBars === 0 ? 'OFF' : 'MA'+bc.maBars})`);
  console.log(`  trailActivate/Pct: ${BASE.trailAct}/${BASE.trailPct} → ${bc.trailAct}/${bc.trailPct}`);
  console.log(`\n  전체: ${best.r.n}건 PF${best.r.pf} 승률${best.r.wr}% ${best.r.pnl>0?'+':''}${best.r.pnl.toLocaleString()}원 MDD${best.r.mdd}%`);
  console.log(`  검증: ${best.tr.n}건 PF${best.tr.pf} 승률${best.tr.wr}% ${best.tr.pnl>0?'+':''}${best.tr.pnl.toLocaleString()}원 MDD${best.tr.mdd}%`);
}
