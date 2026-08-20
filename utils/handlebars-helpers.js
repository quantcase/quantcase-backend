'use strict';

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    char =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]
  );
}

module.exports = function registerDashboardHelpers(Handlebars) {

  Handlebars.registerHelper('trendSparkline', function (ctx) {
    if (!ctx) return '';
    const trendStr = String(ctx.status || ctx.trend || ctx.pill || ctx.badge_color || ctx.case || ctx.credibility || ctx.type || 'steady').toLowerCase();
    
    let trendKey = 'steady';
    if (trendStr.includes('rising') || trendStr.includes('improving') || trendStr.includes('positive') || trendStr.includes('strong') || trendStr.includes('achieved')) trendKey = 'rising';
    else if (trendStr.includes('falling') || trendStr.includes('deteriorating') || trendStr.includes('negative') || trendStr.includes('low') || trendStr.includes('miss')) trendKey = 'falling';
    else if (trendStr.includes('watch') || trendStr.includes('concern') || trendStr.includes('risk') || trendStr.includes('warning') || trendStr.includes('moderate')) trendKey = 'watch';
    else if (trendStr.includes('mixed') || trendStr.includes('developing')) trendKey = 'mixed';
    else if (trendStr.includes('new')) trendKey = 'new';
    
    // We duplicate the points mapping inside the helper to be safe
    const points = {
      rising: '6,36 22,30 38,26 54,22 70,19 86,15 104,11',
      steady: '6,23 22,23 38,25 54,22 70,24 86,22 104,22',
      mixed:  '6,25 22,20 38,28 54,18 70,27 86,21 104,24',
      watch:  '6,15 22,17 38,21 54,27 70,31 86,34 104,36',
      falling:'6,12 22,15 38,19 54,24 70,30 86,34 104,37',
      new:    '6,36 22,32 38,28 54,24 70,20 86,16 104,13'
    };
    
    const endYMap = {
      rising: 11,
      steady: 22,
      mixed: 24,
      watch: 36,
      falling: 37,
      new: 13
    };

    const colorMap = {
      rising: 'var(--green-d)',
      steady: 'var(--amber-d)',
      mixed: 'var(--amber-d)',
      watch: 'var(--amber-d)',
      falling: 'var(--red-d)',
      new: 'var(--green-d)'
    };
    
    const p = points[trendKey] || points.steady;
    const y = endYMap[trendKey] || endYMap.steady;
    const hex = colorMap[trendKey] || colorMap.steady;

    return '<svg class="spark" viewBox="0 0 110 46" preserveAspectRatio="xMidYMid meet" aria-hidden="true" style="width:110px;height:46px;display:block">' +
      '<polyline points="' + p + '" fill="none" stroke="' + hex + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="104" cy="' + y + '" r="3.5" fill="' + hex + '"/>' +
    '</svg>';
  });

  const lower = value =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');

  const statusMap = {
    achieved: 'achieved',
    missed: 'missed',
    miss: 'missed',
    tracking: 'tracking',
    unresolved: 'unresolved',
    revised: 'revised',
    reaffirmed: 'reaffirmed',
    discontinued: 'discontinued',
    unclear: 'unclear'
  };

  const trendColors = {
    new: '#4f6ef7',
    rising: '#1c7a4d',
    steady: '#9a9a96',
    mixed: '#a86e0e'
  };

  const statusColors = {
    green: '#1c7a4d',
    red: '#bb3a32',
    amber: '#b1750f'
  };

  const credibilityColors = {
    high: '#1c7a4d',
    mixed: '#b1750f',
    low: '#bb3a32'
  };

  const yMap = {
    high: 70,
    mixed: 115,
    low: 155,
    insufficient: 115
  };

  Handlebars.registerHelper('lower', lower);

  Handlebars.registerHelper('eq', (a, b) => a === b);

  Handlebars.registerHelper("json", function json(value) {
    const serialized = JSON.stringify(value == null ? null : value, null, 2);
    return serialized
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  });

  Handlebars.registerHelper('ratingClass', value => {
    return (
      {
        high: 'strong',
        moderate: 'moderate',
        low: 'low'
      }[lower(value)] || lower(value)
    );
  });

  Handlebars.registerHelper('statusClass', value => {
    return statusMap[lower(value)] || 'unclear';
  });

  Handlebars.registerHelper('statusHex', value => {
    return statusColors[lower(value)] || '#9a9a96';
  });

  Handlebars.registerHelper('credibilityHex', value => {
    return credibilityColors[lower(value)] || '#9a9a96';
  });

  Handlebars.registerHelper('trendHex', value => {
    return trendColors[lower(value)] || '#9a9a96';
  });

  Handlebars.registerHelper('trendGlyph', value => {
    return (
      {
        rising: '▲',
        steady: '—',
        mixed: '◼',
        new: '●'
      }[lower(value)] || ''
    );
  });

  Handlebars.registerHelper('scoreOffset', value => {
    const score = Math.max(0, Math.min(100, Number(value)));
    return (188.5 * (1 - score / 100)).toFixed(2);
  });

  Handlebars.registerHelper('ratioPercent', (credible, total) => {
    if (Number(total) <= 0) {
      return 0;
    }
    const percentage = (Number(credible) / Number(total)) * 100;
    return Math.max(0, Math.min(100, percentage)).toFixed(1);
  });

  Handlebars.registerHelper('typeLabel', value => {
    if (lower(value) === 'demand_led') {
      return 'demand-led';
    }
    return String(value ?? '').replace(/_/g, ' ');
  });

  Handlebars.registerHelper('bold', value => {
    const html = esc(value)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(
        /&lt;strong&gt;(.+?)&lt;\/strong&gt;/g,
        '<strong>$1</strong>'
      );
    return new Handlebars.SafeString(html);
  });

  // Supports both the Stage 3 schema and the supplied JSON schema.
  Handlebars.registerHelper('timelineRows', root => {
    return (
      root.guidance_evidence_timeline ||
      root.guidance_timeline ||
      []
    );
  });

  Handlebars.registerHelper('evidenceText', row => {
    return row.latest_evidence ?? row.management_update ?? '';
  });

  Handlebars.registerHelper('evidenceType', row => {
    return row.evidence_type ?? row.behaviour ?? '';
  });

  Handlebars.registerHelper('effectClass', row => {
    return lower(
      row.effect ??
      row.behaviour_effect ??
      'unknown'
    );
  });

  Handlebars.registerHelper(
    'eachBucket',
    function eachBucket(split, options) {
      return ['controllable', 'demand_led']
        .filter(key => split && split[key])
        .map(key => options.fn(split[key]))
        .join('');
    }
  );

  Handlebars.registerHelper('timelineX', (index, length) => {
    if (length <= 1) {
      return 590;
    }
    return Math.round(
      165 + Number(index) * (850 / (Number(length) - 1))
    );
  });

  Handlebars.registerHelper('markerY', value => {
    return yMap[lower(value)] || 115;
  });

  Handlebars.registerHelper('markerRadius', value => {
    return (
      {
        high: 10,
        medium: 8,
        low: 6
      }[lower(value)] || 6
    );
  });

  Handlebars.registerHelper('timelinePoints', rows => {
    return (rows || [])
      .map((row, index, allRows) => {
        const x =
          allRows.length <= 1
            ? 590
            : Math.round(
                165 + index * (850 / (allRows.length - 1))
              );
        const y = yMap[lower(row.credibility)] || 115;
        return `${x},${y}`;
      })
      .join(' ');
  });

  Handlebars.registerHelper('sparkEndX', value => {
    const lastPoint = String(value || '')
      .trim()
      .split(/\s+/)
      .pop();
    return lastPoint ? lastPoint.split(',')[0] : 0;
  });

  Handlebars.registerHelper('sparkEndY', value => {
    const lastPoint = String(value || '')
      .trim()
      .split(/\s+/)
      .pop();
    return lastPoint ? lastPoint.split(',')[1] : 0;
  });

  Handlebars.registerHelper('trendSparkPoints', function (trend) {
    const points = {
      rising: '6,36 22,30 38,26 54,22 70,19 86,15 104,11',
      steady: '6,23 22,23 38,25 54,22 70,24 86,22 104,22',
      mixed:  '6,25 22,20 38,28 54,18 70,27 86,21 104,24',
      watch:  '6,15 22,17 38,21 54,27 70,31 86,34 104,36',
      falling:'6,12 22,15 38,19 54,24 70,30 86,34 104,37',
      new:    '6,36 22,32 38,28 54,24 70,20 86,16 104,13'
    };

    return points[String(trend || '').toLowerCase()] || points.steady;
  });

  Handlebars.registerHelper('trendSparkEndY', function (trend) {
    const endY = {
      rising: 11,
      steady: 22,
      mixed: 24,
      watch: 36,
      falling: 37,
      new: 13
    };

    return endY[String(trend || '').toLowerCase()] ?? 22;
  });


  Handlebars.registerHelper("shortPeriod", function (date, endDate) {
      const start = String(date || "").trim();
      const end = String(endDate || "").trim();

      // Combine both values so the helper can detect Q information
      // even when only one of the dates contains it.
      const value = `${start} ${end}`;

      // Quarterly period: Q1 FY25, Q4 FY26, Q1FY25, Q3-FY26, etc.
      const quarterMatch = value.match(/\bQ([1-4])\s*[-/]?\s*FY\s*(\d{2,4})\b/i);

      if (quarterMatch) {
          const quarter = quarterMatch[1];
          let year = quarterMatch[2];

          // Always use the last two digits of the FY
          year = year.slice(-2);

          return `Q${quarter}\`${year}`;
      }

      // Financial year: FY25, FY26, FY2026, etc.
      const fyMatch = value.match(/\bFY\s*[-/]?\s*(\d{2,4})\b/i);

      if (fyMatch) {
          const year = fyMatch[1].slice(-2);

          return `FY ${year}`;
      }

      // Anything else → blank
      return "";
  });

};
