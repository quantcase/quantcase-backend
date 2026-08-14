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
};
