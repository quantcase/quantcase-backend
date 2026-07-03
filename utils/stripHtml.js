'use strict';

const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const { jsonrepair } = require('jsonrepair');

// ── Shared bracket/brace scanning ───────────────────────────────────────────

function extractBalanced(str, startIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === openChar) depth++;
    else if (str[i] === closeChar) {
      depth--;
      if (depth === 0) return str.slice(startIdx, i + 1);
    }
  }
  return null;
}

function extractBracketAfter(str, key) {
  const m = str.match(new RegExp(key + '\\s*:\\s*\\['));
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  return extractBalanced(str, openIdx, '[', ']');
}

function parseSimpleArray(bracketStr) {
  const inner = bracketStr.slice(1, -1);
  return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(s => s.length);
}

// ── Chart.js data extraction ────────────────────────────────────────────────
// Generated dashboards sometimes embed the only copy of certain numbers inside
// a Chart.js config's <script> block (e.g. earnings-forecast's Bull/Base/Bear
// series) — not duplicated anywhere in the visible DOM. Dropping <script> wholesale
// would silently lose that data from future incremental context, so charts are
// converted to a markdown table instead of discarded.

// Tolerant of Chart.js's non-JSON object-literal syntax (unquoted keys, single
// quotes, function values in `options`) — extracts only labels/datasets[].label/
// datasets[].data via balanced-bracket scanning rather than JSON.parse.
function extractChartTablesFromScript(js) {
  const tables = [];
  const chartRegex = /new Chart\(/g;
  let m;
  while ((m = chartRegex.exec(js))) {
    const nextChartIdx = js.indexOf('new Chart(', m.index + 1);
    const segment = js.slice(m.index, nextChartIdx === -1 ? js.length : nextChartIdx);

    const labelsArr = extractBracketAfter(segment, 'labels');
    const datasetsArr = extractBracketAfter(segment, 'datasets');
    if (!labelsArr || !datasetsArr) continue;
    const labels = parseSimpleArray(labelsArr);

    const inner = datasetsArr.slice(1, -1);
    const objs = [];
    let depth = 0, start = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (inner[i] === '}') { depth--; if (depth === 0) objs.push(inner.slice(start, i + 1)); }
    }

    const rows = [];
    for (const obj of objs) {
      const labelMatch = obj.match(/label\s*:\s*['"]([^'"]*)['"]/);
      const dataArr = extractBracketAfter(obj, 'data');
      if (!labelMatch || !dataArr) continue;
      rows.push({ label: labelMatch[1], data: parseSimpleArray(dataArr) });
    }
    if (rows.length) tables.push({ labels, rows });
  }
  return tables;
}

function chartTablesToMarkdown(tables) {
  return tables.map(t => {
    const header = `| Series | ${t.labels.join(' | ')} |`;
    const sep    = `| --- | ${t.labels.map(() => '---').join(' | ')} |`;
    const rows   = t.rows.map(r => `| ${r.label} | ${r.data.join(' | ')} |`);
    return [header, sep, ...rows].join('\n');
  }).join('\n\n');
}

// ── Generic data-object extraction ──────────────────────────────────────────
// Some generated dashboards are entirely client-side-templated: the static HTML
// body is near-empty and the real analysis lives in a `const D = {...}`-style
// object literal that JS renders into the DOM at runtime. That object is the
// ONLY copy of the content — dropping non-chart <script> tags wholesale (as a
// naive stripper does) silently loses the entire analysis, not just decoration.

// Heuristic: real UI-logic scripts (toggle handlers etc.) have few or no
// object-literal-style `key:` tokens. Data blobs have many. 3+ is a safe floor —
// verified against ~1,000 real generated scripts with zero false positives.
function looksLikeDataObject(js) {
  const colonKeys = js.match(/[{,]\s*[A-Za-z_$][\w$]*\s*:/g);
  return !!colonKeys && colonKeys.length >= 3;
}

function extractObjectLiteral(js) {
  const eqIdx = js.indexOf('=');
  if (eqIdx === -1) return null;
  const braceIdx = js.indexOf('{', eqIdx);
  if (braceIdx === -1) return null;
  return extractBalanced(js, braceIdx, '{', '}');
}

function flattenToLines(value, prefix, lines) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenToLines(v, `${prefix}[${i}]`, lines));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flattenToLines(v, prefix ? `${prefix}.${k}` : k, lines);
    }
  } else if (value !== null && value !== '') {
    lines.push(`${prefix}: ${value}`);
  }
  return lines;
}

// Renders a script's embedded data — as flattened key:value lines when the
// repair+parse succeeds, or as a raw fenced code block when it doesn't, so the
// content always reaches the LLM in some form rather than being dropped.
// jsonrepair (not a hand-rolled regex) — real generated literals commonly have
// unescaped quotes nested inside string values (the LLM's own generation
// quirk, e.g. `interp:"...based on "line of sight" for..."`), which a simple
// key-quoting/quote-swapping regex can't fix. Audited against all 14 real
// data-object scripts in the DB: jsonrepair parses 14/14; the regex approach
// it replaced only got 3/14.
function dataScriptToText(js) {
  const literal = extractObjectLiteral(js);
  if (!literal) return `\n\n\`\`\`\n${js.trim()}\n\`\`\`\n\n`;
  try {
    const parsed = JSON.parse(jsonrepair(literal));
    const lines  = flattenToLines(parsed, '', []);
    return lines.length ? `\n\n${lines.join('\n')}\n\n` : '';
  } catch {
    return `\n\n\`\`\`\n${literal}\n\`\`\`\n\n`;
  }
}

// ── Turndown setup ───────────────────────────────────────────────────────────

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.use(gfm);
turndown.remove('style');
turndown.addRule('scripts', {
  filter: 'script',
  replacement: (_content, node) => {
    const js = node.textContent || '';
    const chartTables = extractChartTablesFromScript(js);
    if (chartTables.length) return `\n\n${chartTablesToMarkdown(chartTables)}\n\n`;
    if (looksLikeDataObject(js)) return dataScriptToText(js);
    return '';
  },
});

// Fallback for anything turndown/turndown-plugin-gfm can't handle — real
// generated HTML is LLM output, not hand-authored, so it occasionally has
// malformed markup (e.g. a stray <tr> with no <table> parent) that crashes
// turndown-plugin-gfm's table rule. A crash here must never fail the whole
// incremental run — better a plain-text-only strip than a hard failure.
function fallbackFlatStrip(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Convert an HTML dashboard into markdown for use as prior-analysis context in
 * a later LLM call — preserves headings, tables, emphasis, embedded chart data
 * and client-side-templated data objects that a flat whitespace-strip would
 * destroy. Name kept as stripHtmlToText for callers; output is markdown, not
 * literal plain text.
 */
function stripHtmlToText(html) {
  if (!html) return '';
  let text;
  try {
    text = turndown.turndown(html);
  } catch {
    text = fallbackFlatStrip(html);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { stripHtmlToText };
