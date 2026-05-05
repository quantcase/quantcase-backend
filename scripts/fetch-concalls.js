/**
 * Fetch concall, annual report, and credit rating links from screener.in.
 *
 * Usage:
 *   node scripts/fetch-concalls.js                       # read symbols from lib/osc_identity.csv
 *   node scripts/fetch-concalls.js MSUMI ADANIENT        # fetch specific symbols
 *   node scripts/fetch-concalls.js --test                # process first 3 symbols only (validation)
 *   node scripts/fetch-concalls.js --test MSUMI RELIANCE # --test also works with explicit symbols
 *
 * Output: appends rows to scripts/concalls.csv (skips symbols already present in CSV).
 * Columns: id, company, fiscal_year, quarter, call_date, transcript_url, ppt_url, summary_url, document_type
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const OSC_IDENTITY_CSV = path.join(__dirname, '../lib/osc_identity.csv');
const OUTPUT_CSV = path.join(__dirname, 'concalls.csv');

const CSV_HEADERS = [
  'id', 'company', 'document_type', 'fiscal_year', 'quarter', 'call_date',
  'transcript_url', 'ppt_url', 'summary_url',
];

function readSymbolsFromCsv() {
  const content = fs.readFileSync(OSC_IDENTITY_CSV);
  const records = parse(content, { columns: true, skip_empty_lines: true, bom: true });
  return records
    .map((r) => (r['NSE symbol'] || '').trim())
    .filter(Boolean);
}

function readAlreadyFetchedSymbols() {
  if (!fs.existsSync(OUTPUT_CSV)) return new Set();
  const content = fs.readFileSync(OUTPUT_CSV, 'utf8');
  const lines = content.split('\n').slice(1); // skip header
  const symbols = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // company is the second column (index 1)
    const cols = trimmed.split(',');
    if (cols[1]) symbols.add(cols[1].replace(/"/g, '').trim());
  }
  return symbols;
}

function ensureCsvHeader() {
  if (!fs.existsSync(OUTPUT_CSV)) {
    fs.writeFileSync(OUTPUT_CSV, CSV_HEADERS.join(',') + '\n', 'utf8');
  }
}

function countExistingRows() {
  if (!fs.existsSync(OUTPUT_CSV)) return 0;
  const content = fs.readFileSync(OUTPUT_CSV, 'utf8');
  return content.split('\n').slice(1).filter((l) => l.trim()).length;
}

function escapeCsvValue(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function appendRowsToCsv(symbol, entries) {
  if (!entries.length) return;
  let nextId = countExistingRows() + 1;
  const rows = entries.map((entry) => {
    const row = [
      nextId++,
      symbol,
      entry.documentType || '',
      '',                       // fiscal_year — not available from screener HTML
      '',                       // quarter — not available from screener HTML
      entry.date || '',
      entry.transcriptUrl || '',
      entry.pptUrl || '',
      entry.summaryUrl || '',
    ];
    return row.map(escapeCsvValue).join(',');
  });
  fs.appendFileSync(OUTPUT_CSV, rows.join('\n') + '\n', 'utf8');
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    https
      .get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(fetchHtml(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Extract a named section's <ul class="list-links"> HTML.
 * Finds the section div by its CSS class fragment, then returns the inner list HTML.
 */
function extractSectionList(html, sectionClass) {
  const divIdx = html.indexOf(`class="documents ${sectionClass}`);
  if (divIdx === -1) return null;
  const ulStart = html.indexOf('<ul class="list-links">', divIdx);
  const ulEnd = html.indexOf('</ul>', ulStart);
  if (ulStart === -1 || ulEnd === -1) return null;
  return html.slice(ulStart, ulEnd + 5);
}

/**
 * Parse concalls section.
 *
 * Each <li class="flex flex-gap-8 flex-wrap-420"> contains:
 *   - date: <div class="... font-weight-500 nowrap ...">Apr 2026</div>
 *   - transcript: <a class="concall-link" href="...">Transcript</a>
 *                 OR <div class="concall-link">Transcript</div> when unavailable
 *   - AI summary: <button class="concall-link" data-url="/concalls/summary/123/">AI Summary</button>
 *                 OR <div class="concall-link">AI Summary</div> when unavailable
 *   - PPT:        <a class="concall-link" href="...">PPT</a>
 *                 OR <div class="concall-link">PPT</div> when unavailable
 */
