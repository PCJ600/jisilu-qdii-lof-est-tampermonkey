/**
 * 集思录 QDII 欧美/商品 T-1 日估值 — 纯计算模块
 */

const STOCK_RATIO = 0.95;
const SHANGHAI_TZ = 'Asia/Shanghai';

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[−－]/g, '-')
    .trim();
}

function parseNumber(s) {
  const t = normalizeText(s);
  if (!t || t === '--' || t === '-') return null;
  const n = parseFloat(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parsePercent(s) {
  const t = normalizeText(s);
  if (!t || t === '--' || t === '-') return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)%?$/);
  if (!m) return null;
  return parseFloat(m[1]) / 100;
}

function isIndexUnavailable(raw) {
  const t = normalizeText(raw);
  if (!t || t === '-' || t === '--') return true;
  return parsePercent(raw) == null;
}

const DISPLAY_UNAVAILABLE = '-';

function formatEstimate(v, indexUnavailable = false) {
  if (indexUnavailable) return DISPLAY_UNAVAILABLE;
  if (v == null) return '--';
  return v.toFixed(4);
}

function formatPremium(v, indexUnavailable = false) {
  if (indexUnavailable) return DISPLAY_UNAVAILABLE;
  if (v == null) return '--';
  const sign = v >= 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}

/** T-1 日估值 = T-2 净值 × (1 + T-1 指数涨幅 × 95%) */
function calcT1Estimate(t2Nav, indexRatio, stockRatio = STOCK_RATIO) {
  if (t2Nav == null || indexRatio == null || t2Nav <= 0) return null;
  return t2Nav * (1 + indexRatio * stockRatio);
}

function calcPremium(price, estimate) {
  if (price == null || estimate == null || estimate <= 0) return null;
  return ((price - estimate) / estimate) * 100;
}

function getShanghaiCalendarParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: pick('year'), m: pick('month'), d: pick('day') };
}

function weekdayShanghai(now = new Date()) {
  const w = new Intl.DateTimeFormat('en-US', {
    timeZone: SHANGHAI_TZ,
    weekday: 'short',
  }).format(now);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
}

function ymdToString(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addCalendarDays(y, m, d, delta) {
  const t = Date.UTC(y, m - 1, d + delta);
  const dt = new Date(t);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

function shiftYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const p = addCalendarDays(y, m, d, deltaDays);
  return ymdToString(p.y, p.m, p.d);
}

/** 周一至周五=当天；周六日=上周五（法定节假日未单独处理） */
function getSessionDayYmd(now = new Date()) {
  const parts = getShanghaiCalendarParts(now);
  const wd = weekdayShanghai(now);
  if (wd === 6) {
    const p = addCalendarDays(parts.y, parts.m, parts.d, -1);
    return ymdToString(p.y, p.m, p.d);
  }
  if (wd === 0) {
    const p = addCalendarDays(parts.y, parts.m, parts.d, -2);
    return ymdToString(p.y, p.m, p.d);
  }
  return ymdToString(parts.y, parts.m, parts.d);
}

function inferYearForMonthDay(m, d, refY, refM, refD) {
  let y = refY;
  const navOrd = m * 100 + d;
  const refOrd = refM * 100 + refD;
  if (navOrd > refOrd + 50) y = refY - 1;
  return y;
}

function parseTwoDigitYear(yy) {
  const n = Number(yy);
  if (!Number.isFinite(n)) return null;
  return n >= 70 ? 1900 + n : 2000 + n;
}

/**
 * 解析「净值日期」→ YYYY-MM-DD（支持 YYYY-MM-DD、YY-MM-DD、MM-DD）
 */
function parseNavDateYmd(raw, refSessionYmd) {
  const t = normalizeText(raw);
  if (!t || t === '-' || t === '--') return null;

  let y;
  let m;
  let d;

  const full = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (full) {
    y = Number(full[1]);
    m = Number(full[2]);
    d = Number(full[3]);
  } else {
    const yymd = t.match(/^(\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (yymd) {
      y = parseTwoDigitYear(yymd[1]);
      m = Number(yymd[2]);
      d = Number(yymd[3]);
    } else {
      const md = t.match(/^(\d{1,2})[-/.](\d{1,2})$/);
      if (!md) return null;
      m = Number(md[1]);
      d = Number(md[2]);
      if (!refSessionYmd) return null;
      const [refY, refM, refD] = refSessionYmd.split('-').map(Number);
      y = inferYearForMonthDay(m, d, refY, refM, refD);
    }
  }

  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return ymdToString(y, m, d);
}

/**
 * 是否仍可用 T-2×指数 估 T-1：净值日期须严格早于「会话日 − 1 自然日」。
 * 例：会话日周五 → 仅净值日期 ≤ 周三可估；周四及以上停估。
 */
function shouldUseT1IndexEstimate(navDateYmd, sessionDayYmd) {
  if (!navDateYmd || !sessionDayYmd) return true;
  const cutoff = shiftYmd(sessionDayYmd, -1);
  return navDateYmd < cutoff;
}

module.exports = {
  STOCK_RATIO,
  SHANGHAI_TZ,
  parseNumber,
  parsePercent,
  isIndexUnavailable,
  DISPLAY_UNAVAILABLE,
  calcT1Estimate,
  calcPremium,
  formatEstimate,
  formatPremium,
  getSessionDayYmd,
  parseNavDateYmd,
  shouldUseT1IndexEstimate,
  shiftYmd,
};
