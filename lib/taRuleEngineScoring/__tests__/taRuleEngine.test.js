'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyStockType } = require('../stockType');
const {
  scoreModule1,
  scoreModule2,
  scoreModule3,
  scoreModule4,
  scoreModule5,
  scoreModule6,
  scoreModule7,
  scoreAllModules,
} = require('../scoringModules');
const {
  computeIdealFor,
  classifyPlaybook,
  computeTradeLevels,
  computeLevelsToWatch,
} = require('../tradeLevels');
const {
  resolveCompositeTag,
  computeDirectionFlag,
} = require('../tagsAndSignals');
const { computeRuleBasedTechnicals } = require('../index');

describe('Step 0 — Stock Type Classification', () => {
  test('Classifies as Value when >= 5 Value conditions match', () => {
    const inputs = {
      adx_avg_100: 20,          // Value (< 25)
      rsi_pct_above_55: 20,
      rsi_pct_below_50: 60,     // Value (> 55%)
      sma200_touch_count: 10,   // Value (>= 3)
      sma200_touch_window_bars: 200,
      sma50_upbar_pct: 30,
      sma50_downbar_pct: 70,    // Value (> 60%)
      price_vs_sma200_pct: -2,  // Value (-10%..+10%)
      wyckoff_phase: 'MARK-UP', // Growth
    };
    const res = classifyStockType(inputs);
    assert.equal(res.stock_type, 'Value');
    assert.equal(res.value_score, 5);
    assert.equal(res.growth_score, 1);
  });

  test('Classifies as Growth when >= 5 Growth conditions match', () => {
    const inputs = {
      adx_avg_100: 35,          // Growth (> 30)
      rsi_pct_above_55: 65,     // Growth (> 60%)
      rsi_pct_below_50: 20,
      sma200_touch_count: 1,    // Growth (<= 2)
      sma200_touch_window_bars: 200,
      sma50_upbar_pct: 70,      // Growth (> 60%)
      sma50_downbar_pct: 30,
      price_vs_sma200_pct: 15,  // Growth (> +10%)
      wyckoff_phase: 'MARK-UP', // Growth
    };
    const res = classifyStockType(inputs);
    assert.equal(res.stock_type, 'Growth');
    assert.equal(res.growth_score, 6);
    assert.equal(res.value_score, 0);
  });

  test('C6 tiebreaker: Re-Accumulation with SMA_200 distance <= 10% resolves to Value', () => {
    const inputs = {
      wyckoff_phase: 'RE-ACCUMULATION',
      price_vs_sma200_pct: 5,
    };
    const res = classifyStockType(inputs);
    assert.equal(res.conditions.C6, 'Value');
  });

  test('C6 tiebreaker: Re-Accumulation with SMA_200 distance > 10% resolves to Growth', () => {
    const inputs = {
      wyckoff_phase: 'RE-ACCUMULATION',
      price_vs_sma200_pct: 12,
    };
    const res = classifyStockType(inputs);
    assert.equal(res.conditions.C6, 'Growth');
  });

  test('Defaults to Value when all stats missing (tied 0-0)', () => {
    const gaps = [];
    const res = classifyStockType({}, gaps);
    assert.equal(res.stock_type, 'Value');
    assert.ok(gaps.length > 0);
  });

  test('Tied classification (growth_score === value_score) resolves to Value', () => {
    const inputs = {
      adx_avg_100: 35,          // Growth (> 30)
      rsi_pct_above_55: 65,     // Growth (> 60%)
      sma200_touch_count: 5,    // Value (>= 3)
      sma50_downbar_pct: 70,    // Value (> 60%)
    };
    const res = classifyStockType(inputs);
    assert.equal(res.growth_score, 2);
    assert.equal(res.value_score, 2);
    assert.equal(res.stock_type, 'Value');
    assert.match(res.classification_note, /tiebreaker/);
  });

  test('Classifies as Value when value_score > growth_score even if < 5', () => {
    const inputs = {
      adx_avg_100: 20,          // Value (< 25)
      sma200_touch_count: 5,    // Value (>= 3)
      sma50_downbar_pct: 70,    // Value (> 60%)
      rsi_pct_above_55: 65,     // Growth (> 60%)
    };
    const res = classifyStockType(inputs);
    assert.equal(res.value_score, 3);
    assert.equal(res.growth_score, 1);
    assert.equal(res.stock_type, 'Value');
  });

  test('Classifies as Growth when growth_score > value_score even if < 5', () => {
    const inputs = {
      adx_avg_100: 35,          // Growth (> 30)
      rsi_pct_above_55: 65,     // Growth (> 60%)
      sma50_upbar_pct: 70,      // Growth (> 60%)
      sma200_touch_count: 5,    // Value (>= 3)
    };
    const res = classifyStockType(inputs);
    assert.equal(res.growth_score, 3);
    assert.equal(res.value_score, 1);
    assert.equal(res.stock_type, 'Growth');
  });
});

