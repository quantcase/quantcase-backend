# Prowess Annual Data Import Guide

## Adding a new annual CSV from Prowess (CMIE)

1. Drop the CSV into `tmp/` (e.g. `tmp/Mar2026_annual.csv`).

2. Verify before writing to DB:
   ```bash
   node prowess_mappers/importProwessNew.js --csv=tmp/Mar2026_annual.csv
   ```
   Check that all expected column names are found and row counts look reasonable.

3. Insert (safe to re-run — duplicates are skipped automatically):
   ```bash
   node prowess_mappers/importProwessNew.js --csv=tmp/Mar2026_annual.csv --insert
   ```
   The output shows `X actually inserted (Y skipped as duplicates)` so you can confirm only new rows were added.

## Notes

- **New KPI columns** added by Prowess in newer exports: add them to `OPTIONAL_COL_MAP` in `importProwessNew.js`. They will be silently skipped in older CSVs that don't have them.
- **New required columns** (present in all exports): add to `BASE_COL_MAP` instead — the script will throw loudly if they're missing.
- **PPE breakdown KPIs** (`ASSET_LAND_NET`, `ASSET_PM_GRS`, etc.) are used as CAPEX components in `utils/finDerivedKpis.js`. Adding a new PPE abbr requires updating both files.
- Each annual CSV generates callIds like `prowess_new_COMPANY_FY2025_S` — different fiscal years never conflict.
