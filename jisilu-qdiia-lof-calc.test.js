const assert = require('assert');
const {
  parsePercent,
  parseNumber,
  calcEstimate,
  calcPremium,
  isLofName,
} = require('./jisilu-qdiia-lof-calc.js');

function approx(a, b, eps = 1e-4) {
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
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

assert.strictEqual(isLofName('港股高股息LOF'), true);
assert.strictEqual(isLofName('港股通ETF'), false);

assert.strictEqual(parseNumber('1,286.5'), 1286.5);
assert.strictEqual(calcEstimate(null, 0.01), null);

console.log('All tests passed.');