describe('Module 1 — Structure / Wyckoff + S/R', () => {
  test('Ambiguity resolution: Distribution with positive CMF, outperforming Nifty, RSI 50-70 -> Re-Accumulation', () => {
    const res = scoreModule1({
      wyckoff_phase: 'DISTRIBUTION',
      cmf_signal: 'POSITIVE',
      crs_stock_vs_nifty: 'OUTPERFORMING',
      rsi_zone: '50-70',
      sr_zone: 'At Support',
    });
    assert.equal(res.resolvedPhase, 'RE-ACCUMULATION');
    assert.equal(res.phaseRelabelled, true);
    assert.equal(res.baseScore, 12);
  });

  test('Markup at support with high strength scores max capped at 20', () => {
    const res = scoreModule1({
      wyckoff_phase: 'MARK-UP',
      sr_zone: 'At Support',
      sr_support_strength: 'HIGH',
    });
    // 14 base + 6 zone + 2 strength = 22 -> clamped to 20
    assert.equal(res.score, 20);
  });

  test('Breakdown with low strength scores floor 0 or penalty', () => {
    const res = scoreModule1({
      wyckoff_phase: 'MARKDOWN',
      sr_zone: 'Breakdown',
    });
    // 0 base - 3 zone = -3 -> clamped to 0
    assert.equal(res.score, 0);
  });
});

describe('Module 2 — Trend / SMA Regime', () => {
  test('Value stock returning to SMA_200 from above with Rising slope scores 18 + 1 = 19', () => {
    const res = scoreModule2(
      {
        price_vs_sma200: 'ABOVE',
        price_vs_sma200_pct: 2,
        sma50_slope: 'Rising',
      },
      'Value'
    );
    assert.equal(res.baseScore, 18);
    assert.equal(res.slopeMod, 1);
    assert.equal(res.score, 19);
  });

  test('Growth stock below all SMAs scores 0', () => {
    const res = scoreModule2(
      {
        price_vs_sma20: 'BELOW',
        price_vs_sma50: 'BELOW',
        price_vs_sma100: 'BELOW',
        price_vs_sma200: 'BELOW',
        sma50_slope: 'Falling',
      },
      'Growth'
    );
    assert.equal(res.score, 0);
  });
});

describe('Module 3 — Momentum / RSI', () => {
  test('Growth stock 50-70 Rising Above scores 15', () => {
    const res = scoreModule3(
      {
        rsi_zone: '50-70',
        rsi_direction: 'RISING',
        price_vs_sma100: 'ABOVE',
        bbw_direction: 'RISING',
      },
      'Growth'
    );
    assert.equal(res.score, 15);
  });

  test('Value stock 30-50 Rising Above scores 15', () => {
    const res = scoreModule3(
      {
        rsi_zone: '30-50',
        rsi_direction: 'RISING',
        price_vs_sma100: 'ABOVE',
        bbw_direction: 'FALLING',
      },
      'Value'
    );
    assert.equal(res.score, 15);
  });
});

describe('Module 4 — Trend Maturity / ADX', () => {
  test('ADX 15-25 Rising Above scores 15', () => {
    const res = scoreModule4({
      adx_zone: '15-25',
      adx_direction: 'RISING',
      price_vs_sma100: 'ABOVE',
    });
    assert.equal(res.score, 15);
  });

  test('ADX FLAT is treated as Falling', () => {
    const res = scoreModule4({
      adx_zone: '25-50',
      adx_direction: 'FLAT',
      price_vs_sma100: 'ABOVE',
    });
    assert.equal(res.score, 8); // 25-50 Falling Above -> 8
  });
});

describe('Module 5 — Leadership / RS', () => {
  test('All 3 outperforming scores 15', () => {
    const res = scoreModule5({
      crs_stock_vs_nifty: 'OUTPERFORMING',
      crs_stock_vs_sector: 'OUTPERFORMING',
      crs_sector_vs_nifty: 'OUTPERFORMING',
    });
    assert.equal(res.score, 15);
  });

  test('All 3 underperforming scores 0', () => {
    const res = scoreModule5({
      crs_stock_vs_nifty: 'UNDERPERFORMING',
      crs_stock_vs_sector: 'UNDERPERFORMING',
      crs_sector_vs_nifty: 'UNDERPERFORMING',
    });
    assert.equal(res.score, 0);
  });

  test('Handles 1 missing leg with gap note', () => {
    const gaps = [];
    const res = scoreModule5(
      {
        crs_stock_vs_nifty: 'OUTPERFORMING',
        crs_stock_vs_sector: 'OUTPERFORMING',
        crs_sector_vs_nifty: 'N/A',
      },
      gaps
    );
    assert.ok(res.score >= 12);
    assert.ok(gaps.length > 0);
  });
});

