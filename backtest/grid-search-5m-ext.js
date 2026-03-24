/**
 * 5분봉 확장 데이터(35일, 25코인) 그리드 서치
 * 과적합 방지: 전반 17일 학습 → 후반 17일 검증 (Walk-Forward)
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
    if (raw.length < 1000) continue; // 최소 1000봉
    allData.push({ coin, data: raw });
  }
  return allData;
}

function splitData(allData, splitRatio = 0.5) {
  const train = [], test = [];
  for (const { coin, data } of allData) {
    const mid = Math.floor(data.length * splitRatio);
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
        cash += pos.amt + pnl;
        trades.push({ coin, pnl, pnlPct: (net - pos.entry) / pos.entry * 100, reason, time: candle.time });
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

  // 미청산
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
    avgW: wins.length > 0 ? +(wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length).toFixed(2) : 0,
    avgL: losses.length > 0 ? +(losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length).toFixed(2) : 0,
    tp: closed.filter(t=>t.reason==='TP').length,
    trail: closed.filter(t=>t.reason==='TRAIL').length,
    sl: closed.filter(t=>t.reason==='SL').length,
  };
}

// ═══════════════════════════════════════════
const allData = loadAllData();
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  5분봉 확장 그리드 서치 (35일, 25코인, Walk-Forward 검증)');
console.log(`  코인: ${allData.map(d => d.coin).join(', ')} (${allData.length}개)`);
console.log(`  총 봉 수: ${allData.reduce((s, d) => s + d.data.length, 0).toLocaleString()}`);
console.log('═══════════════════════════════════════════════════════════════════════\n');

// Phase 1: 전체 데이터 그리드 서치
const impMins = [0.8, 1.0, 1.2, 1.5, 2.0];
const sls = [0.5, 0.8, 1.0, 1.2];
const tps = [1.0, 1.5, 2.0, 2.5, 3.0];
const trails = [[0,0], [0.8,0.3], [1.0,0.3], [1.0,0.5], [1.5,0.5], [2.0,0.5]];
const maxPoss = [1, 2, 3];
const cools = [3, 5, 8];
const ages = [24, 36, 48];

// Phase 1: 핵심 축 (imp × SL × TP × trail)
console.log('Phase 1: 핵심 4축 탐색 (전체 35일)\n');

const phase1 = [];
for (const impMin of impMins) {
  for (const sl of sls) {
    for (const tp of tps) {
      for (const [trailAct, trailPct] of trails) {
        if (tp / sl < 1.2) continue;
        if (trailAct > 0 && trailAct >= tp) continue;
        phase1.push({
          impMin, impLook: 6, volWin: 20, volMult: 1.5,
          obAge: 36, sl, maxHold: 36, cool: 5,
          maxPos: 2, minTp: tp, maBars: 0,
          trailAct, trailPct,
        });
      }
    }
  }
}

console.log(`Phase 1 조합 수: ${phase1.length}`);
const p1Results = [];
let done = 0;
for (const cfg of phase1) {
  done++;
  if (done % 50 === 0) process.stdout.write(`\r  진행: ${done}/${phase1.length}...`);
  const r = runBacktest(allData, cfg);
  if (!r || r.n < 20) continue;
  p1Results.push({ cfg, r });
}

p1Results.sort((a, b) => {
  const sa = a.r.pf * Math.sqrt(a.r.n) * (1 - a.r.mdd / 100);
  const sb = b.r.pf * Math.sqrt(b.r.n) * (1 - b.r.mdd / 100);
  return sb - sa;
});

console.log(`\r  완료! 유효 결과: ${p1Results.length}개\n`);

console.log('── Phase 1 TOP 20 ──');
console.log('순위 | imp  | SL   | TP   | trail   | 거래 | 일평균 | 승률  |    총손익    |   일손익  | PF   | MDD  | 연손 | 승%   | 패%   | EV     | 일(+/-) | 스코어');
console.log('─'.repeat(180));

for (let i = 0; i < Math.min(20, p1Results.length); i++) {
  const { cfg, r } = p1Results[i];
  const score = (r.pf * Math.sqrt(r.n) * (1 - r.mdd / 100)).toFixed(1);
  console.log(
    `${String(i+1).padStart(4)} | ${cfg.impMin.toFixed(1).padStart(4)} | ${cfg.sl.toFixed(1).padStart(4)} | ${cfg.minTp.toFixed(1).padStart(4)} | ${cfg.trailAct > 0 ? (cfg.trailAct+'/'+cfg.trailPct).padEnd(7) : 'OFF'.padEnd(7)} | ` +
    `${String(r.n).padStart(4)} | ${r.perDay.toFixed(1).padStart(5)}/일 | ${r.wr.toFixed(1).padStart(5)}% | ` +
    `${(r.pnl>0?'+':'')+r.pnl.toLocaleString()+'원'}`.padStart(12) + ` | ` +
    `${(r.daily>0?'+':'')+r.daily.toLocaleString()+'원'}`.padStart(9) + ` | ` +
    `${r.pf.toFixed(2).padStart(5)} | ${r.mdd.toFixed(1).padStart(4)}% | ${String(r.maxCL).padStart(3)} | ` +
    `+${r.avgW}%`.padStart(7) + ` | ${r.avgL}%`.padStart(7) + ` | ` +
    `${r.ev>0?'+':''}${r.ev}원`.padStart(7) + ` | ` +
    `${r.days}(${r.profitDays}+)`.padStart(8) + ` | ${score}`
  );
}

// Phase 2: TOP 5 보조 파라미터
console.log('\n\nPhase 2: TOP 5 보조 파라미터 최적화\n');

const phase2 = [];
for (const base of p1Results.slice(0, 5).map(t => t.cfg)) {
  for (const maxPos of maxPoss) {
    for (const cool of cools) {
      for (const obAge of ages) {
        for (const impLook of [4, 6, 8]) {
          for (const maBars of [0, 20, 50]) {
            phase2.push({ ...base, maxPos, cool, obAge, impLook, maBars });
          }
        }
      }
    }
  }
}

console.log(`Phase 2 조합 수: ${phase2.length}`);
const p2Results = [];
done = 0;
for (const cfg of phase2) {
  done++;
  if (done % 100 === 0) process.stdout.write(`\r  진행: ${done}/${phase2.length}...`);
  const r = runBacktest(allData, cfg);
  if (!r || r.n < 20) continue;
  p2Results.push({ cfg, r });
}

p2Results.sort((a, b) => {
  const sa = a.r.pf * Math.sqrt(a.r.n) * (1 - a.r.mdd / 100);
  const sb = b.r.pf * Math.sqrt(b.r.n) * (1 - b.r.mdd / 100);
  return sb - sa;
});

console.log(`\r  완료! 유효 결과: ${p2Results.length}개\n`);

console.log('── Phase 2 TOP 10 ──');
console.log('순위 | imp  | SL   | TP   | trail   | pos | cool | age | look | MA | 거래 | 일평균 | 승률  |    총손익    |   일손익  | PF   | MDD  | 연손 | 일(+/-) | 스코어');
console.log('─'.repeat(190));

for (let i = 0; i < Math.min(10, p2Results.length); i++) {
  const { cfg, r } = p2Results[i];
  const score = (r.pf * Math.sqrt(r.n) * (1 - r.mdd / 100)).toFixed(1);
  console.log(
    `${String(i+1).padStart(4)} | ${cfg.impMin.toFixed(1).padStart(4)} | ${cfg.sl.toFixed(1).padStart(4)} | ${cfg.minTp.toFixed(1).padStart(4)} | ${cfg.trailAct > 0 ? (cfg.trailAct+'/'+cfg.trailPct).padEnd(7) : 'OFF'.padEnd(7)} | ` +
    `${String(cfg.maxPos).padStart(3)} | ${String(cfg.cool).padStart(4)} | ${String(cfg.obAge).padStart(3)} | ${String(cfg.impLook).padStart(4)} | ${String(cfg.maBars).padStart(2)} | ` +
    `${String(r.n).padStart(4)} | ${r.perDay.toFixed(1).padStart(5)}/일 | ${r.wr.toFixed(1).padStart(5)}% | ` +
    `${(r.pnl>0?'+':'')+r.pnl.toLocaleString()+'원'}`.padStart(12) + ` | ` +
    `${(r.daily>0?'+':'')+r.daily.toLocaleString()+'원'}`.padStart(9) + ` | ` +
    `${r.pf.toFixed(2).padStart(5)} | ${r.mdd.toFixed(1).padStart(4)}% | ${String(r.maxCL).padStart(3)} | ` +
    `${r.days}(${r.profitDays}+)`.padStart(8) + ` | ${score}`
  );
}

// ═══ Walk-Forward 검증 ═══
console.log('\n\n═══════════════════════════════════════════════════════════════════════');
console.log('  Walk-Forward 검증: 전반 17일 학습 → 후반 17일 테스트');
console.log('═══════════════════════════════════════════════════════════════════════\n');

const { train, test } = splitData(allData, 0.5);
const trainStart = train[0]?.data[0]?.time?.slice(0, 10);
const trainEnd = train[0]?.data[train[0].data.length - 1]?.time?.slice(0, 10);
const testStart = test[0]?.data[0]?.time?.slice(0, 10);
const testEnd = test[0]?.data[test[0].data.length - 1]?.time?.slice(0, 10);
console.log(`학습: ${trainStart} ~ ${trainEnd}`);
console.log(`검증: ${testStart} ~ ${testEnd}\n`);

// TOP 10 설정을 학습/검증 각각 돌리기
console.log('설정                                         | 전체 PF  | 학습 PF (승률) 거래  |  검증 PF (승률) 거래  | 검증 손익    | 검증 MDD | 과적합?');
console.log('─'.repeat(140));

const topConfigs = p2Results.slice(0, 10);
const wfResults = [];

for (let i = 0; i < topConfigs.length; i++) {
  const { cfg, r: fullR } = topConfigs[i];
  const trainR = runBacktest(train, cfg);
  const testR = runBacktest(test, cfg);

  if (!trainR || !testR) continue;

  const overfit = testR.pf < trainR.pf * 0.5 ? '⚠️ 과적합' : testR.pf >= trainR.pf * 0.7 ? '✅ 양호' : '⚡ 주의';
  const label = `imp${cfg.impMin} SL${cfg.sl} TP${cfg.minTp} tr${cfg.trailAct}/${cfg.trailPct} p${cfg.maxPos} c${cfg.cool} a${cfg.obAge} l${cfg.impLook} m${cfg.maBars}`;

  wfResults.push({ cfg, fullR, trainR, testR, overfit });

  console.log(
    `${label.padEnd(45)}| ${fullR.pf.toFixed(2).padStart(6)}  | ` +
    `${trainR.pf.toFixed(2).padStart(6)} (${trainR.wr}%) ${String(trainR.n).padStart(4)} | ` +
    `${testR.pf.toFixed(2).padStart(6)} (${testR.wr}%) ${String(testR.n).padStart(4)} | ` +
    `${(testR.pnl>0?'+':'')+testR.pnl.toLocaleString()+'원'}`.padStart(11) + ` | ` +
    `${testR.mdd}%`.padStart(6) + ` | ${overfit}`
  );
}

// 검증 데이터 기준 BEST
const validResults = wfResults.filter(w => w.testR.pf >= 1.5 && w.testR.n >= 10);
if (validResults.length > 0) {
  validResults.sort((a, b) => {
    const sa = a.testR.pf * Math.sqrt(a.testR.n) * (1 - a.testR.mdd / 100);
    const sb = b.testR.pf * Math.sqrt(b.testR.n) * (1 - b.testR.mdd / 100);
    return sb - sa;
  });

  const best = validResults[0];
  const bc = best.cfg;
  const br = best.fullR;
  const tr = best.testR;

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  최종 추천 (검증 데이터 기준 BEST)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');
  console.log(`imp: ${bc.impMin}% | impLook: ${bc.impLook} | volMult: ${bc.volMult}`);
  console.log(`obAge: ${bc.obAge} | SL: ${bc.sl}% | TP: ${bc.minTp}% | trail: ${bc.trailAct}/${bc.trailPct}%`);
  console.log(`maxPos: ${bc.maxPos} | cool: ${bc.cool} | MA: ${bc.maBars} | maxHold: ${bc.maxHold}`);
  console.log(`\n전체(35일): ${br.n}건 | 승률 ${br.wr}% | PF ${br.pf} | 총 ${br.pnl>0?'+':''}${br.pnl.toLocaleString()}원 | MDD ${br.mdd}%`);
  console.log(`학습(전반): ${best.trainR.n}건 | 승률 ${best.trainR.wr}% | PF ${best.trainR.pf}`);
  console.log(`검증(후반): ${tr.n}건 | 승률 ${tr.wr}% | PF ${tr.pf} | 총 ${tr.pnl>0?'+':''}${tr.pnl.toLocaleString()}원 | MDD ${tr.mdd}%`);
  console.log(`\n과적합 판정: ${best.overfit}`);

  console.log('\n── config.json 적용 값 ──');
  console.log(JSON.stringify({
    candleMinute: 5,
    impulseMinPct: bc.impMin,
    impulseLookback: bc.impLook,
    volumeAvgWindow: bc.volWin,
    volumeMultiplier: bc.volMult,
    obMaxAge: bc.obAge,
    slPct: bc.sl,
    maxHoldCandles: bc.maxHold,
    cooldownCandles: bc.cool,
    maxPositions: bc.maxPos,
    minTpPct: bc.minTp,
    useTrendFilter: bc.maBars > 0,
    trendMaPeriod: bc.maBars || 50,
    trailActivatePct: bc.trailAct,
    trailPct: bc.trailPct,
    topCoinsCount: 15,
    minCoinPrice: 500,
  }, null, 2));
}

// 과적합 경고가 있으면 안전한 대안 제시
const safeResults = wfResults.filter(w => w.testR.pf >= 1.3 && w.testR.n >= 15);
if (safeResults.length > 0) {
  safeResults.sort((a, b) => b.testR.pnl - a.testR.pnl);
  console.log('\n\n── 검증 수익 기준 TOP 3 (안전 대안) ──');
  for (let i = 0; i < Math.min(3, safeResults.length); i++) {
    const { cfg, testR, overfit } = safeResults[i];
    console.log(`${i+1}. imp${cfg.impMin} SL${cfg.sl} TP${cfg.minTp} tr${cfg.trailAct}/${cfg.trailPct} p${cfg.maxPos} c${cfg.cool} a${cfg.obAge} l${cfg.impLook} m${cfg.maBars} → 검증: ${testR.n}건 PF${testR.pf} 승률${testR.wr}% ${testR.pnl>0?'+':''}${testR.pnl.toLocaleString()}원 MDD${testR.mdd}% ${overfit}`);
  }
}
