/**
 * 24번트 이메일 알림 서비스
 * - 매수/매도 시 Gmail 발송
 * - 일일 리포트
 */

const nodemailer = require('nodemailer');

let _transporter = null;
let _config = { emailTo: '', emailAppPassword: '', emailEnabled: false };

function init(config) {
  _config = { ..._config, ...config };
  if (_config.emailAppPassword && _config.emailTo) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: _config.emailTo, pass: _config.emailAppPassword },
    });
    console.log(`[EMAIL] 이메일 알림 활성화: ${_config.emailTo}`);
  }
}

function isReady() {
  return !!_transporter && _config.emailEnabled;
}

async function send(subject, html) {
  if (!isReady()) return;
  try {
    await _transporter.sendMail({
      from: `24번트 코인봇 <${_config.emailTo}>`,
      to: _config.emailTo,
      subject,
      html,
    });
  } catch (e) {
    console.error('[EMAIL] 발송 실패:', e.message);
  }
}

// ── 매수 알림 ─────────────────────────────────────
async function sendBuyAlert(position) {
  if (!isReady()) return;
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const html = `
  <div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden;">
    <div style="background:#b08800;padding:16px 20px;text-align:center;">
      <h2 style="margin:0;color:#fff;font-size:18px;">🟡 매수 체결</h2>
    </div>
    <div style="padding:20px;">
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:28px;font-weight:800;color:#3fb950;">${position.coin}</div>
        <div style="color:#8b949e;font-size:13px;">${now}</div>
      </div>
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:8px 0;color:#8b949e;">진입가</td><td style="padding:8px 0;text-align:right;font-weight:600;">${position.entryPrice.toLocaleString()}원</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e;">투자금</td><td style="padding:8px 0;text-align:right;font-weight:600;">${position.amount.toLocaleString()}원</td></tr>
        <tr style="border-top:1px solid #30363d;"><td style="padding:8px 0;color:#3fb950;">익절 (TP)</td><td style="padding:8px 0;text-align:right;color:#3fb950;font-weight:600;">${position.tpPrice.toLocaleString()}원 (+${((position.tpPrice - position.entryPrice) / position.entryPrice * 100).toFixed(1)}%)</td></tr>
        <tr><td style="padding:8px 0;color:#f85149;">손절 (SL)</td><td style="padding:8px 0;text-align:right;color:#f85149;font-weight:600;">${position.slPrice.toLocaleString()}원 (${((position.slPrice - position.entryPrice) / position.entryPrice * 100).toFixed(1)}%)</td></tr>
      </table>
      <div style="margin-top:16px;padding:10px;background:#161b22;border-radius:8px;font-size:12px;color:#8b949e;text-align:center;">
        OB 임펄스: +${position.obImpulse}% | 최대보유: 5시간
      </div>
    </div>
  </div>`;

  await send(`[코인] 🟡 ${position.coin} 매수 | ${position.entryPrice.toLocaleString()}원 × ${position.amount.toLocaleString()}원`, html);
}

// ── 매도 알림 ─────────────────────────────────────
async function sendSellAlert(trade) {
  if (!isReady()) return;
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const isProfit = trade.pnl > 0;
  const icon = isProfit ? '🟢' : trade.reason === 'SL' ? '🔴' : '🟡';
  const reasonText = { TP: '익절', TRAIL: '트레일 익절', SL: '손절', TIMEOUT: '시간초과', MANUAL: '수동매도' }[trade.reason] || trade.reason;
  const bgColor = isProfit ? '#238636' : '#da3634';
  const pnlColor = isProfit ? '#3fb950' : '#f85149';

  const html = `
  <div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden;">
    <div style="background:${bgColor};padding:16px 20px;text-align:center;">
      <h2 style="margin:0;color:#fff;font-size:18px;">${icon} 매도 — ${reasonText}</h2>
    </div>
    <div style="padding:20px;">
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:28px;font-weight:800;">${trade.coin}</div>
        <div style="font-size:36px;font-weight:800;color:${pnlColor};margin:8px 0;">
          ${trade.pnlPct > 0 ? '+' : ''}${trade.pnlPct}%
        </div>
        <div style="font-size:18px;color:${pnlColor};font-weight:600;">
          ${trade.pnl > 0 ? '+' : ''}${trade.pnl.toLocaleString()}원
        </div>
        <div style="color:#8b949e;font-size:13px;margin-top:4px;">${now}</div>
      </div>
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:8px 0;color:#8b949e;">매수가</td><td style="padding:8px 0;text-align:right;">${trade.entryPrice.toLocaleString()}원</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e;">매도가</td><td style="padding:8px 0;text-align:right;font-weight:600;">${trade.exitPrice.toLocaleString()}원</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e;">투자금</td><td style="padding:8px 0;text-align:right;">${trade.amount.toLocaleString()}원</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e;">보유시간</td><td style="padding:8px 0;text-align:right;">${trade.holdMinutes}분</td></tr>
      </table>
    </div>
  </div>`;

  await send(`[코인] ${icon} ${trade.coin} ${reasonText} | ${trade.pnlPct > 0 ? '+' : ''}${trade.pnlPct}% (${trade.pnl > 0 ? '+' : ''}${trade.pnl.toLocaleString()}원)`, html);
}

module.exports = { init, isReady, send, sendBuyAlert, sendSellAlert };
