'use strict';

/**
 * Generic arithmetic expression parser/evaluator for admin-defined KPI
 * formulas (Kpi.formula_expression). Deliberately minimal and closed —
 * numbers, +-*\/ , parentheses, unary minus, bare metric references, and a
 * fixed set of built-in aggregate functions. Never eval()/new Function()/vm —
 * admin-supplied strings must never reach JS execution.
 *
 * Grammar:
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := '-' factor | primary
 *   primary:= NUMBER | call | ref | '(' expr ')'
 *   call   := IDENT '(' expr (',' expr)* ')'
 *   ref    := IDENT
 *
 * Built-in functions (fixed, not admin-extensible — the syntax is code, the
 * arguments are what's admin-defined):
 *   CAGR(abbr, window?)  — CAGR of abbr's series over `window` periods (omitted = full series)
 *   AVG(abbr, window?)   — arithmetic mean over `window` periods
 *   SUM(abbr, window?)   — sum over `window` periods
 *   DELTA(abbr)          — current period value − previous period value
 *   MAX(a, b, ...)        MIN(a, b, ...) — generic; args are arbitrary sub-expressions; null if ANY arg is null
 *   COALESCE(a, b, ...)  — first non-null argument (SQL-style); null only if ALL args are null.
 *                          Use to treat a missing component as 0 rather than
 *                          null-propagating the whole expression, e.g.
 *                          COALESCE(DELTA(X), 0).
 *
 * CAGR/AVG/SUM/DELTA's first argument must be a bare metric reference (not a
 * general expression) — that's what lets the resolver know which abbr/window
 * to fetch a series for, enforced at parse time.
 */

const IDENT_RE          = /^[A-Z][A-Z0-9_]*$/;
const AGGREGATE_FNS      = new Set(['CAGR', 'AVG', 'SUM']);
const SERIES_FUNCTIONS   = new Set(['CAGR', 'AVG', 'SUM', 'DELTA']);
const VARIADIC_FUNCTIONS = new Set(['MAX', 'MIN', 'COALESCE']);
const ALL_FUNCTIONS      = new Set([...SERIES_FUNCTIONS, ...VARIADIC_FUNCTIONS]);

class ExpressionError extends Error {
  constructor(message, pos) {
    super(pos != null ? `${message} (at position ${pos})` : message);
    this.name = 'ExpressionError';
    this.pos = pos;
  }
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(text)) throw new ExpressionError(`Invalid number "${text}"`, i);
      tokens.push({ type: 'num', value: parseFloat(text), pos: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const text = src.slice(i, j);
      tokens.push({ type: 'ident', value: text.toUpperCase(), pos: i });
      i = j;
      continue;
    }

    if ('+-*/(),'.includes(c)) {
      tokens.push({ type: c, pos: i });
      i++;
      continue;
    }

    throw new ExpressionError(`Unexpected character "${c}"`, i);
  }
  tokens.push({ type: 'eof', pos: n });
  return tokens;
}

// ── Parser (recursive descent) ─────────────────────────────────────────────

