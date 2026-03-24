/**
 * 5분봉 그리드 서치 — N시나리오 주변 최적 파라미터 탐색
 * 수수료 양방향 반영, 500원 이상 코인만
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR_1M = path.join(__dirname, '..', 'data', 'candles-1m');
const COMMISSION = 0.0005;
const MIN_PRICE = 500;

// 1분봉→5분봉 합성
function aggregate1mTo5m(data1m) {
  const grouped = {};
  for (const c of data1m) {
    const d = new Date(c.time);
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
    const key = d.toISOString().replace('Z', '').slice(0, 19);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  }
  const result = [];
  for (const [time, candles] of Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))) {
    if (candles.length < 3) continue;
    result.push({
      time, open: candles[0].open,
      high: Math.max(...candles.map(c => c.high)),
      low: Math.min(...candles.map(c => c.low)),
      close: candles[candles.length - 1].close,
      volume: candles.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

function loadAllData() {
  const files = fs.readdirSync(DATA_DIR_1M).filter(f => f.endsWith('.json'));
  const allData = [];
  for (const file of files) {
    const coin = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR_1M, file)));
    if (raw.length < 500) continue;
    const avgPrice = raw.slice(-200).reduce((s, c) => s + c.close, 0) / 200;
    if (avgPrice < MIN_PRICE) continue;
    allData.push({ coin, data: aggregate1mTo5m(raw) });
  }
  return allData;
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

    // 청산
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

    // 진입
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

  // 미청산 정리
  for (const pos of positions) {
    const cd = allData.find(d => d.coin === pos.coin)?.data;
    if (cd) {
      const lp = cd[cd.length - 1].close * (1 - COMMISSION);
      const pnl = (lp - pos.entry) / pos.entry * pos.amt;
      trades.push({ pnl, pnlPct: (lp - pos.entry) / pos.entry * 100, reason: 'OPEN', time: '' });
      cash += pos.amt + pnl;
    }
  }

  const closed = trades.filter(t => t.reason !== 'OPEN');
  if (closed.length === 0) return null;

  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const winGross = wins.reduce((s, t) => s + t.pnl, 0);
  const lossGross = losses.reduce((s, t) => s + t.pnl, 0);

  // 일별 통계
  const daily = {};
  for (const t of closed) {
    const d = (t.time || '').slice(0, 10);
    if (!daily[d]) daily[d] = { pnl: 0, n: 0 };
    daily[d].pnl += t.pnl;
    daily[d].n++;
  }
  const days = Object.keys(daily).filter(d => daily[d].n > 0).length || 1;
  const profitDays = Object.values(daily).filter(d => d.pnl > 0).length;
  const lossDays = Object.values(daily).filter(d => d.pnl < 0).length;

  // MDD
  let peak = 100000, eq = 100000, mdd = 0;
  for (const t of closed) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  // 연속 손절
  let maxCL = 0, cl = 0;
  for (const t of closed) {
    if (t.pnl <= 0) { cl++; maxCL = Math.max(maxCL, cl); } else cl = 0;
  }

  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  return {
    n: closed.length,
    tp: closed.filter(t => t.reason === 'TP').length,
    trail: closed.filter(t => t.reason === 'TRAIL').length,
    sl: closed.filter(t => t.reason === 'SL').length,
    to: closed.filter(t => t.reason === 'TO').length,
    wr: +(wins.length / closed.length * 100).toFixed(1),
    pnl: Math.round(totalPnl),
    daily: Math.round(totalPnl / days),
    pf: lossGross !== 0 ? +Math.abs(winGross / lossGross).toFixed(2) : 99,
    mdd: +mdd.toFixed(2),
    maxCL,
    avgW: +avgWinPct.toFixed(2),
    avgL: +avgLossPct.toFixed(2),
    days,
    profitDays,
    lossDays,
    ev: Math.round(totalPnl / closed.length),
    perDay: +(closed.length / days).toFixed(1),
  };
}

// ═══════════════════════════════════════════
// 그리드 서치 파라미터 공간
// ═══════════════════════════════════════════

const allData = loadAllData();
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  5분봉 그리드 서치 — 최적 파라미터 탐색');
console.log(`  코인: ${allData.map(d => d.coin).join(', ')} (${allData.length}개, 500원↑)`);
console.log('  수수료: 양방향 0.05% 반영');
console.log('═══════════════════════════════════════════════════════════════════════\n');

const grid = [];

// 축 1: impulse 기준
const impMins = [0.8, 1.0, 1.2, 1.5, 2.0];
// 축 2: SL
const sls = [0.5, 0.8, 1.0, 1.2, 1.5];
// 축 3: TP
const tps = [1.0, 1.5, 2.0, 2.5, 3.0];
// 축 4: trail (activate, pct) — 0은 트레일 비활성
const trails = [[0, 0], [1.0, 0.3], [1.0, 0.5], [1.5, 0.5], [2.0, 0.5], [2.0, 0.7]];
// 축 5: maxPositions
const maxPoss = [1, 2, 3];
// 축 6: cooldown
const cools = [1, 3, 5];
// 축 7: obAge
const ages = [24, 36, 48];
// 축 8: impulseLookback
const looks = [4, 6, 8];
// 축 9: volMult
const vols = [1, 1.5];
// 축 10: MA bars
const mas = [0, 20];

// 전체 조합은 5*5*5*6*3*3*3*3*2*2 = 486,000 — 너무 많음
// 단계별 축소: 핵심 4축만 먼저 (imp, sl, tp, trail)
console.log('Phase 1: 핵심 4축 탐색 (imp × SL × TP × trail)');
console.log('  고정: maxPos=2, cool=3, obAge=48, impLook=6, volMult=1.5, MA=0\n');

const phase1 = [];
for (const impMin of impMins) {
  for (const sl of sls) {
    for (const tp of tps) {
      for (const [trailAct, trailPct] of trails) {
        // R:R 필터 — TP/SL 비율이 1.5 미만이면 스킵
        if (tp / sl < 1.2) continue;
        // trail이 TP보다 높으면 의미 없음
        if (trailAct > 0 && trailAct >= tp) continue;

        phase1.push({
          impMin, impLook: 6, volWin: 20, volMult: 1.5,
          obAge: 48, sl, maxHold: 36, cool: 3,
          maxPos: 2, minTp: tp, maBars: 0,
          trailAct, trailPct,
        });
      }
    }
  }
}

console.log(`Phase 1 조합 수: ${phase1.length}\n`);

const p1Results = [];
for (const cfg of phase1) {
  const r = runBacktest(allData, cfg);
  if (!r || r.n < 10) continue; // 최소 10건 이상
  p1Results.push({ cfg, r });
}

// PF * 거래수 가중 스코어로 정렬 (PF만 높고 거래 1건이면 의미 없음)
p1Results.sort((a, b) => {
  // 종합 스코어: PF * sqrt(거래수) * (1 - MDD/100) — 안정적 수익 우선
  const scoreA = a.r.pf * Math.sqrt(a.r.n) * (1 - a.r.mdd / 100);
  const scoreB = b.r.pf * Math.sqrt(b.r.n) * (1 - b.r.mdd / 100);
  return scoreB - scoreA;
});

console.log('── Phase 1 TOP 30 ──');
console.log('순위 | imp  | SL   | TP   | trail    | 거래 | 승률  |   총손익   | 일손익  | PF   | MDD  | 연손 | 승%   | 패%   | EV    | 일수(+/-) | 스코어');
console.log('─'.repeat(170));

const top30 = p1Results.slice(0, 30);
for (let i = 0; i < top30.length; i++) {
  const { cfg, r } = top30[i];
  const score = (r.pf * Math.sqrt(r.n) * (1 - r.mdd / 100)).toFixed(1);
  console.log(
    `${String(i + 1).padStart(4)} | ${cfg.impMin.toFixed(1).padStart(4)} | ${cfg.sl.toFixed(1).padStart(4)} | ${cfg.minTp.toFixed(1).padStart(4)} | ${cfg.trailAct > 0 ? cfg.trailAct + '/' + cfg.trailPct : 'OFF'.padEnd(7)} | ` +
    `${String(r.n).padStart(4)} | ${r.wr.toFixed(1).padStart(5)}% | ` +
    `${(r.pnl > 0 ? '+' : '') + r.pnl.toLocaleString() + '원'}`.padStart(10) + ` | ` +
    `${(r.daily > 0 ? '+' : '') + r.daily.toLocaleString()}원`.padStart(7) + ` | ` +
    `${r.pf.toFixed(2).padStart(5)} | ${r.mdd.toFixed(1).padStart(4)}% | ${String(r.maxCL).padStart(3)} | ` +
    `+${r.avgW.toFixed(2)}% | ${r.avgL.toFixed(2)}% | ` +
    `${r.ev > 0 ? '+' : ''}${r.ev}원`.padStart(6) + ` | ` +
    `${r.days}(${r.profitDays}/${r.lossDays})`.padStart(10) + ` | ${score}`
  );
}

// Phase 2: TOP 5의 보조 파라미터 최적화
console.log('\n\n═══════════════════════════════════════════════════════════════════════');
console.log('  Phase 2: TOP 5 기반 보조 파라미터 최적화 (maxPos, cool, obAge, impLook, vol, MA)');
console.log('═══════════════════════════════════════════════════════════════════════\n');

const phase2 = [];
const topCfgs = top30.slice(0, 5).map(t => t.cfg);

for (const base of topCfgs) {
  for (const maxPos of maxPoss) {
    for (const cool of cools) {
      for (const obAge of ages) {
        for (const impLook of looks) {
          for (const volMult of vols) {
            for (const maBars of mas) {
              phase2.push({
                ...base, maxPos, cool, obAge, impLook, volMult, maBars,
              });
            }
          }
        }
      }
    }
  }
}

console.log(`Phase 2 조합 수: ${phase2.length}\n`);

const p2Results = [];
for (const cfg of phase2) {
  const r = runBacktest(allData, cfg);
  if (!r || r.n < 10) continue;
  p2Results.push({ cfg, r });
}

p2Results.sort((a, b) => {
  const scoreA = a.r.pf * Math.sqrt(a.r.n) * (1 - a.r.mdd / 100);
  const scoreB = b.r.pf * Math.sqrt(b.r.n) * (1 - b.r.mdd / 100);
  return scoreB - scoreA;
});

console.log('── Phase 2 TOP 15 ──');
console.log('순위 | imp  | SL   | TP   | trail   | pos | cool | age | look | vol  | MA | 거래 | 승률  |   총손익   |  일손익 | PF   | MDD  | 연손 | 일(+/-) | 스코어');
console.log('─'.repeat(180));

for (let i = 0; i < Math.min(15, p2Results.length); i++) {
  const { cfg, r } = p2Results[i];
  const score = (r.pf * Math.sqrt(r.n) * (1 - r.mdd / 100)).toFixed(1);
  console.log(
    `${String(i + 1).padStart(4)} | ${cfg.impMin.toFixed(1).padStart(4)} | ${cfg.sl.toFixed(1).padStart(4)} | ${cfg.minTp.toFixed(1).padStart(4)} | ${cfg.trailAct > 0 ? (cfg.trailAct + '/' + cfg.trailPct).padEnd(7) : 'OFF'.padEnd(7)} | ` +
    `${String(cfg.maxPos).padStart(3)} |  ${String(cfg.cool).padStart(3)} | ${String(cfg.obAge).padStart(3)} |  ${String(cfg.impLook).padStart(3)} | ${cfg.volMult.toFixed(1).padStart(4)} | ${String(cfg.maBars).padStart(2)} | ` +
    `${String(r.n).padStart(4)} | ${r.wr.toFixed(1).padStart(5)}% | ` +
    `${(r.pnl > 0 ? '+' : '') + r.pnl.toLocaleString() + '원'}`.padStart(10) + ` | ` +
    `${(r.daily > 0 ? '+' : '') + r.daily.toLocaleString()}원`.padStart(7) + ` | ` +
    `${r.pf.toFixed(2).padStart(5)} | ${r.mdd.toFixed(1).padStart(4)}% | ${String(r.maxCL).padStart(3)} | ` +
    `${r.days}(${r.profitDays}/${r.lossDays})`.padStart(8) + ` | ${score}`
  );
}

// 최종 추천
console.log('\n\n═══════════════════════════════════════════════════════════════════════');
console.log('  최종 추천 설정');
console.log('═══════════════════════════════════════════════════════════════════════\n');

const best = p2Results[0];
const bc = best.cfg;
const br = best.r;

console.log(`imp: ${bc.impMin}% | impLook: ${bc.impLook} | volWin: ${bc.volWin} | volMult: ${bc.volMult}`);
console.log(`obAge: ${bc.obAge} | SL: ${bc.sl}% | TP: ${bc.minTp}% | trail: ${bc.trailAct}/${bc.trailPct}%`);
console.log(`maxPos: ${bc.maxPos} | cool: ${bc.cool} | MA: ${bc.maBars} | maxHold: ${bc.maxHold}`);
console.log(`\n결과: ${br.n}건 | 승률 ${br.wr}% | PF ${br.pf} | 총 ${br.pnl > 0 ? '+' : ''}${br.pnl.toLocaleString()}원 | 일평균 ${br.daily > 0 ? '+' : ''}${br.daily.toLocaleString()}원 | MDD ${br.mdd}% | 연속손절 ${br.maxCL}`);

// N시나리오와 비교
const nCfg = {
  impMin: 1.5, impLook: 6, volWin: 20, volMult: 1.5,
  obAge: 48, sl: 1.0, maxHold: 36, cool: 3,
  maxPos: 2, minTp: 2.0, maBars: 0,
  trailAct: 1.5, trailPct: 0.5,
};
const nResult = runBacktest(allData, nCfg);

console.log('\n── N시나리오 vs 최적 비교 ──');
console.log(`N시나리오: ${nResult.n}건 | 승률 ${nResult.wr}% | PF ${nResult.pf} | 총 ${nResult.pnl > 0 ? '+' : ''}${nResult.pnl.toLocaleString()}원 | MDD ${nResult.mdd}%`);
console.log(`최적 설정: ${br.n}건 | 승률 ${br.wr}% | PF ${br.pf} | 총 ${br.pnl > 0 ? '+' : ''}${br.pnl.toLocaleString()}원 | MDD ${br.mdd}%`);
console.log(`개선:      PnL ${br.pnl > nResult.pnl ? '+' : ''}${(br.pnl - nResult.pnl).toLocaleString()}원 | PF ${(br.pf - nResult.pf) > 0 ? '+' : ''}${(br.pf - nResult.pf).toFixed(2)} | MDD ${(br.mdd - nResult.mdd) > 0 ? '+' : ''}${(br.mdd - nResult.mdd).toFixed(1)}%`);

// config.json 형식으로 출력
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
  trendMaPeriod: bc.maBars,
  trailActivatePct: bc.trailAct,
  trailPct: bc.trailPct,
  topCoinsCount: 15,
  minCoinPrice: 500,
}, null, 2));
