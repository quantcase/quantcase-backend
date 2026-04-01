'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');

// ── Constants ─────────────────────────────────────────────────────────────────

const FUND_COLS_PER_PERIOD = 20;
const FUND_PERIOD_COUNT = 8;

const SH_COLS_PER_PERIOD = 35;
const SH_PERIOD_COUNT = 8;

// ── Fundamental indicator offsets (0-based within each 20-col block) ─────────
const FUND_OFF = {
  SHARES: 0,
  MARKET_CAP: 1,
  TOTAL_RETURNS: 2,
  ADJ_EPS: 3,
  ADJ_CASH_EPS: 4,
  PE: 5,
  PB: 6,
  BVPS: 7,
  YIELD: 8,
  EV: 9,
  MC_EV: 10,
  EV_PBDITA: 11,
  COGS: 12,
  TOTAL_INCOME: 13,
  TOTAL_EXPENSES: 14,
  NET_PROFIT: 15,
  EPS_BASIC: 16,
  NTRM_MONTHS: 17,
  NTRM_SOURCE: 18,
  NTRM_DATE_SIGNED: 19,
};

// ── Shareholding indicator offsets (0-based within each 35-col block) ─────────
const SH_OFF = {
  TOTAL: 0,
  PROMOTERS: 1,
  INDIAN_PROMOTERS: 2,
  INDIAN_PROMOTER_INDV_HUF: 3,
  INDIAN_CENTRAL_STATE_GOVT: 4,
  INDIAN_PROMOTER_CORP: 5,
  INDIAN_PROMOTER_FI_BANKS: 6,
  OTHER_INDIAN_PROMOTERS: 7,
  FOREIGN_PROMOTERS: 8,
  FOREIGN_INDV_NRI: 9,
  FOREIGN_PROMOTER_CORP: 10,
  FOREIGN_PROMOTER_INST: 11,
  PROMOTER_QFI: 12,
  OTHER_FOREIGN_PROMOTERS: 13,
  PERSONS_ACTING_IN_CONCERT: 14,
  NON_PROMOTERS: 15,
  NON_PROMOTER_INST: 16,
  NP_MUTUAL_FUNDS: 17,
  NP_BANKS_FI_INS: 18,
  NP_INSURANCE: 19,
  NP_FI_BANKS: 20,
  NP_CENTRAL_STATE_GOVT: 21,
  NP_FIIS: 22,
  NP_VENTURE_CAPITAL: 23,
  NP_FOREIGN_VENTURE: 24,
  NP_QFI_INST: 25,
  OTHER_INST_NP: 26,
  NP_NON_INST: 27,
  NP_CORP_BODIES: 28,
  NP_INDIVIDUALS: 29,
  NP_INDV_UPTO_1L: 30,
  NP_INDV_OVER_1L: 31,
  NP_QFI: 32,
  OTHER_NON_INST_NP: 33,
  CUSTODIANS: 34,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse CSV cell to float; returns null on empty/NaN */
function toFloat(val) {
  if (val === '' || val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Round to 2 decimal places */
function r2(v) {
  if (v == null) return null;
  return Math.round(v * 100) / 100;
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return csvParse.parse(content, { relax_column_count: true });
}

// ── Lazy-loaded caches ────────────────────────────────────────────────────────

let _identityMap = null;
let _fundamentalData = null;
let _shareholdingData = null;

function loadIdentityMap() {
  if (_identityMap) return _identityMap;
  const allRows = parseCsv(path.join(__dirname, 'osc_identity.csv'));
  // osc_identity uses columns: true mode via csv-parse
  const raw = fs.readFileSync(path.join(__dirname, 'osc_identity.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const rows = csvParse.parse(content, { columns: true, relax_column_count: true });
  _identityMap = {};
  for (const row of rows) {
    const sym = (row['NSE symbol'] || '').trim().toUpperCase();
    const name = (row['Company Name'] || '').trim();
    if (sym && name) _identityMap[sym] = name;
  }
  return _identityMap;
}

function loadFundamentalData() {
  if (_fundamentalData) return _fundamentalData;
  const allRows = parseCsv(path.join(__dirname, 'osc_fundamental_ind_qtr_v4.csv'));

  const quarterRow = allRows[4];
  const quarterLabels = [];
  for (let i = 0; i < FUND_PERIOD_COUNT; i++) {
    quarterLabels.push(quarterRow[1 + i * FUND_COLS_PER_PERIOD] || `Q${i + 1}`);
  }

  const companyMap = {};
  for (const row of allRows.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) companyMap[name] = row;
  }

  _fundamentalData = { quarterLabels, companyMap };
  return _fundamentalData;
}

function loadShareholdingData() {
  if (_shareholdingData) return _shareholdingData;
  const allRows = parseCsv(path.join(__dirname, 'osc_shareholding_qtr_v1.csv'));

  const quarterRow = allRows[4];
  const quarterLabels = [];
  for (let i = 0; i < SH_PERIOD_COUNT; i++) {
    quarterLabels.push(quarterRow[1 + i * SH_COLS_PER_PERIOD] || `Q${i + 1}`);
  }

  const companyMap = {};
  for (const row of allRows.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) companyMap[name] = row;
  }

  _shareholdingData = { quarterLabels, companyMap };
  return _shareholdingData;
}

// ── Row extractors ────────────────────────────────────────────────────────────

/** Extract one period's fundamental data (periodIndex: 0 = oldest) */
function fundPeriodData(row, periodIndex) {
  const start = 1 + periodIndex * FUND_COLS_PER_PERIOD;
  return {
    shares: toFloat(row[start + FUND_OFF.SHARES]),
    marketCapCr: toFloat(row[start + FUND_OFF.MARKET_CAP]),
    totalReturns: toFloat(row[start + FUND_OFF.TOTAL_RETURNS]),
    adjEps: toFloat(row[start + FUND_OFF.ADJ_EPS]),
    adjCashEps: toFloat(row[start + FUND_OFF.ADJ_CASH_EPS]),
    pe: toFloat(row[start + FUND_OFF.PE]),
    pb: toFloat(row[start + FUND_OFF.PB]),
    bvps: toFloat(row[start + FUND_OFF.BVPS]),
    yield_: toFloat(row[start + FUND_OFF.YIELD]),
    ev: toFloat(row[start + FUND_OFF.EV]),
    mcEv: toFloat(row[start + FUND_OFF.MC_EV]),
    evPbdita: toFloat(row[start + FUND_OFF.EV_PBDITA]),
    cogsCr: toFloat(row[start + FUND_OFF.COGS]),
    totalIncomeCr: toFloat(row[start + FUND_OFF.TOTAL_INCOME]),
    totalExpCr: toFloat(row[start + FUND_OFF.TOTAL_EXPENSES]),
    netProfitCr: toFloat(row[start + FUND_OFF.NET_PROFIT]),
    epsBasic: toFloat(row[start + FUND_OFF.EPS_BASIC]),
    ntrmMonths: toFloat(row[start + FUND_OFF.NTRM_MONTHS]),
    ntrmSource: row[start + FUND_OFF.NTRM_SOURCE] || null,
    ntrmDateSigned: row[start + FUND_OFF.NTRM_DATE_SIGNED] || null,
  };
}

/** Extract one period's shareholding data (periodIndex: 0 = oldest) */
function shPeriodData(row, periodIndex) {
  const start = 1 + periodIndex * SH_COLS_PER_PERIOD;
  const get = (off) => toFloat(row[start + off]);
  return {
    total: get(SH_OFF.TOTAL),
    promoters: get(SH_OFF.PROMOTERS),
    indianPromoters: get(SH_OFF.INDIAN_PROMOTERS),
    indianPromoterIndvHuf: get(SH_OFF.INDIAN_PROMOTER_INDV_HUF),
    indianCentralStateGovt: get(SH_OFF.INDIAN_CENTRAL_STATE_GOVT),
    indianPromoterCorp: get(SH_OFF.INDIAN_PROMOTER_CORP),
    indianPromoterFiBanks: get(SH_OFF.INDIAN_PROMOTER_FI_BANKS),
    otherIndianPromoters: get(SH_OFF.OTHER_INDIAN_PROMOTERS),
    foreignPromoters: get(SH_OFF.FOREIGN_PROMOTERS),
    foreignIndvNri: get(SH_OFF.FOREIGN_INDV_NRI),
    foreignPromoterCorp: get(SH_OFF.FOREIGN_PROMOTER_CORP),
    foreignPromoterInst: get(SH_OFF.FOREIGN_PROMOTER_INST),
    promoterQfi: get(SH_OFF.PROMOTER_QFI),
    otherForeignPromoters: get(SH_OFF.OTHER_FOREIGN_PROMOTERS),
    personsActingInConcert: get(SH_OFF.PERSONS_ACTING_IN_CONCERT),
    nonPromoters: get(SH_OFF.NON_PROMOTERS),
    nonPromoterInst: get(SH_OFF.NON_PROMOTER_INST),
    npMutualFunds: get(SH_OFF.NP_MUTUAL_FUNDS),
    npBanksFiIns: get(SH_OFF.NP_BANKS_FI_INS),
    npInsurance: get(SH_OFF.NP_INSURANCE),
    npFiBanks: get(SH_OFF.NP_FI_BANKS),
    npCentralStateGovt: get(SH_OFF.NP_CENTRAL_STATE_GOVT),
    npFiis: get(SH_OFF.NP_FIIS),
    npVentureCapital: get(SH_OFF.NP_VENTURE_CAPITAL),
    npForeignVenture: get(SH_OFF.NP_FOREIGN_VENTURE),
    npQfiInst: get(SH_OFF.NP_QFI_INST),
    otherInstNp: get(SH_OFF.OTHER_INST_NP),
    npNonInst: get(SH_OFF.NP_NON_INST),
    npCorpBodies: get(SH_OFF.NP_CORP_BODIES),
    npIndividuals: get(SH_OFF.NP_INDIVIDUALS),
    npIndvUpto1L: get(SH_OFF.NP_INDV_UPTO_1L),
    npIndvOver1L: get(SH_OFF.NP_INDV_OVER_1L),
    npQfi: get(SH_OFF.NP_QFI),
    otherNonInstNp: get(SH_OFF.OTHER_NON_INST_NP),
    custodians: get(SH_OFF.CUSTODIANS),
  };
}

/** Resolve NSE symbol → company row in fundamentals, returns null if not found */
function findFundCompanyRow(symbol) {
  const identityMap = loadIdentityMap();
  const { companyMap } = loadFundamentalData();
  const companyName = identityMap[symbol.toUpperCase()];
  if (!companyName) return null;
  return companyMap[companyName] ?? null;
}

module.exports = {
  toFloat,
  r2,
  loadIdentityMap,
  loadFundamentalData,
  loadShareholdingData,
  fundPeriodData,
  shPeriodData,
  findFundCompanyRow,
  FUND_PERIOD_COUNT,
  SH_PERIOD_COUNT,
};