function parse(src) {
  if (typeof src !== 'string' || !src.trim()) {
    throw new ExpressionError('Expression is empty');
  }
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type) => {
    const t = next();
    if (t.type !== type) throw new ExpressionError(`Expected "${type}" but got "${t.type}"`, t.pos);
    return t;
  };

  function parseExpr() {
    let node = parseTerm();
    while (peek().type === '+' || peek().type === '-') {
      const op = next().type;
      node = { type: 'binop', op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseFactor();
    while (peek().type === '*' || peek().type === '/') {
      const op = next().type;
      node = { type: 'binop', op, left: node, right: parseFactor() };
    }
    return node;
  }

  function parseFactor() {
    if (peek().type === '-') {
      next();
      return { type: 'unary', op: '-', arg: parseFactor() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();

    if (t.type === 'num') { next(); return { type: 'num', value: t.value }; }

    if (t.type === '(') {
      next();
      const node = parseExpr();
      expect(')');
      return node;
    }

    if (t.type === 'ident') {
      next();
      if (peek().type === '(') {
        next(); // consume '('
        const name = t.value;
        if (!ALL_FUNCTIONS.has(name)) throw new ExpressionError(`Unknown function "${name}"`, t.pos);

        const args = [];
        if (peek().type !== ')') {
          args.push(parseExpr());
          while (peek().type === ',') { next(); args.push(parseExpr()); }
        }
        expect(')');

        if (SERIES_FUNCTIONS.has(name)) {
          if (!args.length || args[0].type !== 'ref') {
            throw new ExpressionError(`${name}(...) requires a bare metric reference as its first argument`, t.pos);
          }
          if (name === 'DELTA' && args.length > 1) {
            throw new ExpressionError('DELTA(...) takes exactly one argument', t.pos);
          }
          if (AGGREGATE_FNS.has(name) && args.length > 2) {
            throw new ExpressionError(`${name}(...) takes at most 2 arguments (abbr, window)`, t.pos);
          }
        }
        if (VARIADIC_FUNCTIONS.has(name) && args.length < 1) {
          throw new ExpressionError(`${name}(...) requires at least one argument`, t.pos);
        }

        return { type: 'call', name, args };
      }

      if (!IDENT_RE.test(t.value)) throw new ExpressionError(`Invalid metric reference "${t.value}"`, t.pos);
      return { type: 'ref', abbr: t.value };
    }

    throw new ExpressionError(`Unexpected token "${t.type}"`, t.pos);
  }

  const ast = parseExpr();
  expect('eof');
  return ast;
}

// ── Reference collection (for admin write-time validation) ─────────────────

/** All metric abbrs referenced anywhere in the AST, including inside function calls. */
function collectReferences(ast) {
  const refs = new Set();
  (function walk(node) {
    if (!node) return;
    if (node.type === 'ref')   { refs.add(node.abbr); return; }
    if (node.type === 'unary') { walk(node.arg); return; }
    if (node.type === 'binop') { walk(node.left); walk(node.right); return; }
    if (node.type === 'call')  { for (const a of node.args) walk(a); return; }
  })(ast);
  return [...refs];
}

/** Parse + collect references in one call; throws ExpressionError on bad syntax. */
function validate(src) {
  const ast = parse(src);
  return { ast, refs: collectReferences(ast) };
}

// ── Evaluator ────────────────────────────────────────────────────────────────

/**
 * @param {object} ast - result of parse()
 * @param {object} resolvers
 * @param {(abbr: string) => Promise<number|null>} resolvers.resolveRef - current-period value
 * @param {(fnName: 'CAGR'|'AVG'|'SUM', abbr: string, window: number|null) => Promise<number|null>} resolvers.resolveAggregate
 * @param {(abbr: string) => Promise<number|null>} resolvers.resolveDelta - current − previous period
 * @returns {Promise<number|null>}
 */
async function evaluate(ast, resolvers) {
  const { resolveRef, resolveAggregate, resolveDelta } = resolvers;

  async function ev(node) {
    switch (node.type) {
      case 'num': return node.value;
      case 'ref': return await resolveRef(node.abbr);
      case 'unary': {
        const v = await ev(node.arg);
        return v == null ? null : -v;
      }
      case 'binop': {
        const l = await ev(node.left);
        const r = await ev(node.right);
        if (l == null || r == null) return null;
        switch (node.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return r === 0 ? null : l / r;
          default:  throw new ExpressionError(`Unknown operator "${node.op}"`);
        }
      }
      case 'call': return await evalCall(node);
      default: throw new ExpressionError(`Unknown node type "${node.type}"`);
    }
  }

  async function evalWindowArg(args) {
    if (args.length < 2) return null; // no window arg = full series
    const w = await ev(args[1]);
    return w == null ? null : Math.trunc(w);
  }

  async function evalCall(node) {
    const { name, args } = node;

    if (AGGREGATE_FNS.has(name)) {
      const window = await evalWindowArg(args);
      return resolveAggregate(name, args[0].abbr, window);
    }
    if (name === 'DELTA') {
      return resolveDelta(args[0].abbr);
    }
    if (name === 'MAX' || name === 'MIN') {
      const vals = [];
      for (const a of args) {
        const v = await ev(a);
        if (v == null) return null; // null propagation — every arg must be present
        vals.push(v);
      }
      return name === 'MAX' ? Math.max(...vals) : Math.min(...vals);
    }
    if (name === 'COALESCE') {
      for (const a of args) {
        const v = await ev(a);
        if (v != null) return v; // first non-null wins; null only if all args are null
      }
      return null;
    }
    throw new ExpressionError(`Unknown function "${name}"`);
  }

  return ev(ast);
}

module.exports = { ExpressionError, tokenize, parse, collectReferences, validate, evaluate };
