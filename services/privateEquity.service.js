'use strict';

const { llmStream, parseJson } = require('../utils/workerUtils');
const { loadSkillConfig }      = require('../utils/skillConfig');
const { getPromptFn }          = require('../lib/skillsRegistry');
const { chunkPdf }             = require('../utils/pdfChunker');
const prisma                   = require('../config/prisma');

// ─── Section → skill slug mapping ────────────────────────────────────────────

/**
 * Keywords that identify which skill should handle a given PDF section.
 * Matching is case-insensitive against the section title from the PDF outline.
 * Order matters: first match wins.
 */
const SECTION_SKILL_MAP = [
  {
    slug: 'drhp-section-financials',
    keywords: ['financial', 'restated', 'balance sheet', 'cash flow', 'capitalisation',
               'dividend', 'indebtedness', 'management discussion', 'md&a', 'mda',
               'results of operation'],
  },
  {
    slug: 'drhp-section-legal-offer',
    keywords: ['legal', 'litigation', 'government approval', 'regulatory', 'statutory',
               'group compan', 'offer information', 'terms of the offer', 'offer structure',
               'offer procedure', 'equity shares', 'articles of association', 'declaration',
               'material contract', 'other information'],
  },
  {
    slug: 'drhp-section-company-overview',
    keywords: ['introduction', 'the offer', 'summary of financial', 'general information',
               'capital structure', 'objects of the offer', 'basis for offer price',
               'industry overview', 'our business', 'key regulation', 'history',
               'our management', 'principal shareholder', 'about our company'],
  },
  // Default: general + risk factors (catches "general", "risk factor", "definitions", etc.)
  {
    slug: 'drhp-section-general-risk',
    keywords: [],
  },
];

/**
 * Return the skill slug best matching a section title.
 * Falls back to drhp-section-general-risk if nothing matches.
 */
function skillSlugForSection(title) {
  const lower = title.toLowerCase();
  for (const { slug, keywords } of SECTION_SKILL_MAP) {
    if (!keywords.length) return slug; // catch-all
    if (keywords.some(kw => lower.includes(kw))) return slug;
  }
  return 'drhp-section-general-risk';
}

// ─── Skill config cache (avoid N DB round-trips for repeated slugs) ───────────

const _configCache = new Map();

async function loadSkillConfigCached(slug) {
  if (!_configCache.has(slug)) {
    _configCache.set(slug, await loadSkillConfig(slug));
  }
  return _configCache.get(slug);
}

// ─── Deep merge helpers ───────────────────────────────────────────────────────

/**
 * Merge two partial DRHP analysis objects.
 * Arrays are concatenated; scalars/strings take the last non-null value.
 * Objects are merged recursively.
 */
function mergePartials(base, incoming) {
  if (!incoming || typeof incoming !== 'object') return base;
  if (!base    || typeof base     !== 'object') return incoming;

  const result = { ...base };
  for (const [key, val] of Object.entries(incoming)) {
    if (val === null || val === undefined) continue;

    if (Array.isArray(val)) {
      result[key] = Array.isArray(result[key])
        ? [...result[key], ...val]
        : val;
    } else if (typeof val === 'object') {
      result[key] = mergePartials(result[key] ?? {}, val);
    } else {
      // Scalar: last write wins (later skills' verdicts override earlier ones)
      result[key] = val;
    }
  }
  return result;
}

/**
 * Deduplicate array items by JSON fingerprint (avoids duplicate flags when
 * the same risk factor appears in both general and legal sections).
 */
