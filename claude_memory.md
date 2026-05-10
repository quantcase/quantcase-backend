# Claude Memory — QuantCase Backend

This file documents the architecture decisions, migration history, and active flags for Claude Code to use in future sessions. Read this before touching any file that deals with KPI computation, financial metrics, or data fetching.

---

## 1. The formulaRegistry Framework

**Location:** `utils/formulaRegistry/`
**Entry point:** `utils/formulaRegistry/index.js` — spreads `./dataFetcher` which re-exports from `./dataFetcherCore` + `./dataFetcherAnalytics`

This is the **single source of truth for all KPI computation**. All metric resolution, CAGR calculations, and data fetching must go through this framework. Never use inline formulas (e.g. `(pat / rev) * 100`) or the deprecated helpers below when registry functions are available.

### Exports (27 total)

| Function | Source | What it does |
|---|---|---|
| `resolveMetric(abbr, { kpiMap, prevKpiMap })` | `financial.js` | Resolve a single period metric from prowess maps |
| `resolveKpi(abbr, context)` | `financial.js` | Alias of resolveMetric |
| `REGISTRY` | `financial.js` | Raw registry object (67 financial entries) |
| `resolveTechnicalIndicators(...)` | `technical.js` | Resolve TA signals |
| `resolveIndicatorSeries(...)` | `technical.js` | Resolve TA time-series |
| `TECHNICAL_REGISTRY` | `technical.js` | Raw TA registry object (53 entries) |
| `resolveProwessName(prisma, ticker)` | `dataFetcherCore.js` | Resolve prowess company name from ticker |
| `fetchKpiMap(prisma, companyName)` | `dataFetcherKpiMaps.js` | Single-period prowess KPI map |
| `fetchKpiMaps(prisma, companyName)` | `dataFetcherKpiMaps.js` | Current + previous period prowess KPI maps |
| `fetchKpiMapsMulti(prisma, tickers)` | `dataFetcherKpiMaps.js` | Batch version of fetchKpiMaps |
| `fetchTimeSeries(prisma, ticker, abbr)` | `dataFetcherCore.js` | Prowess time-series for one abbr (all periods, all callId prefixes) |
| `fetchTimeSeriesBatch(prisma, ticker, abbrs)` | `dataFetcherCore.js` | Prowess time-series for many abbrs (all periods) |
| `fetchAnnualBatch(prisma, ticker, abbrs)` | `dataFetcherCore.js` | Prowess annual only (`prowess_new_*`); C preferred, fallback S |
| `fetchQuarterlyBatch(prisma, ticker, abbrs)` | `dataFetcherCore.js` | Prowess quarterly only (`prowess_qtr_*`); always standalone |
| `fetchProwessTimeSeries(prisma, companyName, abbr)` | `dataFetcherCore.js` | Prowess time-series by company name (not ticker) |
| `fetchIndustryTickers(prisma, industry)` | `dataFetcherAnalytics.js` | All distinct tickers in an industry |
| `fetchStockLatest(prisma, ticker, abbr)` | `dataFetcherAnalytics.js` | Latest non-null prowess value |
| `fetchStockCagr(prisma, ticker, abbr, [targetYears=3])` | `dataFetcherAnalytics.js` | Prowess CAGR (spanYears = periods − 1) |
| `fetchIndustryCagr(prisma, industry, abbr, [targetYears=3])` | `dataFetcherAnalytics.js` | Industry average CAGR across tickers |
| `fetchIndustryAvg(prisma, industry, abbr)` | `dataFetcherAnalytics.js` | Industry average latest value |
| `fetchDerivedBatch(prisma, ticker, [bfsi=false])` | `dataFetcherAnalytics.js` | Registry-enforced derived KPIs (EBIT, ROCE, FCF, etc.) |
| `fetchStockPeCagr(prisma, ticker, [targetYears=5])` | `dataFetcherAnalytics.js` | PE CAGR from `pe_data` table |
| `fetchIndustryPeCagr(prisma, industry, [targetYears=5])` | `dataFetcherAnalytics.js` | Industry average PE CAGR |
| `fetchEarningsTimeSeries(prisma, ticker, abbr)` | `dataFetcherAnalytics.js` | kpiValue time-series for one abbr |
| `fetchEarningsTimeSeriesBatch(prisma, ticker, abbrs)` | `dataFetcherAnalytics.js` | kpiValue time-series for many abbrs (single DB round-trip) |
| `fetchEarningsLatest(prisma, ticker, abbr)` | `dataFetcherAnalytics.js` | Latest non-null kpiValue |
| `fetchEarningsCagr(prisma, ticker, abbr, [targetYears=5])` | `dataFetcherAnalytics.js` | kpiValue CAGR using date-span from call_date |

