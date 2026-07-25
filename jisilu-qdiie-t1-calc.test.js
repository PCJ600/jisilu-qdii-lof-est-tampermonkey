const assert = require('assert');
const {
  parsePercent,
  calcT1Estimate,
  calcPremium,
  isIndexUnavailable,
  formatEstimate,
} = require('./jisilu-qdiie-t1-calc.js');

function approx(a, b, eps = 1e-3) {
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
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

console.log('All tests passed.');
