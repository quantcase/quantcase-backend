'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.resolve(__dirname, '../tmp/pdf-cache');

function urlToFilename(url) {
  return crypto.createHash('sha256').update(url).digest('hex') + '.pdf';
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Downloads a PDF once and caches it under tmp/pdf-cache/.
 * Subsequent calls for the same URL return the cached ArrayBuffer without a network request.
 */
async function downloadPdfCached(url) {
  ensureCacheDir();
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
