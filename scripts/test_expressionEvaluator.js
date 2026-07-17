'use strict';

/**
 * Lightweight, dependency-free unit tests for
 * utils/formulaRegistry/expressionEvaluator.js — the repo has no test
 * framework configured (no jest/mocha, no test script in package.json), so
 * this follows the existing convention of plain node scripts under scripts/.
 *
 * Usage: node scripts/test_expressionEvaluator.js
 */

const assert = require('assert');
const { parse, evaluate, validate, collectReferences, ExpressionError } = require('../utils/formulaRegistry/expressionEvaluator');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

const noopResolvers = {
  resolveRef: async () => null,
  resolveAggregate: async () => null,
  resolveDelta: async () => null,
};

async function main() {
  console.log('expressionEvaluator tests:');

  await atest('basic arithmetic (EBITDA_MARGIN-style formula)', async () => {
    const ast = parse('(PBT + FIN_COST + DEP_AMORT) / REV_OP * 100');
    const kpiMap = { PBT: 100, FIN_COST: 20, DEP_AMORT: 30, REV_OP: 1000 };
    const r = await evaluate(ast, { ...noopResolvers, resolveRef: async (a) => kpiMap[a] ?? null });
    assert.strictEqual(r, 15);
  });

  await atest('null propagation on binop', async () => {
    const ast = parse('A / B');
    const r = await evaluate(ast, { ...noopResolvers, resolveRef: async (a) => (a === 'A' ? 10 : null) });
    assert.strictEqual(r, null);
  });

  await atest('division by zero returns null, not Infinity', async () => {
    const ast = parse('A / B');
    const r = await evaluate(ast, { ...noopResolvers, resolveRef: async (a) => (a === 'A' ? 10 : 0) });
    assert.strictEqual(r, null);
  });

  await atest('unary minus', async () => {
    const ast = parse('-A * 2');
    const r = await evaluate(ast, { ...noopResolvers, resolveRef: async () => 5 });
    assert.strictEqual(r, -10);
  });

  await atest('CAGR/AVG/SUM route to resolveAggregate with abbr + window', async () => {
    let captured = null;
    const ast = parse('CAGR(EPS_BASIC, 3)');
    const r = await evaluate(ast, {
      ...noopResolvers,
      resolveAggregate: async (fn, abbr, window) => { captured = { fn, abbr, window }; return 12.34; },
    });
    assert.strictEqual(r, 12.34);
    assert.deepStrictEqual(captured, { fn: 'CAGR', abbr: 'EPS_BASIC', window: 3 });
  });

  await atest('CAGR with no window arg passes window=null (full series)', async () => {
    let capturedWindow = 'unset';
    const ast = parse('CAGR(REV_OP)');
    await evaluate(ast, { ...noopResolvers, resolveAggregate: async (fn, abbr, window) => { capturedWindow = window; return 1; } });
    assert.strictEqual(capturedWindow, null);
  });

  await atest('MAX + DELTA + COALESCE (CAPEX-style, negative sum floors to 0)', async () => {
    const ast = parse('MAX(0, COALESCE(DELTA(A), 0) + COALESCE(DELTA(B), 0))');
    const r = await evaluate(ast, { ...noopResolvers, resolveDelta: async (abbr) => (abbr === 'A' ? -50 : -30) });
    assert.strictEqual(r, 0);
  });

  await atest('MAX + DELTA + COALESCE (CAPEX-style, positive sum passes through)', async () => {
    const ast = parse('MAX(0, COALESCE(DELTA(A), 0) + COALESCE(DELTA(B), 0))');
    const r = await evaluate(ast, { ...noopResolvers, resolveDelta: async (abbr) => (abbr === 'A' ? 50 : 30) });
    assert.strictEqual(r, 80);
  });

  await atest('COALESCE(DELTA(x), 0) treats a missing component as 0, not null-propagating', async () => {
    const ast = parse('COALESCE(DELTA(A), 0) + COALESCE(DELTA(B), 0)');
    const r = await evaluate(ast, { ...noopResolvers, resolveDelta: async (abbr) => (abbr === 'A' ? null : 30) });
    assert.strictEqual(r, 30);
  });

  await atest('MAX/MIN null-propagate (unlike COALESCE) when any arg is null', async () => {
    const ast = parse('MAX(A, B)');
    const r = await evaluate(ast, { ...noopResolvers, resolveRef: async (a) => (a === 'A' ? 5 : null) });
    assert.strictEqual(r, null);
  });

  test('rejects CAGR/AVG/SUM/DELTA with a non-bare-ref first argument', () => {
    assert.throws(() => parse('CAGR(A + B, 3)'), ExpressionError);
    assert.throws(() => parse('DELTA(A + B)'), ExpressionError);
  });

  test('rejects unknown functions', () => {
    assert.throws(() => parse('FOO(A)'), ExpressionError);
  });

  test('rejects malformed expressions', () => {
    assert.throws(() => parse('A +'), ExpressionError);
    assert.throws(() => parse('A + (B'), ExpressionError);
    assert.throws(() => parse(''), ExpressionError);
  });

  test('collectReferences finds refs inside nested function calls', () => {
    const { refs } = validate('(PBT + FIN_COST) / REV_OP + CAGR(EPS_BASIC, 3) + MAX(A, COALESCE(B, 0))');
    assert.deepStrictEqual([...refs].sort(), ['A', 'B', 'EPS_BASIC', 'FIN_COST', 'PBT', 'REV_OP']);
  });

  test('operator precedence and parentheses', () => {
    assert.deepStrictEqual(collectReferences(parse('A + B * C')), ['A', 'B', 'C']); // just sanity that it parses
  });

  await atest('precedence: 2 + 3 * 4 = 14, not 20', async () => {
    const ast = parse('X + Y * Z');
    const r = await evaluate(ast, { ...noopResolvers, resolveRef: async (a) => ({ X: 2, Y: 3, Z: 4 }[a]) });
    assert.strictEqual(r, 14);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}

main();
