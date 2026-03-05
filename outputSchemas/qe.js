const { isBFSI } = require('../utils/industryClassifier');

// ─── Shared building blocks ───────────────────────────────────────────────────

const val = {
  type: 'object',
  properties: {
    abbr:  { type: 'string' },
    value: { type: ['number', 'null'] }
  },
  required: ['abbr', 'value'],
  additionalProperties: false
};

const metaSchema = (companyType) => ({
  type: 'object',
  properties: {
    company_name:  { type: 'string' },
    company_type:  { type: 'string', const: companyType },
    report_period: { type: 'string', description: 'Period end date in yyyy-mm-dd format' },
    report_type:   { type: 'string', description: 'e.g. Standalone or Consolidated' },
    currency:      { type: 'string' },
    unit:          { type: 'string', description: 'e.g. Crores, Lakhs, Millions' },
    multiplier:    { type: 'string', description: 'e.g. Cr, Lakh, Mn' }
  },
  required: ['company_name', 'company_type', 'report_period', 'report_type', 'currency', 'unit', 'multiplier'],
  additionalProperties: false
});

const cashflowSchema = {
  type: 'object',
  properties: {
    NET_CASH_CHANGE: val,
    CFO:             val,
    CFI:             val,
    CFF:             val
  },
  required: ['NET_CASH_CHANGE', 'CFO', 'CFI', 'CFF'],
  additionalProperties: false
};

const revenueSchema = {
  type: 'object',
  properties: {
    TOTAL_INCOME: val,
    REV_OP:       val,
    OTH_INC:      val
  },
  required: ['TOTAL_INCOME', 'REV_OP', 'OTH_INC'],
  additionalProperties: false
};

const profitLinesSchema = {
  type: 'object',
  properties: {
    TOTAL_TAX_EXP: val,
    PBT_PRE_EXC:   val,
    EXC_ITEMS:     val,
    PBT:           val,
    TAX_EXP:       val,
    PAT:           val
  },
  required: ['TOTAL_TAX_EXP', 'PBT_PRE_EXC', 'EXC_ITEMS', 'PBT', 'TAX_EXP', 'PAT'],
  additionalProperties: false
};

// ─── Non-BFSI ─────────────────────────────────────────────────────────────────

const nonBfsiSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'qe_non_bfsi',
    strict: true,
    schema: {
      type: 'object',
      properties: {

        meta: metaSchema('non_bfsi'),

        balance_sheet: {
          type: 'object',
          properties: {
            assets: {
              type: 'object',
              properties: {
                TOTAL_ASSETS: val,
                non_current: {
                  type: 'object',
                  properties: {
                    NONCURR_ASSETS: val,
                    ASSET_PPE:      val,
                    ASSET_CWIP:     val,
                    INV_NONCURR:    val,
                    LOANS_NONCURR:  val,
                    OTH_ASSET_NC:   val
                  },
                  required: ['NONCURR_ASSETS', 'ASSET_PPE', 'ASSET_CWIP', 'INV_NONCURR', 'LOANS_NONCURR', 'OTH_ASSET_NC'],
                  additionalProperties: false
                },
                current: {
                  type: 'object',
                  properties: {
                    CURR_ASSETS:    val,
                    INVENTORY:      val,
                    INV_CURR:       val,
                    TRADE_RECV:     val,
                    CASH_EQUIV:     val,
                    BANK_BAL_OTHER: val,
                    LOANS_CURR:     val
                  },
                  required: ['CURR_ASSETS', 'INVENTORY', 'INV_CURR', 'TRADE_RECV', 'CASH_EQUIV', 'BANK_BAL_OTHER', 'LOANS_CURR'],
                  additionalProperties: false
                }
              },
              required: ['TOTAL_ASSETS', 'non_current', 'current'],
              additionalProperties: false
            },
            liabilities: {
              type: 'object',
              properties: {
                TOTAL_LIAB: val,
                non_current: {
                  type: 'object',
                  properties: {
                    NONCURR_LIAB: val,
                    DEBT_LT:      val,
                    DTL:          val,
                    PROV_LT:      val
                  },
                  required: ['NONCURR_LIAB', 'DEBT_LT', 'DTL', 'PROV_LT'],
                  additionalProperties: false
                },
                current: {
                  type: 'object',
                  properties: {
                    CURR_LIAB:     val,
                    DEBT_ST:       val,
                    TRADE_PAY:     val,
                    OTH_LIAB_CURR: val,
                    PROV_ST:       val
                  },
                  required: ['CURR_LIAB', 'DEBT_ST', 'TRADE_PAY', 'OTH_LIAB_CURR', 'PROV_ST'],
                  additionalProperties: false
                }
              },
              required: ['TOTAL_LIAB', 'non_current', 'current'],
              additionalProperties: false
            },
            equity: {
              type: 'object',
              properties: {
                NET_WORTH:      val,
                EQ_SHARE_CAP:   val,
                RES_SURPLUS:    val,
                SHARE_WARRANTS: val,
                MINORITY_INT:   val
              },
              required: ['NET_WORTH', 'EQ_SHARE_CAP', 'RES_SURPLUS', 'SHARE_WARRANTS', 'MINORITY_INT'],
              additionalProperties: false
            }
          },
          required: ['assets', 'liabilities', 'equity'],
          additionalProperties: false
        },

        pnl: {
          type: 'object',
          properties: {
            revenue: revenueSchema,
            cogs: {
              type: 'object',
              properties: {
                TOTAL_COGS:  val,
                COST_MAT:    val,
                PURCH_STOCK: val,
                INV_CHG:     val
              },
              required: ['TOTAL_COGS', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG'],
              additionalProperties: false
            },
            operating_expenses: {
              type: 'object',
              properties: {
                TOTAL_OPEX: val,
                EMP_EXP:    val,
                FIN_COST:   val,
                DEP_AMORT:  val,
                OTH_EXP:    val
              },
              required: ['TOTAL_OPEX', 'EMP_EXP', 'FIN_COST', 'DEP_AMORT', 'OTH_EXP'],
              additionalProperties: false
            },
            profit_lines: profitLinesSchema
          },
          required: ['revenue', 'cogs', 'operating_expenses', 'profit_lines'],
          additionalProperties: false
        },

        cashflow: cashflowSchema

      },
      required: ['meta', 'balance_sheet', 'pnl', 'cashflow'],
      additionalProperties: false
    }
  }
};

