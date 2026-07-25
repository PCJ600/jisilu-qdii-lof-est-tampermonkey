const assert = require('assert');
const {
  parsePercent,
  parseNumber,
  calcEstimate,
  calcPremium,
  isIndexUnavailable,
  formatEstimate,
  formatPremium,
  getSessionDayYmd,
  parseNavDateYmd,
  shouldUseIndexEstimate,
  isNavCoversSessionDay,
} = require('./jisilu-qdiia-lof-calc.js');

function approx(a, b, eps = 1e-4) {
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
}

function shanghaiDate(y, m, d, h = 12) {
  return new Date(Date.UTC(y, m - 1, d, h - 8, 0, 0));
}

// parsePercent
approx(parsePercent('-0.47%'), -0.0047);
approx(parsePercent('−0.47%'), -0.0047);
assert.strictEqual(parsePercent('--'), null);
assert.strictEqual(parsePercent(''), null);

// 501305 验算（计划文档示例）
const nav = 1.2865;
const indexR = parsePercent('-0.47%');
const price = 1.278;
const est = calcEstimate(nav, indexR);
approx(est, 1.2808, 0.0002);
const prem = calcPremium(price, est);
approx(prem, -0.22, 0.05);

assert.strictEqual(parsePercent('-'), null);
assert.strictEqual(parsePercent('—'), null);
assert.strictEqual(isIndexUnavailable('-'), true);
assert.strictEqual(isIndexUnavailable('-0.47%'), false);
assert.strictEqual(formatEstimate(1.2, true), '-');
assert.strictEqual(formatPremium(1.5, true), '-');

assert.strictEqual(parseNumber('1,286.5'), 1286.5);
assert.strictEqual(calcEstimate(null, 0.01), null);

// 会话日：周末回退周五
assert.strictEqual(
  getSessionDayYmd(shanghaiDate(2025, 3, 22)),
  '2025-03-21'
);
assert.strictEqual(
  getSessionDayYmd(shanghaiDate(2025, 3, 23)),
  '2025-03-21'
);
assert.strictEqual(
  getSessionDayYmd(shanghaiDate(2025, 3, 21)),
  '2025-03-21'
);

// 净值日期解析
assert.strictEqual(parseNavDateYmd('03-20', '2025-03-21'), '2025-03-20');
assert.strictEqual(parseNavDateYmd('2025-03-21', '2025-03-21'), '2025-03-21');

// 盘中：净值仍为上一日 → 指数估算
assert.strictEqual(shouldUseIndexEstimate('2025-03-20', '2025-03-21'), true);
// 公布后 / 周末净值已是周五 → 停指数
assert.strictEqual(shouldUseIndexEstimate('2025-03-21', '2025-03-21'), false);
assert.strictEqual(isNavCoversSessionDay('2025-03-21', '2025-03-21'), true);

// 方案 A：相对公布净值溢价
approx(calcPremium(1.278, nav), -0.66, 0.05);

console.log('All tests passed.');
