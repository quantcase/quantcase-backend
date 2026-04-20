/**
 * Fetch concall (earnings call) links from screener.in for a given stock symbol.
 *
 * Usage:
 *   node scripts/fetch-concalls.js                  # read symbols from lib/osc_identity.csv
 *   node scripts/fetch-concalls.js MSUMI ADANIENT   # fetch specific symbols
 *
 * Output: appends rows to scripts/concalls.csv (skips symbols already present in CSV).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const OSC_IDENTITY_CSV = path.join(__dirname, '../lib/osc_identity.csv');
const OUTPUT_CSV = path.join(__dirname, 'concalls.csv');

const CSV_HEADERS = ['id', 'company', 'fiscal_year', 'quarter', 'call_date', 'transcript_url', 'ppt_url'];

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

function escapeCsvValue(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function appendRowsToCsv(symbol, concalls) {
  if (!concalls.length) return;
  const rows = concalls.map((entry) => {
    const row = [
      '',           // id — left empty, DB generates it
      symbol,       // company
      '',           // fiscal_year — not available from screener HTML
      '',           // quarter — not available from screener HTML
      entry.date || '',
      entry.transcriptUrl || '',
      entry.pptUrl || '',
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
 * Extract the concalls section from the full HTML, then parse each <li> entry.
 * Each entry may have: date, transcriptUrl, pptUrl, summaryPath, summaryTitle.
 */
function parseConcalls(html) {
  const sectionMatch = html.match(
    /<div[^>]+class="[^"]*concalls[^"]*"[\s\S]*?<ul[^>]+class="list-links">([\s\S]*?)<\/ul>/
  );
  const listHtml = sectionMatch ? sectionMatch[1] : html;

  const liBlocks = listHtml.split(/<li\s[^>]*class="flex[^"]*">/g).slice(1);

  const results = [];

  for (const block of liBlocks) {
    const entry = {};

    const dateMatch = block.match(
      /<div[^>]+class="[^"]*font-weight-500[^"]*nowrap[^"]*"[^>]*>([\w\s]+)<\/div>/
    );
    if (dateMatch) {
      entry.date = dateMatch[1].trim();
    }

    const anchorRe = /<a\s[^>]*class="concall-link"[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/g;
    let anchorMatch;
    while ((anchorMatch = anchorRe.exec(block)) !== null) {
      const [, href, title, text] = anchorMatch;
      const label = text.trim().toLowerCase();
      if (label === 'transcript') {
        entry.transcriptUrl = href.trim();
        entry.transcriptTitle = title.trim();
      } else if (label === 'ppt') {
        entry.pptUrl = href.trim();
        entry.pptTitle = title.trim();
      }
    }

    const summaryMatch = block.match(
      /<button[^>]+data-url="([^"]+)"[^>]+data-title="([^"]+)"[^>]*>AI Summary<\/button>/
    );
    if (summaryMatch) {
      entry.summaryPath = summaryMatch[1].trim();
      entry.summaryTitle = summaryMatch[2].trim();
    }

    if (entry.date && (entry.transcriptUrl || entry.pptUrl || entry.summaryPath)) {
      results.push(entry);
    }
  }

  return results;
}

async function fetchConcallsForSymbol(symbol) {
  const url = `https://www.screener.in/company/${symbol}/`;
  console.error(`Fetching ${url} ...`);
  const html = await fetchHtml(url);
  const concalls = parseConcalls(html);
  return { symbol, concalls };
}

async function main() {
  const args = process.argv.slice(2);

  let symbols;
  if (args.length > 0) {
    symbols = args.map((s) => s.toUpperCase());
  } else {
    symbols = readSymbolsFromCsv();
    console.error(`Loaded ${symbols.length} symbols from osc_identity.csv`);
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
      const { concalls } = await fetchConcallsForSymbol(symbol);
      appendRowsToCsv(symbol, concalls);
      console.error(`  Saved ${concalls.length} concall entries for ${symbol}`);
    } catch (err) {
      console.error(`  ERROR for ${symbol}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.error('Done.');
}

main();