### Two data sources — naming convention

| Prefix | Table | Notes |
|---|---|---|
| `fetchStock*` / `fetchIndustry*` | `prowessValueNew` | Annual, prowess-sourced; `fetchTimeSeries` takes `ticker`, internally resolves to `company_name` |
| `fetchEarnings*` | `kpiValue` | Quarterly earnings call extracted; keyed by `callId` |
| `fetchStockPeCagr` / `fetchIndustryPeCagr` | `pe_data` | No prowess equivalent |

### File structure (all files ≤ 400 lines — hard constraint)

```
utils/formulaRegistry/
  index.js                (8 lines) — barrel, spreads dataFetcher
  financial.js          (252 lines) — REGISTRY, resolveMetric, resolveKpi + 5 self-referencing entries
  financialEntries.a.js (251 lines) — plain array of 40 entries (no REGISTRY refs in compute)
  financialEntries.b.js (295 lines) — plain array of 27 entries (CAPEX, FCF, CAGR, AVG entries)
  technical.js           (63 lines) — TECHNICAL_REGISTRY + resolvers
  technicalEntries.a.js  (80 lines) — 32 TA entries (plain objects)
  technicalEntries.b.js  (77 lines) — 21 TA entries (plain objects)
  dataFetcher.js          (6 lines) — barrel: ...core + ...kpiMaps + ...analytics
  dataFetcherCore.js    (333 lines) — resolveProwessName, fetchTimeSeries/Batch, fetchAnnualBatch, fetchQuarterlyBatch, fetchProwessTimeSeries
  dataFetcherKpiMaps.js (135 lines) — fetchKpiMap, fetchKpiMaps, fetchKpiMapsMulti
  dataFetcherAnalytics.js(384 lines)— 12 analytics functions
  seriesResolver.js     (100 lines) — computeRegistryDerivedSeries, SOURCE_ABBRS
  math.js                (34 lines) — cagr(), average(), periodLabel()
```

> **Why 5 entries stay in financial.js**: `EBITDA_MARGIN`, `EBIT_MARGIN`, `NET_DEBT_EBITDA`, `CFO_EBITDA_PCT`, `CASH_CONVERSION` reference `REGISTRY.*` inside their `compute()`. They must be registered after the bulk entries to avoid forward-reference issues. They cannot be in `financialEntries.a/b.js` (which are plain arrays imported before REGISTRY is populated).

---

## 2. Fully Migrated Consumers

These files no longer import FinHelper or ProwessHelper:

| File | What was replaced |
|---|---|
| `controllers/screener.controller.js` | All FinHelper calls |
| `controllers/admin.controller.js` | All FinHelper calls |
| `workers/ofactor.js` (300 lines) | Removed ProwessHelper + FinHelper entirely |
| `workers/ofactor.helpers.js` (125 lines) | New file — shared helpers extracted from ofactor.js |
| `workers/ofactor.sections.js` (234 lines) | New file — 6 section builders, uses registry fetchers |
| `workers/deal.js` | `getDerivedKpiBatch` → `fetchDerivedBatch`; `getTimeSeries` → `fetchEarningsTimeSeries` |
| `services/deal.service.js` | 7 prowess/PE CAGR calls → registry equivalents |
| `services/admin.service.js` | 9 FinHelper calls → registry equivalents |
| `services/opportunity.service.js` (174 lines) | Peer helpers extracted; FinHelper removed |
| `services/opportunity.peers.service.js` (289 lines) | New file — `getQ4Stats` migrated to `fetchKpiMaps` + `fetchProwessTimeSeries` + `resolveMetric` |
| `lib/financials.js` (397 lines) | `getAnnualBatch` → `fetchAnnualBatch`; `getQuarterlyBatch` → `fetchQuarterlyBatch`; `resolveProwessName` from registry |

---

## 3. ⚠ Flagged — Still Using Deprecated Helpers

These files have not been migrated and must be flagged whenever metrics or calculations are discussed.

### 3a. `prompts/of-prompts/nse-industry-prompt.js` — `loadCompanyData` function (~line 224)

```js
const prowessHelper = new ProwessHelper(prisma);
const finHelper     = new FinHelper(prisma);
// ...
prowessHelper.getTimeSeriesBatch(ticker, PROWESS_ABBRS),
finHelper.getTimeSeriesBatch(ticker, KPI_ABBRS),
prowessHelper.resolveProwessName(ticker),
```

**Migration path:** Replace with `fetchTimeSeriesBatch(prisma, ticker, PROWESS_ABBRS)`, `fetchEarningsTimeSeriesBatch(prisma, ticker, KPI_ABBRS)`, `resolveProwessName(prisma, ticker)`.

---

### 3b. `utils/industryIntelligence/index.js` (~line 47) and `fundamentals.js`

`index.js` creates `new ProwessHelper(prisma)` and `new FinHelper(prisma)` and passes them to `computeFundamentals`.

`fundamentals.js` uses:
- `prowess.getTimeSeriesBatch(ticker, ABBRS)` — → `fetchTimeSeriesBatch`
- `prowess.getDerivedKpiBatch(ticker, bfsi)` — → `fetchDerivedBatch`
- `finHelper.getTimeSeriesBatch(ticker, ABBRS)` — → `fetchEarningsTimeSeriesBatch`
- `finHelper.getDerivedKpiBatch(ticker, bfsi)` — → `fetchDerivedBatch`

The fallback logic (prowess → kpi_values) needs to be preserved during migration. These are part of the IIT scoring pipeline.

---

### ~~3c. `lib/financials.js`~~ — **Migrated**

`lib/financials.js` now uses `fetchAnnualBatch`, `fetchQuarterlyBatch`, and `resolveProwessName` from the registry. `ProwessHelper` import removed.

---

## 4. ⚠ Flagged — computeFinancialStrengthExtras (finExtras.js)

**Where called:** `workers/ofactor.sections.js:153`
```js
const { computeFinancialStrengthExtras, deepMerge } = require('../utils/finExtras');
// ...
const localExtras = computeFinancialStrengthExtras(rawBatchAll, derivedBatchAll, bfsi, marketCap);
```

`computeFinancialStrengthExtras` is a 725-line function in `utils/finExtras.js` that computes the structured `extras` object (operating_leverage, free_cash_flow, working_capital, capital_structure) used in the `financial_strength_insights` section. It is **not** in the formulaRegistry.

- It takes `rawBatchAll` (from `fetchTimeSeriesBatch`) and `derivedBatchAll` (from `fetchDerivedBatch`) — both already use registry-sourced data
- The computation logic itself is complex domain logic, not a registry-computable formula
- `deepMerge` is a pure utility also from `finExtras.js`

**Status:** This is acceptable as-is — the _inputs_ are registry-sourced. The function itself is domain-specific assembly logic that doesn't need to be in the registry. Do not move it to the registry.

---

