'use strict';

/**
 * Prowess filings upsert layer — quarterly and annual financial data.
 * Inserts/updates rows in prowess_values_new.
 *
 * Column mapping and unit normalization extracted from
 * prowess_mappers/ProwessUploader.js — same semantics:
 *   ON CONFLICT (call_id, kpi_abbr) DO UPDATE SET value, raw_value, unit, ...
 *
 * Input `rows` come from prowessApiClient.fetchQuarterlyFilings / fetchAnnualFilings
 * once the Prowess API client is implemented. Each row should have:
 *   { company, ticker, fiscal_year, quarter?, period_type, kpi_abbr, value, raw_value, unit, multiplier, statement }
 */

const prisma = require('../../config/prisma');

const BATCH_SIZE = 200;

// Source type tag for prowess_values_new (matches existing ingested data)
const SOURCE_TYPE = 'C';

async function upsertFilingsBatch(rows) {
  if (!rows.length) return;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(r =>
        prisma.prowessValueNew.upsert({
          where: {
            callId_kpi_abbr: {
              callId:   r.call_id,
              kpi_abbr: r.kpi_abbr,
            },
          },
          update: {
            value:       r.value,
            raw_value:   r.raw_value ?? null,
            unit:        r.unit      ?? null,
            multiplier:  r.multiplier ?? 1,
            source_type: SOURCE_TYPE,
            statement:   r.statement ?? null,
            start_date:  r.start_date ?? null,
            end_date:    r.end_date   ?? null,
            period_type: r.period_type ?? null,
            updatedAt:   new Date(),
          },
          create: {
            callId:      r.call_id,
            company:     r.ticker,
            fiscal_year: r.fiscal_year,
            quarter:     r.quarter ?? null,
            call_date:   r.call_date ?? null,
            kpi_abbr:    r.kpi_abbr,
            value:       r.value,
            raw_value:   r.raw_value ?? null,
            unit:        r.unit      ?? null,
            multiplier:  r.multiplier ?? 1,
            source:      'transcript',
            source_path: '',
            source_type: SOURCE_TYPE,
            statement:   r.statement ?? null,
            start_date:  r.start_date ?? null,
            end_date:    r.end_date   ?? null,
            period_type: r.period_type ?? null,
          },
        })
      )
    );
  }

  return rows.length;
}

/**
 * Upsert parsed financial filing rows.
 * @param {Array}  rows
 * @param {'quarterly'|'annual'} _periodType - informational, already encoded per-row
 */
async function upsert(rows, _periodType = 'quarterly') {
  return upsertFilingsBatch(rows);
}

module.exports = { upsert };
