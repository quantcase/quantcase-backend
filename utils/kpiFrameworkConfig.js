/**
 * KPI Framework Configuration
 *
 * Defines which KPIs apply per industry for each of the 5 analysis pillars:
 *   1. operating_margin
 *   2. financial_strength
 *   3. profitability
 *   4. cash_flow
 *   5. balance_sheet
 *
 * `default` covers the majority of manufacturing / industrial companies (e.g. ADANIENT).
 * `industry_groups` holds pillar overrides for sectors where the default doesn't apply.
 * `industry_map` routes every basic_industry value to its group (falls back to "default").
 * `missing_kpis` lists KPIs not yet in the DB that would improve framework coverage.
 *
 * KPI abbrs must match rows in the `kpis` table.
 */

const FRAMEWORK_CONFIG = {

  // ─── Default (manufacturing / industrial / diversified) ────────────────────
  default: {
    operating_margin:   { label: "Operating Margin",                    kpis: ["OPM"] },
    financial_strength: { label: "Financial Strength",                  kpis: ["REV", "FCF", "ROCE"] },
    profitability:      { label: "Profitability",                       kpis: ["EBITDA", "NPM"] },   // EBITDA_MARGIN not in DB; EBITDA value used as proxy. NPM = PAT margin.
    cash_flow:          { label: "Cash Flow Generation & Quality",      kpis: ["FCF", "OCF"] },      // FCF_CONV and OCF_EBITDA not yet in DB
    balance_sheet:      { label: "Balance Sheet Strength & Leverage",   kpis: ["DE", "IC", "CR"] }   // NETDEBT_EBITDA not yet in DB
  },

  // ─── Industry-group overrides ──────────────────────────────────────────────
  industry_groups: {

    BANKS: {
      applies_to: ["Private Sector Bank", "Public Sector Bank", "Other Bank"],
      pillars: {
        operating_margin:   { kpis: [],                       note: "OPM not applicable. NIM (missing) is the correct metric." },
        financial_strength: { kpis: ["REV", "ROE", "ROA"],   note: "FCF replaced by ROE/ROA. ROCE not standard for banks." },
        profitability:      { kpis: ["NPM", "PAT"],           note: "EBITDA not applicable for banks." },
        cash_flow:          { kpis: ["OCF"],                  note: "FCF not meaningful. OCF retained." },
        balance_sheet:      { kpis: ["DE"],                   note: "CR/IC not standard. CAR, GNPA, NNPA (all missing) are the real metrics." }
      }
    },

    NBFC_LENDING: {
      applies_to: ["NBFC", "Housing Finance Company", "Microfinance Institutions", "Financial Institution"],
      pillars: {
        operating_margin:   { kpis: [],                           note: "OPM not applicable. NIM (missing) is the correct metric." },
        financial_strength: { kpis: ["REV", "ROE", "ROA"],       note: "FCF less meaningful. ROCE replaced by ROE/ROA." },
        profitability:      { kpis: ["NPM", "PAT"],               note: "EBITDA not applicable." },
        cash_flow:          { kpis: ["OCF"],                      note: "Standard OCF retained." },
        balance_sheet:      { kpis: ["DE", "CR"],                 note: "CAR, GNPA, NNPA (missing) are critical additions." }
      }
    },

    INSURANCE: {
      applies_to: ["Life Insurance", "General Insurance"],
      pillars: {
        operating_margin:   { kpis: [],                       note: "Not applicable. Combined Ratio / Loss Ratio (missing) are the standard." },
        financial_strength: { kpis: ["REV", "ROE"],           note: "FCF, ROCE not standard. GWP (missing) is the primary revenue KPI." },
        profitability:      { kpis: ["NPM", "PAT"],           note: "EBITDA not applicable. VNB/NBM (missing) matter for life insurers." },
        cash_flow:          { kpis: ["OCF"],                  note: "OCF retained; FCF less standard." },
        balance_sheet:      { kpis: ["DE"],                   note: "Solvency Ratio (missing) is the critical leverage metric." }
      }
    },

    ASSET_WEALTH_MGMT: {
      applies_to: [
        "Asset Management Company", "Financial Products Distributor",
        "Stockbroking & Allied", "Investment Company",
        "Exchange and Data Platform", "Dep, Clrng Houses and Other Interm"
      ],
      pillars: {
        operating_margin:   { kpis: ["CTI"],                              note: "Cost-to-Income Ratio replaces OPM (lower = better)." },
        financial_strength: { kpis: ["TOTALINC", "ARRAUM", "ROCE"],      note: "REV replaced by TOTALINC; AUM (ARRAUM) is the primary scale metric." },
        profitability:      { kpis: ["NPM", "PAT"],                      note: "EBITDA less standard; NPM and PAT preferred." },
        cash_flow:          { kpis: ["FCF", "OCF"],                      note: "Standard cash flow metrics apply; asset-light so FCF conversion is high." },
        balance_sheet:      { kpis: ["DE", "CR"],                        note: "Typically low-leverage; IC less critical." }
      }
    },

    IT_SERVICES: {
      applies_to: [
        "Computers - Software & Consulting", "Software Products",
        "IT Enabled Services", "BPO/KPO",
        "Healthcare Research, Analytics & Technology",
        "Financial Technology (Fintech)"
      ],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "Standard." },
        financial_strength: { kpis: ["REV", "FCF", "ROCE"],  note: "Standard. Most are net-cash businesses." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["FCF", "OCF"],           note: "FCF conversion is a key quality metric for asset-light IT." },
        balance_sheet:      { kpis: ["DE", "CR"],             note: "Net Debt/EBITDA often negative. IC less relevant." }
      }
    },

    TELECOM: {
      applies_to: [
        "Telecom - Cellular & Fixed line services",
        "Telecom - Equipment & Accessories",
        "Telecom - Infrastructure",
        "Other Telecom Services"
      ],
      pillars: {
        operating_margin:   { kpis: ["OPM", "EBITDA"],        note: "EBITDA margin particularly critical; used for debt servicing capacity." },
        financial_strength: { kpis: ["REV", "ROCE"],          note: "FCF often negative or thin due to heavy capex cycles." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["OCF", "FCF"],           note: "OCF vs CAPEX spread is the key cash quality signal." },
        balance_sheet:      { kpis: ["DE", "IC", "CR"],       note: "Highly leveraged sector. NETDEBT_EBITDA (missing) is critical." }
      }
    },

    REAL_ESTATE: {
      applies_to: ["Residential, Commercial Projects", "Civil Construction"],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "Lumpy due to project completion accounting." },
        financial_strength: { kpis: ["REV", "ROCE"],          note: "FCF less meaningful due to land-bank capex. Pre-sales (missing) is key." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["OCF", "FCF"],           note: "Collections vs construction spend spread is the real cash quality metric." },
        balance_sheet:      { kpis: ["DE", "IC", "CR"],       note: "NETDEBT_EBITDA (missing) very critical. Pre-sales coverage of debt matters." }
      }
    },

    RETAIL: {
      applies_to: [
        "Diversified Retail", "Speciality Retail",
        "E-Retail/ E-Commerce", "Pharmacy Retail",
        "Internet & Catalogue Retail"
      ],
      pillars: {
        operating_margin:   { kpis: ["OPM", "GPM"],           note: "Gross Margin (GPM) added — key for retail unit economics." },
        financial_strength: { kpis: ["REV", "ROCE"],          note: "FCF less stable during expansion phases; ROCE key for store-level returns." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["OCF", "FCF"],           note: "Inventory-to-cash conversion cycle is the key quality signal." },
        balance_sheet:      { kpis: ["DE", "CR", "IT"],       note: "Inventory Turnover (IT) added as retail-critical efficiency metric." }
      }
    },

    MEDIA_ENTERTAINMENT: {
      applies_to: [
        "Media & Entertainment", "Digital Entertainment",
        "Film Production, Distribution & Exhibition",
        "TV Broadcasting & Software Production"
      ],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "Standard." },
        financial_strength: { kpis: ["REV", "FCF", "ROCE"],  note: "Standard." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Content amortisation makes EBITDA more meaningful than EBIT." },
        cash_flow:          { kpis: ["FCF", "OCF"],           note: "FCF after content capex is the real free cash metric." },
        balance_sheet:      { kpis: ["DE", "CR"],             note: "IC retained. Content library as an asset complicates standard leverage metrics." }
      }
    },

    AIRLINE: {
      applies_to: ["Airline"],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "RASK/CASK (missing) are the industry-standard operating metrics." },
        financial_strength: { kpis: ["REV", "ROCE"],          note: "FCF volatile due to fleet capex and lease obligations." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["OCF", "FCF"],           note: "Standard." },
        balance_sheet:      { kpis: ["DE", "IC"],             note: "CR less critical. PLF (missing) is a unique capacity-utilisation metric." }
      }
    },

    HOSPITALITY: {
      applies_to: [
        "Hotels & Resorts", "Amusement Parks/ Other Recreation",
        "Restaurants", "Tour, Travel Related Services"
      ],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "RevPAR (missing) is the industry-standard revenue metric for hotels." },
        financial_strength: { kpis: ["REV", "ROCE"],          note: "Standard." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["OCF", "FCF"],           note: "Standard." },
        balance_sheet:      { kpis: ["DE", "IC", "CR"],       note: "Standard." }
      }
    },

    OIL_GAS: {
      applies_to: [
        "Oil Exploration & Production", "Oil Storage & Transportation",
        "Refineries & Marketing", "LPG/CNG/PNG/LNG Supplier",
        "Gas Transmission/Marketing", "Trading - Gas"
      ],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "GRM (missing) is critical for refiners. OPM is commodity-price driven." },
        financial_strength: { kpis: ["REV", "FCF", "ROCE"],  note: "Standard." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["FCF", "OCF"],           note: "Standard." },
        balance_sheet:      { kpis: ["DE", "IC", "CR"],       note: "Standard." }
      }
    },

    POWER: {
      applies_to: [
        "Integrated Power Utilities", "Power Generation",
        "Power Distribution", "Power - Transmission", "Power Trading"
      ],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "PLF / Plant Load Factor (missing) is a unique capacity-utilisation metric." },
        financial_strength: { kpis: ["REV", "ROCE"],          note: "FCF often negative during capacity addition cycles." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["OCF", "FCF"],           note: "Standard." },
        balance_sheet:      { kpis: ["DE", "IC"],             note: "Highly leveraged sector. NETDEBT_EBITDA (missing) very critical. CR less relevant." }
      }
    },

    PHARMA_HEALTHCARE: {
      applies_to: ["Pharmaceuticals", "Hospital", "Healthcare Service Provider", "Biotechnology"],
      pillars: {
        operating_margin:   { kpis: ["OPM"],                  note: "Standard. R&D spend ratio (missing) is a key supplementary metric." },
        financial_strength: { kpis: ["REV", "FCF", "ROCE"],  note: "Standard." },
        profitability:      { kpis: ["EBITDA", "NPM"],        note: "Standard." },
        cash_flow:          { kpis: ["FCF", "OCF"],           note: "Standard." },
        balance_sheet:      { kpis: ["DE", "IC", "CR"],       note: "Standard." }
      }
    }

  },

  // ─── Routes each basic_industry to a group ─────────────────────────────────
  // Industries NOT listed here fall back to "default".
  industry_map: {
    "Private Sector Bank":                          "BANKS",
    "Public Sector Bank":                           "BANKS",
    "Other Bank":                                   "BANKS",

    "NBFC":                                         "NBFC_LENDING",
    "Housing Finance Company":                      "NBFC_LENDING",
    "Microfinance Institutions":                    "NBFC_LENDING",
    "Financial Institution":                        "NBFC_LENDING",

    "Life Insurance":                               "INSURANCE",
    "General Insurance":                            "INSURANCE",

    "Asset Management Company":                     "ASSET_WEALTH_MGMT",
    "Financial Products Distributor":               "ASSET_WEALTH_MGMT",
    "Stockbroking & Allied":                        "ASSET_WEALTH_MGMT",
    "Investment Company":                           "ASSET_WEALTH_MGMT",
    "Exchange and Data Platform":                   "ASSET_WEALTH_MGMT",
    "Dep, Clrng Houses and Other Interm":           "ASSET_WEALTH_MGMT",

    "Computers - Software & Consulting":            "IT_SERVICES",
    "Software Products":                            "IT_SERVICES",
    "IT Enabled Services":                          "IT_SERVICES",
    "BPO/KPO":                                      "IT_SERVICES",
    "Healthcare Research, Analytics & Technology":  "IT_SERVICES",
    "Financial Technology (Fintech)":               "IT_SERVICES",

    "Telecom - Cellular & Fixed line services":     "TELECOM",
    "Telecom - Equipment & Accessories":            "TELECOM",
    "Telecom - Infrastructure":                     "TELECOM",
    "Other Telecom Services":                       "TELECOM",

    "Residential, Commercial Projects":             "REAL_ESTATE",
    "Civil Construction":                           "REAL_ESTATE",

    "Diversified Retail":                           "RETAIL",
    "Speciality Retail":                            "RETAIL",
    "E-Retail/ E-Commerce":                         "RETAIL",
    "Pharmacy Retail":                              "RETAIL",
    "Internet & Catalogue Retail":                  "RETAIL",

    "Media & Entertainment":                        "MEDIA_ENTERTAINMENT",
    "Digital Entertainment":                        "MEDIA_ENTERTAINMENT",
    "Film Production, Distribution & Exhibition":   "MEDIA_ENTERTAINMENT",
    "TV Broadcasting & Software Production":        "MEDIA_ENTERTAINMENT",

    "Airline":                                      "AIRLINE",

    "Hotels & Resorts":                             "HOSPITALITY",
    "Amusement Parks/ Other Recreation":            "HOSPITALITY",
    "Restaurants":                                  "HOSPITALITY",
    "Tour, Travel Related Services":                "HOSPITALITY",

    "Oil Exploration & Production":                 "OIL_GAS",
    "Oil Storage & Transportation":                 "OIL_GAS",
    "Refineries & Marketing":                       "OIL_GAS",
    "LPG/CNG/PNG/LNG Supplier":                     "OIL_GAS",
    "Gas Transmission/Marketing":                   "OIL_GAS",
    "Trading - Gas":                                "OIL_GAS",

    "Integrated Power Utilities":                   "POWER",
    "Power Generation":                             "POWER",
    "Power Distribution":                           "POWER",
    "Power - Transmission":                         "POWER",
    "Power Trading":                                "POWER",

    "Pharmaceuticals":                              "PHARMA_HEALTHCARE",
    "Hospital":                                     "PHARMA_HEALTHCARE",
    "Healthcare Service Provider":                  "PHARMA_HEALTHCARE",
    "Biotechnology":                                "PHARMA_HEALTHCARE"
  },

  // ─── Missing KPIs ──────────────────────────────────────────────────────────
  // KPIs not yet in the DB that would fill gaps in the framework.
  // Grouped by sector for readability.
  missing_kpis: [

    // ── Cross-industry (default framework gaps) ──────────────────────────────
    { abbr: "EBITDA_MARGIN",  full_form: "EBITDA Margin",                         type: "ratio",      denomination: null,         applies_to: "default",    note: "EBITDA / Revenue %; needed for profitability pillar. Only EBITDA value exists in DB." },
    { abbr: "FCF_CONV",       full_form: "FCF Conversion Ratio",                  type: "ratio",      denomination: null,         applies_to: "default",    note: "FCF / PAT or FCF / EBITDA; measures earnings-to-cash quality." },
    { abbr: "OCF_EBITDA",     full_form: "OCF to EBITDA Ratio",                   type: "ratio",      denomination: null,         applies_to: "default",    note: "Operating Cash Flow / EBITDA; cash quality & working-capital efficiency signal." },
    { abbr: "NETDEBT",        full_form: "Net Debt",                              type: "standalone", denomination: "INR",        applies_to: "default",    note: "Total Debt − Cash & equivalents; required to calculate NETDEBT_EBITDA." },
    { abbr: "NETDEBT_EBITDA", full_form: "Net Debt to EBITDA Ratio",              type: "ratio",      denomination: null,         applies_to: "default",    note: "Core balance sheet leverage metric missing from balance_sheet pillar." },

    // ── Banking / NBFC ───────────────────────────────────────────────────────
    { abbr: "NIM",            full_form: "Net Interest Margin",                   type: "standalone", denomination: "percentage", applies_to: "BANKS, NBFC_LENDING",   note: "Replaces OPM for lenders; interest income spread on loans." },
    { abbr: "GNPA",           full_form: "Gross Non-Performing Assets Ratio",     type: "standalone", denomination: "percentage", applies_to: "BANKS, NBFC_LENDING",   note: "Asset quality indicator; gross bad loans as % of loan book." },
    { abbr: "NNPA",           full_form: "Net Non-Performing Assets Ratio",       type: "standalone", denomination: "percentage", applies_to: "BANKS, NBFC_LENDING",   note: "Asset quality after provisions." },
    { abbr: "CAR",            full_form: "Capital Adequacy Ratio",                type: "standalone", denomination: "percentage", applies_to: "BANKS, NBFC_LENDING",   note: "Regulatory capital buffer; replaces D/E as the leverage metric for banks." },
    { abbr: "CASA",           full_form: "CASA Ratio",                            type: "standalone", denomination: "percentage", applies_to: "BANKS",                 note: "Current + Savings deposits / Total deposits; proxy for cost of funds." },
    { abbr: "PCR",            full_form: "Provision Coverage Ratio",              type: "standalone", denomination: "percentage", applies_to: "BANKS, NBFC_LENDING",   note: "Provisions held against NPAs; buffer adequacy." },
    { abbr: "CREDITCOST",     full_form: "Credit Cost",                           type: "standalone", denomination: "percentage", applies_to: "BANKS, NBFC_LENDING",   note: "Annual provisioning as % of loan book; affects profitability directly." },
    { abbr: "NETINTINC",      full_form: "Net Interest Income",                   type: "standalone", denomination: "INR",        applies_to: "BANKS, NBFC_LENDING",   note: "Core revenue line for lenders; interest earned minus interest paid." },

    // ── Insurance ────────────────────────────────────────────────────────────
    { abbr: "GWP",            full_form: "Gross Written Premium",                 type: "standalone", denomination: "INR",        applies_to: "INSURANCE",             note: "Primary top-line metric; replaces REV." },
    { abbr: "LR",             full_form: "Loss Ratio",                            type: "standalone", denomination: "percentage", applies_to: "General Insurance",     note: "Claims paid / Earned Premium; core underwriting efficiency." },
    { abbr: "COMBR",          full_form: "Combined Ratio",                        type: "standalone", denomination: "percentage", applies_to: "General Insurance",     note: "Loss Ratio + Expense Ratio; below 100% = profitable underwriting." },
    { abbr: "SOLVR",          full_form: "Solvency Ratio",                        type: "standalone", denomination: "percentage", applies_to: "INSURANCE",             note: "Regulatory capital metric; replaces D/E for insurers." },
    { abbr: "VNB",            full_form: "Value of New Business",                 type: "standalone", denomination: "INR",        applies_to: "Life Insurance",        note: "PV of future profits from new policies; profitability pillar." },
    { abbr: "NBM",            full_form: "New Business Margin",                   type: "standalone", denomination: "percentage", applies_to: "Life Insurance",        note: "VNB / Annualized Premium Equivalent; quality of new business written." },
    { abbr: "PERSISTENCY",    full_form: "Policy Persistency Ratio",              type: "standalone", denomination: "percentage", applies_to: "Life Insurance",        note: "13th / 61st month policy retention; customer quality signal." },

    // ── Telecom ──────────────────────────────────────────────────────────────
    { abbr: "ARPU",           full_form: "Average Revenue Per User",              type: "standalone", denomination: "INR",        applies_to: "TELECOM",               note: "Core revenue productivity metric; not the same as REV." },
    { abbr: "CHURN",          full_form: "Churn Rate",                            type: "standalone", denomination: "percentage", applies_to: "TELECOM",               note: "Monthly subscriber attrition; revenue sustainability signal." },
    { abbr: "DATA_VOL",       full_form: "Data Consumption per User",             type: "standalone", denomination: "units",      applies_to: "TELECOM",               note: "GB per user per month; engagement and ARPU upgrade driver." },

    // ── Airlines ─────────────────────────────────────────────────────────────
    { abbr: "PLF",            full_form: "Passenger Load Factor",                 type: "standalone", denomination: "percentage", applies_to: "AIRLINE",               note: "Seats filled / seats available; primary utilisation metric." },
    { abbr: "RASK",           full_form: "Revenue per Available Seat Kilometer",  type: "standalone", denomination: "INR",        applies_to: "AIRLINE",               note: "Revenue efficiency per unit of capacity." },
    { abbr: "CASK",           full_form: "Cost per Available Seat Kilometer",     type: "standalone", denomination: "INR",        applies_to: "AIRLINE",               note: "Cost efficiency per unit of capacity; RASK − CASK = operating spread." },

    // ── Hotels / Hospitality ─────────────────────────────────────────────────
    { abbr: "REVPAR",         full_form: "Revenue Per Available Room",            type: "standalone", denomination: "INR",        applies_to: "HOSPITALITY",           note: "Occupancy × ADR; the headline operating KPI for hotels." },
    { abbr: "ADR",            full_form: "Average Daily Rate",                    type: "standalone", denomination: "INR",        applies_to: "HOSPITALITY",           note: "Average room rate; pricing power indicator." },
    { abbr: "OCC",            full_form: "Occupancy Rate",                        type: "standalone", denomination: "percentage", applies_to: "HOSPITALITY",           note: "Rooms sold / rooms available." },

    // ── Cement ───────────────────────────────────────────────────────────────
    { abbr: "EBITDA_T",       full_form: "EBITDA per Tonne",                      type: "standalone", denomination: "INR",        applies_to: "Cement & Cement Products",   note: "Volume-normalised profitability; the standard cross-cycle comparison metric." },
    { abbr: "REALIZ_T",       full_form: "Realization per Tonne",                 type: "standalone", denomination: "INR",        applies_to: "Cement & Cement Products",   note: "Net revenue per tonne; pricing metric." },

    // ── Oil & Gas (Refining) ─────────────────────────────────────────────────
    { abbr: "GRM",            full_form: "Gross Refining Margin",                 type: "standalone", denomination: "USD",        applies_to: "Refineries & Marketing",     note: "Margin per barrel processed ($/bbl); core profitability for refiners." },

    // ── Real Estate ──────────────────────────────────────────────────────────
    { abbr: "PRESALES",       full_form: "Pre-Sales / Bookings Value",            type: "standalone", denomination: "INR",        applies_to: "REAL_ESTATE",           note: "Forward revenue visibility; the leading indicator for real estate." },
    { abbr: "COLLN",          full_form: "Collections",                           type: "standalone", denomination: "INR",        applies_to: "REAL_ESTATE",           note: "Cash collected from buyers; cash quality indicator." },
    { abbr: "AREABKD",        full_form: "Area Booked",                           type: "standalone", denomination: "units",      applies_to: "REAL_ESTATE",           note: "Sq ft / sq m booked in the period; volume indicator." },

    // ── Retail ───────────────────────────────────────────────────────────────
    { abbr: "SSSG",           full_form: "Same-Store Sales Growth",               type: "standalone", denomination: "percentage", applies_to: "RETAIL",                note: "Like-for-like growth stripping new store expansion; organic health metric." },
    { abbr: "SQFT",           full_form: "Revenue per Square Foot",               type: "standalone", denomination: "INR",        applies_to: "RETAIL",                note: "Store productivity metric; used alongside STORES." },

    // ── IT / Services ────────────────────────────────────────────────────────
    { abbr: "REV_EMP",        full_form: "Revenue per Employee",                  type: "ratio",      denomination: null,         applies_to: "IT_SERVICES",           note: "Workforce productivity; REV / EMP (both in DB but ratio not created)." },
    { abbr: "ATT",            full_form: "Attrition Rate",                        type: "standalone", denomination: "percentage", applies_to: "IT_SERVICES",           note: "Annual employee churn; a key cost and delivery-risk driver." },
    { abbr: "UTIL",           full_form: "Utilization / Billability Rate",        type: "standalone", denomination: "percentage", applies_to: "IT_SERVICES",           note: "Billable hours / total available hours; margin lever." },

    // ── Power ─────────────────────────────────────────────────────────────────
    { abbr: "PLF_POWER",      full_form: "Plant Load Factor",                     type: "standalone", denomination: "percentage", applies_to: "POWER",                 note: "Actual generation / installed capacity; utilisation and efficiency metric." },
    { abbr: "CAPACITY_MW",    full_form: "Installed Capacity",                    type: "standalone", denomination: "units",      applies_to: "POWER",                 note: "MW / GW of operational generation capacity; scale metric." },

    // ── Pharma ───────────────────────────────────────────────────────────────
    { abbr: "RND_PCT",        full_form: "R&D Expense as % of Revenue",           type: "standalone", denomination: "percentage", applies_to: "PHARMA_HEALTHCARE",     note: "Pipeline investment intensity; forward-looking growth indicator." }
  ]

};

/**
 * Helper: resolve the active pillar config for a given basic_industry string.
 * Returns the group's pillar overrides merged with defaults for any pillar not overridden.
 */
function getPillarsForIndustry(basicIndustry) {
  const groupKey = FRAMEWORK_CONFIG.industry_map[basicIndustry] ?? "default";
  if (groupKey === "default") return FRAMEWORK_CONFIG.default;

  const group = FRAMEWORK_CONFIG.industry_groups[groupKey];
  if (!group) return FRAMEWORK_CONFIG.default;

  // Merge: group pillars override defaults, absent pillars fall back to default
  return {
    ...FRAMEWORK_CONFIG.default,
    ...Object.fromEntries(
      Object.entries(group.pillars).map(([pillar, cfg]) => [
        pillar,
        { ...FRAMEWORK_CONFIG.default[pillar], ...cfg }
      ])
    )
  };
}

module.exports = { FRAMEWORK_CONFIG, getPillarsForIndustry };