## 5. ⚠ Flagged — computeDerivedKpis (finDerivedKpis.js — non-registry version)

`utils/finDerivedKpis.js` exports two functions:
- `computeDerivedKpis(raw, bfsi)` — **deprecated**, non-registry, inline formulas
- `computeRegistryDerivedSeries(raw, bfsi)` — **correct**, registry-enforced

`computeRegistryDerivedSeries` is re-exported from `utils/formulaRegistry/seriesResolver.js` and used by `fetchDerivedBatch`. Do not call `computeDerivedKpis` anywhere — always use `fetchDerivedBatch` or `computeRegistryDerivedSeries`.

If you see `computeDerivedKpis` in any file outside `utils/finDerivedKpis.js`, treat it as a bug.

---

## 6. ⚠ Flagged — Inline Calculations Still Present

### `services/opportunity.peers.service.js` — `getQ4Stats` and market share

```js
// Revenue YoY — acceptable, no registry entry for this
revenueGrowth = ((curr - prev) / Math.abs(prev)) * 100

// Market share — display-only, percentage of total revenue across peers
(r.revenue / totalRevenue) * 100
```

These are **presentation-layer computations** (not stored KPIs), so inline math is acceptable. Revenue itself comes from `fetchProwessTimeSeries` → `withRev.at(-1).value`. Do not move these to the registry.

### `workers/deal.js` — `cashConversionPct`

```js
cashConversionPct = parseFloat((fcf / pat * 100).toFixed(1));
```

`FCF` and `PAT` both come from `fetchDerivedBatch` and `fetchEarningsTimeSeries` respectively. The ratio itself has no registry entry. **Flag for future addition** if this metric is used in more than one place.

---

## 7. Deprecated Helper Files (do not delete — other consumers exist)

| File | Size | Status |
|---|---|---|
| `utils/finHelper.js` | 718 lines | Keep — still used by `industryIntelligence/` and `nse-industry-prompt.js` |
| `utils/prowessHelper.js` | 499 lines | Keep — still used by `industryIntelligence/`, `lib/financials.js`, `nse-industry-prompt.js` |
| `utils/finExtras.js` | 725 lines | Keep — `computeFinancialStrengthExtras` still in active use; `deepMerge` also used |
| `utils/finDerivedKpis.js` | 260 lines | Keep — `computeRegistryDerivedSeries` is the canonical derived-KPI computer; `computeDerivedKpis` (non-registry) is still defined here but should not be called |

---

## 8. 400-Line File Constraint

**Hard constraint**: No file in this repository should exceed 400 lines. This was enforced during the formulaRegistry migration and must be maintained.

Before adding code to any file, run `wc -l <file>` first. If an edit would push a file past 400 lines, split it following the existing patterns:
- Plain entry arrays → `*Entries.a.js` / `*Entries.b.js` (no imports, just objects)
- Shared helpers → `*.helpers.js`
- Section builders or sub-services → `*.sections.js` / `*.peers.service.js`

---

## 9. Verification Commands

Run these after any change to KPI/metric-related files:

```bash
# Registry exports intact
node -e "const r = require('./utils/formulaRegistry'); console.log(Object.keys(r).length, 'exports')"

# All migrated consumers load
node -e "require('./services/opportunity.service'); console.log('opportunity.service OK')"
node -e "require('./services/opportunity.peers.service'); console.log('opportunity.peers.service OK')"
node -e "require('./services/deal.service'); console.log('deal.service OK')"
node -e "require('./services/admin.service'); console.log('admin.service OK')"
timeout 5 node -e "require('./workers/deal'); console.log('deal.js OK'); process.exit(0)"
timeout 5 node -e "require('./workers/ofactor'); console.log('ofactor OK'); process.exit(0)"

# File size check
wc -l utils/formulaRegistry/*.js workers/ofactor*.js services/opportunity*.js services/deal.service.js services/admin.service.js workers/deal.js | sort -rn
```
