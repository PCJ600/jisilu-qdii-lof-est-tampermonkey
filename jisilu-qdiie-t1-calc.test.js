const assert = require('assert');
const {
  parsePercent,
  calcT1Estimate,
  calcPremium,
  isIndexUnavailable,
  formatEstimate,
  parseNavDateYmd,
  shouldUseT1IndexEstimate,
  getSessionDayYmd,
} = require('./jisilu-qdiie-t1-calc.js');

function approx(a, b, eps = 1e-3) {
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
}

function shanghaiDate(y, m, d, h = 12) {
  return new Date(Date.UTC(y, m - 1, d, h - 8, 0, 0));
}

// 161127 标普生物科技 LOF（示意）
const t2Nav = 2.0236;
const indexR = parsePercent('0.12%');
const price = 2.009;
const est = calcT1Estimate(t2Nav, indexR);
approx(est, 2.0259, 0.001);
const prem = calcPremium(price, est);
approx(prem, -0.83, 0.15);

assert.strictEqual(isIndexUnavailable('-'), true);
assert.strictEqual(formatEstimate(1.2, true), '-');

assert.strictEqual(parseNavDateYmd('26-07-23', '2026-07-25'), '2026-07-23');
assert.strictEqual(parseNavDateYmd('07-23', '2026-07-25'), '2026-07-23');

const sessionFri = '2026-03-20';
assert.strictEqual(shouldUseT1IndexEstimate('2026-03-18', sessionFri), true);
assert.strictEqual(shouldUseT1IndexEstimate('2026-03-19', sessionFri), false);

const sessionSun = getSessionDayYmd(shanghaiDate(2026, 3, 22));
assert.strictEqual(sessionSun, '2026-03-20');
assert.strictEqual(shouldUseT1IndexEstimate('2026-03-18', sessionSun), true);
assert.strictEqual(shouldUseT1IndexEstimate('2026-03-19', sessionSun), false);

console.log('All tests passed.');