function parseConcalls(html) {
  const listHtml = extractSectionList(html, 'concalls');
  if (!listHtml) return [];

  const liBlocks = listHtml.split(/<li\b[^>]*class="flex[^"]*flex-gap[^"]*"[^>]*>/g).slice(1);
  const results = [];

  for (const block of liBlocks) {
    const entry = { documentType: 'concall' };

    const dateMatch = block.match(/<div[^>]*font-weight-500[^>]*nowrap[^>]*>\s*([^<]+?)\s*<\/div>/);
    if (dateMatch) entry.date = dateMatch[1].trim();

    // Anchors: href may appear before or after class attribute
    const anchorRe = /<a\b([^>]*)>\s*([^<]+?)\s*<\/a>/g;
    let m;
    while ((m = anchorRe.exec(block)) !== null) {
      const [, attrs, label] = m;
      if (!attrs.includes('concall-link')) continue;
      const hrefMatch = attrs.match(/href="([^"]+)"/);
      if (!hrefMatch) continue;
      const key = label.trim().toLowerCase();
      if (key === 'transcript') entry.transcriptUrl = hrefMatch[1].trim();
      else if (key === 'ppt') entry.pptUrl = hrefMatch[1].trim();
    }

    // AI Summary button — data-url may appear anywhere in the tag attributes
    const summaryMatch = block.match(/<button\b([^>]*)>\s*AI Summary\s*<\/button>/);
    if (summaryMatch && summaryMatch[1].includes('concall-link')) {
      const dataUrlMatch = summaryMatch[1].match(/data-url="([^"]+)"/);
      if (dataUrlMatch) {
        const p = dataUrlMatch[1].trim();
        entry.summaryUrl = p.startsWith('http') ? p : `https://www.screener.in${p}`;
      }
    }

    if (entry.date && (entry.transcriptUrl || entry.pptUrl || entry.summaryUrl)) {
      results.push(entry);
    }
  }

  return results;
}

/**
 * Parse annual reports section.
 *
 * Each <li> contains a single <a href="..." class="plausible-event-name=Annual+Report ...">
 *   Financial Year YYYY
 *   <div class="ink-600 smaller">from bse</div>
 * </a>
 */
function parseAnnualReports(html) {
  const listHtml = extractSectionList(html, 'annual-reports');
  if (!listHtml) return [];

  const liBlocks = listHtml.split(/<li\b[^>]*>/g).slice(1);
  const results = [];

  for (const block of liBlocks) {
    const anchorMatch = block.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
    if (!anchorMatch) continue;
    const [, attrs, inner] = anchorMatch;
    if (!attrs.includes('Annual+Report')) continue;

    const hrefMatch = attrs.match(/href="([^"]+)"/);
    if (!hrefMatch) continue;

    // Title text is everything before the first nested tag
    const titleMatch = inner.match(/^\s*([^<]+?)\s*</);
    const date = titleMatch ? titleMatch[1].trim() : '';

    results.push({
      documentType: 'annual_report',
      date,
      transcriptUrl: hrefMatch[1].trim(),
      pptUrl: '',
      summaryUrl: '',
    });
  }

  return results;
}

/**
 * Parse credit ratings section.
 *
 * Each <li> contains a single <a href="..." class="plausible-event-name=Credit+Rating ...">
 *   Rating update
 *   <div class="ink-600 smaller">1 Oct 2025 from crisil</div>
 * </a>
 */
function parseCreditRatings(html) {
  const listHtml = extractSectionList(html, 'credit-ratings');
  if (!listHtml) return [];

  const liBlocks = listHtml.split(/<li\b[^>]*>/g).slice(1);
  const results = [];

  for (const block of liBlocks) {
    const anchorMatch = block.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
    if (!anchorMatch) continue;
    const [, attrs, inner] = anchorMatch;
    if (!attrs.includes('Credit+Rating')) continue;

    const hrefMatch = attrs.match(/href="([^"]+)"/);
    if (!hrefMatch) continue;

    // Date + source are in the inner <div class="ink-600 smaller">
    const metaMatch = inner.match(/<div[^>]*smaller[^>]*>\s*([^<]+?)\s*<\/div>/);
    const date = metaMatch ? metaMatch[1].trim() : '';

    results.push({
      documentType: 'credit_rating',
      date,
      transcriptUrl: hrefMatch[1].trim(),
      pptUrl: '',
      summaryUrl: '',
    });
  }

  return results;
}

async function fetchAllForSymbol(symbol) {
  const url = `https://www.screener.in/company/${symbol}/`;
  console.error(`Fetching ${url} ...`);
  const html = await fetchHtml(url);

  const concalls = parseConcalls(html);
  const annualReports = parseAnnualReports(html);
  const creditRatings = parseCreditRatings(html);

  return { symbol, concalls, annualReports, creditRatings };
}

async function main() {
  const args = process.argv.slice(2);

  // --test flag: process only first 3 symbols (for validation)
  const testMode = args.includes('--test');
  const symbolArgs = args.filter((a) => a !== '--test');

  let symbols;
  if (symbolArgs.length > 0) {
    symbols = symbolArgs.map((s) => s.toUpperCase());
  } else {
    symbols = readSymbolsFromCsv();
    console.error(`Loaded ${symbols.length} symbols from osc_identity.csv`);
  }

  if (testMode) {
    symbols = symbols.slice(0, 3);
    console.error(`--test mode: processing first ${symbols.length} symbols`);
  }

  ensureCsvHeader();
  const alreadyFetched = readAlreadyFetchedSymbols();
  console.error(`Skipping ${alreadyFetched.size} symbols already in CSV`);

  for (const symbol of symbols) {
    if (alreadyFetched.has(symbol)) {
      console.error(`  Skipping ${symbol} (already in CSV)`);
      continue;
    }
    try {
      const { concalls, annualReports, creditRatings } = await fetchAllForSymbol(symbol);
      const all = [...concalls, ...annualReports, ...creditRatings];
      appendRowsToCsv(symbol, all);
      console.error(
        `  Saved ${concalls.length} concalls, ${annualReports.length} annual reports, ${creditRatings.length} credit ratings for ${symbol}`
      );
    } catch (err) {
      console.error(`  ERROR for ${symbol}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.error('Done.');
}

main();