describe('Module 6 — Capital Flow', () => {
  test('Above average volume + positive CMF scores 10', () => {
    const res = scoreModule6(
      {
        volume_signal: 'ABOVE_AVERAGE',
        cmf_signal: 'POSITIVE',
      },
      'Growth'
    );
    assert.equal(res.score, 10);
  });

  test('Below average volume + negative CMF scores 1 for Growth', () => {
    const res = scoreModule6(
      {
        volume_signal: 'BELOW_AVERAGE',
        cmf_signal: 'NEGATIVE',
      },
      'Growth'
    );
    assert.equal(res.score, 1);
  });
});

describe('Module 7 — Volatility / BBW', () => {
  test('Falling BBW scores 5, Rising scores 2', () => {
    assert.equal(scoreModule7({ bbw_direction: 'Falling' }).score, 5);
    assert.equal(scoreModule7({ bbw_direction: 'Rising' }).score, 2);
  });
});

describe('Ideal-For Horizon Vote', () => {
  test('Votes correctly and breaks ties in favor of Investor', () => {
    const res = computeIdealFor(
      {
        wyckoff_phase: 'ACCUMULATION',
        smaDistancePct: { sma200: 2 }, // triggers investor +1
        sr_zone: 'At Support',         // swing +1, positional +1, investor +1
        volume_signal: 'ABOVE_AVERAGE',// swing +1
        cmf_signal: 'POSITIVE',        // positional +1, investor +1
        crs_sector_vs_nifty: 'UNDER',
      },
      'ACCUMULATION'
    );
    assert.ok(res.idealForScores.investor >= 3);
  });

  test('Returns Not Suitable when all scores <= 3', () => {
    const res = computeIdealFor(
      {
        wyckoff_phase: 'MARKDOWN',
        smaDistancePct: {},
        sr_zone: 'Breakdown',
        volume_signal: 'BELOW_AVERAGE',
        cmf_signal: 'NEGATIVE',
      },
      'MARKDOWN'
    );
    assert.equal(res.idealFor, 'Not Suitable');
    assert.equal(res.timeframe, '-');
  });
});

describe('Playbook Classification', () => {
  test('Fires Breakout with High Conviction when conditions met', () => {
    const res = classifyPlaybook(
      {
        sr_zone: 'Confirmed Breakout',
        wyckoff_phase: 'MARK-UP',
        adx_direction: 'RISING',
        crs_stock_vs_nifty: 'OUTPERFORMING',
        crs_stock_vs_sector: 'OUTPERFORMING',
        crs_sector_vs_nifty: 'UNDERPERFORMING',
      },
      75,
      'MARK-UP'
    );
    assert.equal(res.playbook, 'Breakout');
    assert.equal(res.breakoutQuality, 'High Conviction');
  });

  test('Fires No Setup when final_score < 55', () => {
    const res = classifyPlaybook(
      {
        sr_zone: 'Confirmed Breakout',
        wyckoff_phase: 'MARK-UP',
        adx_direction: 'RISING',
      },
      50,
      'MARK-UP'
    );
    assert.equal(res.playbook, 'No Setup');
    assert.equal(res.breakoutQuality, null);
  });
});

describe('Trade Levels & Buffers', () => {
  test('Computes swing stop loss within 3%-8% buffer band', () => {
    const levels = computeTradeLevels(
      {
        sr_support_price: 5200,
        sr_resistance_price: 6000,
        sma20: 5700,
        sma50: 5400,
        sma100: 5100,
        sma200: 4800,
      },
      { playbook: 'No Setup' }
    );
    assert.equal(levels.swing.idealEntry, 6000);
    // sma20 is 5700. 5700 * 0.98 = 5586. (6000 - 5586)/6000 = 6.9% (in 3%-8%)
    assert.equal(levels.swing.stopLoss, 5586);
    assert.ok(levels.swing.target > levels.swing.idealEntry);
  });
});

describe('Composite Tag Seeded Hash', () => {
  test('Returns identical tag for same symbol, date, and score', () => {
    const res1 = resolveCompositeTag({ symbol: 'INFY' }, 75, 'Growth', 72, 'MARK-UP', '2026-09-15');
    const res2 = resolveCompositeTag({ symbol: 'INFY' }, 75, 'Growth', 72, 'MARK-UP', '2026-09-15');
    assert.equal(res1.tag, res2.tag);
  });

  test('Special situation override fires: Re-Accumulation with score 55-75', () => {
    const res = resolveCompositeTag({ symbol: 'HEROMOTOCO' }, 65, 'Value', 60, 'RE-ACCUMULATION', '2026-09-15');
    assert.equal(res.tag, 'Trend Pausing, Re-Entry Forming');
    assert.equal(res.specialSituation, true);
  });
});
