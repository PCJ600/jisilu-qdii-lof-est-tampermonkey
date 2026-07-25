/**
 * 集思录 QDII 欧美/商品 T-1 日估值 — 纯计算模块
 */

const STOCK_RATIO = 0.95;

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

module.exports = {
  STOCK_RATIO,
  parseNumber,
  parsePercent,
  isIndexUnavailable,
  DISPLAY_UNAVAILABLE,
  calcT1Estimate,
  calcPremium,
  formatEstimate,
  formatPremium,
};