function dedupeArray(arr) {
  if (!Array.isArray(arr)) return arr;
  const seen = new Set();
  return arr.filter(item => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Post-process merged result: deduplicate all arrays.
 */
function dedupeArraysInResult(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      out[k] = dedupeArray(v);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = dedupeArraysInResult(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Core analysis ────────────────────────────────────────────────────────────

/**
 * Run one skill against one chunk of text.
 * Returns the parsed partial JSON (or null on failure — other chunks proceed).
 */
async function analyseChunk(chunk) {
  const slug = skillSlugForSection(chunk.title);
  const { model, maxTokens, promptKey, promptTemplate, defaultInstructions, outputSchema } = await loadSkillConfigCached(slug);

  const promptFn = getPromptFn(promptKey);
  const prompt   = promptFn(chunk.text, chunk.title, promptTemplate, defaultInstructions);

  const llmParams = {
    model,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  };
  if (outputSchema) llmParams.response_format = outputSchema;

  const responseText = await llmStream(llmParams);

  if (!responseText) throw new Error(`Empty LLM response for chunk "${chunk.title}"`);
  return parseJson(responseText);
}

/**
 * Extract plain text from a plain-text buffer (non-PDF path).
 * Splits into ~80-page-equivalent chunks by character count.
 */
function chunkPlainText(text, charsPerChunk = 120_000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += charsPerChunk) {
    const slice = text.slice(i, i + charsPerChunk);
    const chunkNum = Math.floor(i / charsPerChunk) + 1;
    chunks.push({ title: `Part ${chunkNum}`, startPage: null, endPage: null, text: slice });
  }
  return chunks;
}

/**
 * Run the DRHP forensic analysis against an uploaded document buffer.
 *
 * @param {Buffer} fileBuffer   - Raw bytes of the uploaded PDF (or pre-extracted text file)
 * @param {string} mimeType     - MIME type ('application/pdf' or 'text/plain')
 * @returns {object}            - Merged DRHP analysis JSON
 */
async function analyseDrhp(fileBuffer, mimeType) {
  // 1. Chunk the document
  let chunks;
  if (mimeType === 'application/pdf') {
    chunks = await chunkPdf(fileBuffer);
  } else {
    const text = fileBuffer.toString('utf8');
    if (!text || text.trim().length < 100) {
      const err = new Error('Could not extract meaningful text from the uploaded document');
      err.status = 422;
      throw err;
    }
    chunks = chunkPlainText(text);
  }

  if (!chunks.length) {
    const err = new Error('PDF produced no text chunks — document may be scanned/image-only');
    err.status = 422;
    throw err;
  }

  // Filter out empty/tiny chunks (< 200 chars) that won't yield useful analysis
  const substantiveChunks = chunks.filter(c => c.text && c.text.trim().length >= 200);
  if (!substantiveChunks.length) {
    const err = new Error('All PDF chunks are too short — document may be image-only');
    err.status = 422;
    throw err;
  }

  // 2. Run all chunks in parallel
  const results = await Promise.allSettled(
    substantiveChunks.map(chunk => analyseChunk(chunk))
  );

  // Collect successful partials; log failures but don't abort
  const partials = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) {
      partials.push(r.value);
    } else if (r.status === 'rejected') {
      console.error(`[drhp] chunk "${substantiveChunks[i].title}" failed:`, r.reason?.message, r.reason?.stack);
    }
  }

  if (!partials.length) {
    throw new Error('All DRHP analysis chunks failed — no result to return');
  }

  // 3. Merge partials and deduplicate arrays
  const merged = partials.reduce((acc, partial) => mergePartials(acc, partial), {});
  const result = dedupeArraysInResult(merged);

  // 3a. Synthesise flat intelligence metrics from the merged analysis
  try {
    const { model, maxTokens, promptKey, promptTemplate, defaultInstructions, outputSchema } =
      await loadSkillConfigCached('drhp-intelligence');
    const promptFn  = getPromptFn(promptKey);
    const prompt    = promptFn(JSON.stringify(result), null, promptTemplate, defaultInstructions);
    const llmParams = {
      model,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    };
    if (outputSchema) llmParams.response_format = outputSchema;
    const intelligenceText = await llmStream(llmParams);
    if (intelligenceText) {
      result.intelligence = parseJson(intelligenceText);
    }
  } catch (err) {
    console.error('[drhp] intelligence synthesis failed (non-fatal):', err.message);
  }

  // 4. Persist to ai_insights — ticker extracted from company-overview heroHeader
  const ticker = result?.core?.heroHeader?.ticker
    || result?.core?.heroHeader?.companyName
    || 'UNKNOWN';

  try {
    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker, type: 'drhp-analysis' } },
      create: { ticker, type: 'drhp-analysis', insight: result },
      update: { insight: result },
    });
  } catch (err) {
    console.error('[drhp] Failed to save ai_insight for ticker "%s":', ticker, err.message);
  }

  return result;
}

async function getDrhpAnalyses(id) {
  if (id) {
    const record = await prisma.aiInsight.findUnique({ where: { id } });
    if (!record || record.type !== 'drhp-analysis') {
      const err = new Error(`No drhp-analysis found with id "${id}"`);
      err.status = 404;
      throw err;
    }
    return record;
  }
  return prisma.aiInsight.findMany({
    where:   { type: 'drhp-analysis' },
    orderBy: { created_at: 'desc' },
  });
}

module.exports = { analyseDrhp, getDrhpAnalyses };