// ─── BFSI ─────────────────────────────────────────────────────────────────────

const bfsiSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'qe_bfsi',
    strict: true,
    schema: {
      type: 'object',
      properties: {

        meta: metaSchema('bfsi'),

        balance_sheet: {
          type: 'object',
          properties: {
            assets: {
              type: 'object',
              properties: {
                TOTAL_ASSETS: val,
                financial: {
                  type: 'object',
                  properties: {
                    TOTAL_FIN_ASSETS: val,
                    CASH_EQUIV:       val,
                    BANK_BAL:         val,
                    TRADE_RECV:       val,
                    LOANS_ADV:        val,
                    INV_NONCURR:      val
                  },
                  required: ['TOTAL_FIN_ASSETS', 'CASH_EQUIV', 'BANK_BAL', 'TRADE_RECV', 'LOANS_ADV', 'INV_NONCURR'],
                  additionalProperties: false
                },
                non_financial: {
                  type: 'object',
                  properties: {
                    TOTAL_NONFIN_ASSETS: val,
                    ASSET_PPE:           val,
                    ASSET_CWIP:          val,
                    ASSET_GW:            val,
                    ASSET_INTANG:        val,
                    INVENTORY:           val
                  },
                  required: ['TOTAL_NONFIN_ASSETS', 'ASSET_PPE', 'ASSET_CWIP', 'ASSET_GW', 'ASSET_INTANG', 'INVENTORY'],
                  additionalProperties: false
                }
              },
              required: ['TOTAL_ASSETS', 'financial', 'non_financial'],
              additionalProperties: false
            },
            liabilities: {
              type: 'object',
              properties: {
                TOTAL_LIAB: val,
                financial: {
                  type: 'object',
                  properties: {
                    TOTAL_FIN_LIAB: val,
                    DEBT_NONCURR:   val,
                    TRADE_PAY:      val,
                    OTHER_FIN_LIAB: val
                  },
                  required: ['TOTAL_FIN_LIAB', 'DEBT_NONCURR', 'TRADE_PAY', 'OTHER_FIN_LIAB'],
                  additionalProperties: false
                },
                non_financial: {
                  type: 'object',
                  properties: {
                    TOTAL_NONFIN_LIAB: val,
                    PROVISIONS:        val,
                    DTL:               val,
                    OTHER_NONFIN_LIAB: val
                  },
                  required: ['TOTAL_NONFIN_LIAB', 'PROVISIONS', 'DTL', 'OTHER_NONFIN_LIAB'],
                  additionalProperties: false
                }
              },
              required: ['TOTAL_LIAB', 'financial', 'non_financial'],
              additionalProperties: false
            },
            equity: {
              type: 'object',
              properties: {
                NET_WORTH:    val,
                EQ_SHARE_CAP: val,
                RES_SURPLUS:  val,
                MINORITY_INT: val
              },
              required: ['NET_WORTH', 'EQ_SHARE_CAP', 'RES_SURPLUS', 'MINORITY_INT'],
              additionalProperties: false
            }
          },
          required: ['assets', 'liabilities', 'equity'],
          additionalProperties: false
        },

        pnl: {
          type: 'object',
          properties: {
            revenue: revenueSchema,
            cogs: {
              type: 'object',
              properties: {
                TOTAL_COGS: val,
                FIN_COST:   val
              },
              required: ['TOTAL_COGS', 'FIN_COST'],
              additionalProperties: false
            },
            operating_expenses: {
              type: 'object',
              properties: {
                TOTAL_OPEX: val,
                EMP_EXP:    val,
                DEP_AMORT:  val,
                OTH_EXP:    val,
                PROV_CONT:  val
              },
              required: ['TOTAL_OPEX', 'EMP_EXP', 'DEP_AMORT', 'OTH_EXP', 'PROV_CONT'],
              additionalProperties: false
            },
            profit_lines: profitLinesSchema
          },
          required: ['revenue', 'cogs', 'operating_expenses', 'profit_lines'],
          additionalProperties: false
        },

        cashflow: cashflowSchema

      },
      required: ['meta', 'balance_sheet', 'pnl', 'cashflow'],
      additionalProperties: false
    }
  }
};

// ─── Selector ─────────────────────────────────────────────────────────────────

/**
 * Returns the QE output schema for use as OpenRouter response_format.
 * @param {string | null | undefined} basicIndustry
 * @returns {object}
 */
function getQeSchema(basicIndustry) {
  return isBFSI(basicIndustry) ? bfsiSchema : nonBfsiSchema;
}

module.exports = { getQeSchema, nonBfsiSchema, bfsiSchema };
