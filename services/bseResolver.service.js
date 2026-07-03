'use strict';

/**
 * BSE URL resolver — runs on Server 2 as part of the bse-discovery scheduler job.
 *
 * For each BSE AttachHis URL:
 *   1. Try to download the PDF (BSE CDN has ~hours propagation delay — 404 is normal for new filings)
 *   2. If unresolvable (404, timeout, non-PDF) → keep original URL unchanged, resolve manually later
 *   3. If PDF is a cover letter (detected by text patterns) → extract embedded URLs and add them
 *   4. If PDF is the actual document → original URL is sufficient
 *
 * Result: arrays always contain at least the original BSE URL; cover-letter PDFs
 * additionally contain the real document URLs extracted from their text.
 */

const https = require('https');
const http  = require('http');

const DOWNLOAD_TIMEOUT_MS  = 20_000;
const SLEEP_BETWEEN_DL_MS  = 400;

// BSE serves new filings on AttachLive/, archives them to AttachHis/ after a few days.
// The scraper always builds AttachLive/ URLs. For archived docs already in DB, they
// may be on AttachHis/. The resolver transparently handles both.
const ATTACH_LIVE    = 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/';
const ATTACH_ARCHIVE = 'https://www.bseindia.com/xml-data/corpfiling/AttachHis/';

function bseArchiveFallback(url) {
  if (url.startsWith(ATTACH_LIVE)) return url.replace(ATTACH_LIVE, ATTACH_ARCHIVE);
  if (url.startsWith(ATTACH_ARCHIVE)) return url.replace(ATTACH_ARCHIVE, ATTACH_LIVE);
  return null;
}

// Phrases that indicate the PDF is a cover letter referencing the real document elsewhere
const COVER_LETTER_RE = /submitted the link|audio[\s\/]?video recording|recording available|please find the link|find the link|link to the (?:audio|video|recording|transcript)|link.*(?:audio|video|recording)|(?:audio|video|recording).*link|access the (?:transcript|recording|video|audio)/i;

// Minimum URL length to avoid noise (excludes things like http://www.x.com = 18 chars)
const MIN_URL_LEN = 25;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchBuffer(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error('too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'Referer':    'https://www.bseindia.com/',
        'Origin':     'https://www.bseindia.com',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location, depth + 1).then(resolve).catch(reject);
      }
      if (res.statusCode === 404 || res.statusCode === 403) {
        res.resume();
        return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { httpStatus: res.statusCode }));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractUrlsFromText(text) {
  const matches = text.match(/https?:\/\/[^\s"'<>()\[\]{}|\\^`]{20,}/g) || [];
  return [...new Set(
    matches
      .map(u => u.replace(/[.,;:!?)]+$/, '')) // strip trailing punctuation
      .filter(u => u.length >= MIN_URL_LEN && !u.includes('bseindia.com')) // exclude BSE self-references
  )];
}

/**
 * Attempt to resolve a single BSE URL (AttachLive/ or AttachHis/).
 * Tries the given URL first; if 404, tries the other base path automatically.
 *
 * @param {string} bseUrl — original BSE URL (AttachLive/ preferred for new docs)
 * @returns {Promise<string[]>} — array of URLs to store (always includes bseUrl)
 */
async function resolveUrl(bseUrl) {
  let buf;
  let resolvedFrom = bseUrl;

  try {
    buf = await fetchBuffer(bseUrl);
  } catch (err) {
    // Try the alternate base path (Live ↔ Archive) before giving up
    const alternate = bseArchiveFallback(bseUrl);
    if (alternate) {
      try {
        buf = await fetchBuffer(alternate);
        resolvedFrom = alternate;
      } catch {
        // Both paths failed — keep original URL for manual resolution
        console.log(`[bse-resolver] unresolvable (both Live+Archive) ${bseUrl.slice(-40)}`);
        return [bseUrl];
      }
    } else {
      console.log(`[bse-resolver] unresolvable ${bseUrl.slice(-40)} — ${err.message}`);
      return [bseUrl];
    }
  }

  // Verify it's actually a PDF
  if (buf.slice(0, 5).toString('ascii') !== '%PDF-') {
    console.log(`[bse-resolver] non-PDF response for ${bseUrl.slice(-40)}`);
    return [bseUrl];
  }

  // If we resolved from the alternate path, store that URL instead (it's the working one)
  // but also keep the original so both are available
  const urlsToReturn = resolvedFrom !== bseUrl ? [bseUrl, resolvedFrom] : [bseUrl];

  let text = '';
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const pdf      = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const scanPages = Math.min(3, pdf.numPages);
    const parts = [];
    for (let i = 1; i <= scanPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map(x => x.str).join(' '));
    }
    text = parts.join('\n').replace(/\s+/g, ' ');
  } catch {
    // PDF parse error — keep original
    return [bseUrl];
  }

  if (!COVER_LETTER_RE.test(text)) {
    // PDF is the actual document
    return urlsToReturn;
  }

  // Cover letter — extract embedded URLs then chain-resolve each one:
  //   200 + PDF  → actual document, keep
  //   200 + !PDF → webpage / login page, discard
  //   4xx/timeout → uncertain (might be a direct PDF not yet reachable), keep
  const extracted = extractUrlsFromText(text);
  if (!extracted.length) {
    console.log(`[bse-resolver] cover letter but no URLs extracted from ${bseUrl.slice(-40)}`);
    return urlsToReturn;
  }

  const chainResults = await Promise.all(extracted.map(async u => {
    let chainBuf;
    try {
      chainBuf = await fetchBuffer(u);
    } catch (err) {
      if (err.httpStatus === 403) return null; // blocked, not useful
      return u; // 404 / timeout → keep as candidate
    }
    return chainBuf.slice(0, 5).toString('ascii') === '%PDF-' ? u : null;
  }));

  const kept = chainResults.filter(Boolean);
  if (kept.length) {
    console.log(`[bse-resolver] cover letter → ${kept.length}/${extracted.length} PDF(s) confirmed from ${bseUrl.slice(-40)}`);
  } else {
    console.log(`[bse-resolver] cover letter → 0/${extracted.length} were PDFs (all discarded) from ${bseUrl.slice(-40)}`);
  }
  return [...new Set([...urlsToReturn, ...kept])];
}

/**
 * Resolve an array of BSE URLs, returning a flat deduplicated array.
 * Sleeps between downloads to avoid hammering the CDN.
 */
async function resolveUrlArray(urls) {
  const all = [];
  const seen = new Set();

  for (let i = 0; i < urls.length; i++) {
    if (i > 0) await sleep(SLEEP_BETWEEN_DL_MS);
    const resolved = await resolveUrl(urls[i]);
    for (const u of resolved) {
      if (!seen.has(u)) { seen.add(u); all.push(u); }
    }
  }

  return all;
}

module.exports = { resolveUrl, resolveUrlArray };
