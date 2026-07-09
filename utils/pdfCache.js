'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.resolve(__dirname, '../tmp/pdf-cache');
const MAX_CACHE_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5GB

function urlToFilename(url) {
  return crypto.createHash('sha256').update(url).digest('hex') + '.pdf';
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Deletes oldest cached PDFs (by mtime) until the cache dir is back under MAX_CACHE_BYTES.
 * Runs on every cache miss, so a burst of concurrent workers may race on unlink — ignored,
 * since a missing file just means the next request for it re-downloads.
 */
function enforceCacheSizeLimit() {
  const files = fs.readdirSync(CACHE_DIR)
    .map((name) => {
      const filepath = path.join(CACHE_DIR, name);
      try {
        const { size, mtimeMs } = fs.statSync(filepath);
        return { filepath, size, mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= MAX_CACHE_BYTES) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (total <= MAX_CACHE_BYTES) break;
    try {
      fs.unlinkSync(f.filepath);
      total -= f.size;
    } catch {
      // already removed by a concurrent worker — fine
    }
  }
}

/**
 * Downloads a PDF once and caches it under tmp/pdf-cache/.
 * Subsequent calls for the same URL return the cached ArrayBuffer without a network request.
 */
async function downloadPdfCached(url) {
  ensureCacheDir();
  enforceCacheSizeLimit();
  const filepath = path.join(CACHE_DIR, urlToFilename(url));

  if (fs.existsSync(filepath)) {
    const buf = fs.readFileSync(filepath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download PDF (${res.status}): ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(filepath, Buffer.from(arrayBuffer));
  return arrayBuffer;
}

module.exports = { downloadPdfCached };
