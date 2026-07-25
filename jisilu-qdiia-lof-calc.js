/**
 * 集思录 QDII 亚洲 LOF 实时估值 — 纯计算模块（Node 单测与脚本内联同源逻辑）
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
  if (!t || t === '--') return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)%?$/);
  if (!m) return null;
  return parseFloat(m[1]) / 100;
}

function calcEstimate(nav, indexRatio, stockRatio = STOCK_RATIO) {
  if (nav == null || indexRatio == null || nav <= 0) return null;
  return nav * (1 + indexRatio * stockRatio);
}

function calcPremium(price, estimate) {
  if (price == null || estimate == null || estimate <= 0) return null;
  return ((price - estimate) / estimate) * 100;
}

function isLofName(name) {
  return /LOF/i.test(String(name || ''));
}

function formatEstimate(v) {
  if (v == null) return '--';
  return v.toFixed(4);
}

function formatPremium(v) {
  if (v == null) return '--';
  const sign = v >= 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}

module.exports = {
  STOCK_RATIO,
  parseNumber,
  parsePercent,
  calcEstimate,
  calcPremium,
  isLofName,
  formatEstimate,
  formatPremium,
};
