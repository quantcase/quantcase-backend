'use strict';

/**
 * PDF chunker: splits a PDF into named sections using the document's bookmark
 * outline. Falls back to equal-size page-range chunks when the outline is
 * absent or malformed.
 *
 * Each chunk: { title: string, startPage: number, endPage: number, text: string }
 * Pages are 1-based and inclusive.
 */

const { STANDARD_FONT_DATA_URL } = require('./pdfjsConfig');

const FALLBACK_CHUNK_SIZE = 80; // pages per chunk when no outline exists

/**
 * Load pdfjs-dist. Throws if not installed.
 */
function getPdfjs() {
  // eslint-disable-next-line import/no-extraneous-dependencies
  return require('pdfjs-dist/legacy/build/pdf.js');
}

/**
 * Extract plain text from a range of pages (1-based, inclusive).
 */
async function extractPageRangeText(pdf, startPage, endPage) {
  const parts = [];
  const last = Math.min(endPage, pdf.numPages);
  for (let i = startPage; i <= last; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map(item => item.str).join(' '));
  }
  return parts.join('\n');
}

/**
 * Resolve a PDF destination (array or named string) to a 0-based page index.
 * Returns null if it cannot be resolved.
 */
async function resolveDestToPageIndex(pdf, dest) {
  try {
    let resolved = dest;
    if (typeof dest === 'string') {
      resolved = await pdf.getDestination(dest);
    }
    if (!Array.isArray(resolved) || !resolved[0]) return null;
    return await pdf.getPageIndex(resolved[0]);
  } catch {
    return null;
  }
}

/**
 * Flatten the nested outline tree into a list of { title, pageIndex } entries
 * (DFS order). Items whose destination cannot be resolved are skipped.
 */
async function flattenOutline(pdf, items) {
  const result = [];
  for (const item of items) {
    const pageIndex = await resolveDestToPageIndex(pdf, item.dest);
    if (pageIndex !== null) {
      result.push({ title: item.title ?? 'Section', pageIndex });
    }
    if (Array.isArray(item.items) && item.items.length) {
      const children = await flattenOutline(pdf, item.items);
      result.push(...children);
    }
  }
  return result;
}

/**
 * Build chunks from a flat list of outline entries.
 * Each outline entry becomes a chunk spanning from its page to the page before
 * the next entry. Only top-level-equivalent boundaries (deduplicated by page)
 * are used to avoid too-small chunks from sub-headings.
 */
function buildChunksFromOutline(outlineEntries, totalPages) {
  // Deduplicate consecutive entries pointing to the same page
  const deduped = [];
  for (const entry of outlineEntries) {
    if (!deduped.length || deduped.at(-1).pageIndex !== entry.pageIndex) {
      deduped.push(entry);
    }
  }

  return deduped.map((entry, i) => {
    const startPage = entry.pageIndex + 1; // convert to 1-based
    const endPage   = i + 1 < deduped.length
      ? deduped[i + 1].pageIndex // next entry's 0-based index = last 1-based page of this chunk
      : totalPages;
    return { title: entry.title, startPage, endPage };
  }).filter(c => c.startPage <= c.endPage);
}

/**
 * Merge small adjacent chunks so no chunk is < minPages pages.
 * This prevents the LLM from receiving near-empty context for thin sections.
 */
function mergeSmallChunks(chunks, minPages = 20) {
  const merged = [];
  for (const chunk of chunks) {
    const size = chunk.endPage - chunk.startPage + 1;
    if (merged.length && size < minPages) {
      // Extend the previous chunk to absorb this one
      merged.at(-1).endPage = chunk.endPage;
      merged.at(-1).title  += ` + ${chunk.title}`;
    } else {
      merged.push({ ...chunk });
    }
  }
  return merged;
}

/**
 * Fallback: divide PDF into equal-size chunks of FALLBACK_CHUNK_SIZE pages.
 */
function buildFallbackChunks(totalPages) {
  const chunks = [];
  for (let start = 1; start <= totalPages; start += FALLBACK_CHUNK_SIZE) {
    const end = Math.min(start + FALLBACK_CHUNK_SIZE - 1, totalPages);
    chunks.push({ title: `Pages ${start}–${end}`, startPage: start, endPage: end });
  }
  return chunks;
}

/**
 * Main export: given a PDF buffer, returns an array of chunks with extracted text.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Array<{title: string, startPage: number, endPage: number, text: string}>>}
 */
async function chunkPdf(buffer) {
  const pdfjsLib  = getPdfjs();
  const pdf       = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const totalPages = pdf.numPages;

  let pageChunks;

  try {
    const outline = await pdf.getOutline();
    if (outline && outline.length) {
      const flat   = await flattenOutline(pdf, outline);
      const raw    = buildChunksFromOutline(flat, totalPages);
      pageChunks   = mergeSmallChunks(raw);
    }
  } catch {
    // outline parse failed — fall through to fallback
  }

  if (!pageChunks || !pageChunks.length) {
    pageChunks = buildFallbackChunks(totalPages);
  }

  // Extract text for each chunk in sequence (pdfjs isn't safe to parallelise heavily)
  const result = [];
  for (const chunk of pageChunks) {
    const text = await extractPageRangeText(pdf, chunk.startPage, chunk.endPage);
    result.push({ title: chunk.title, startPage: chunk.startPage, endPage: chunk.endPage, text });
  }
  return result;
}

module.exports = { chunkPdf };
