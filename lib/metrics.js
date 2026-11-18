// Shared KPI logic. The browser and the server functions import this same file, so a number
// in an email or an audit row is computed exactly the way the dashboard computes it.
// Rule from the data contract: rates are sum(numerator) / sum(denominator) per group, never averaged.

export const ORD = {
  stage: ['Idea', 'Pre-seed', 'Seed', 'Series A', 'Series B+'],
  founder_age_band: ['Under 25', '25-34', '35-44', '45-54', '55+'],
  age_band: ['18-24', '25-34', '35-44', '45-54', '55+'],
  choice_matched_signal: ['Yes', 'Unclear', 'No'],
  survey_wave: ['2025 wave', '2026 wave'],
  raise_readiness: ['Ready', 'Borderline', 'Not yet'],
  primary_success_definition: ['Sustainable revenue', 'Business sale', 'Early exit', 'IPO'],
  prior_founder_outcome: ['First-time', 'Previously failed', 'Previously succeeded'],
};
export const DEFS = ['Sustainable revenue', 'Business sale', 'Early exit', 'IPO'];

export const DS = {
  startups: {
    label: 'Startups', noun: 'startups', yearDim: 'founded_year',
    dims: { sector: 'Sector', stage: 'Stage', funding_type: 'Funding type', region: 'Region', business_model: 'Business model',
      founder_age_band: 'Founder age', prior_founder_outcome: 'Prior founder outcome', cofounder_relationship: 'Co-founders',
      uses_hypothesis_testing: 'Tests hypotheses', scaled_before_pmf: 'Scaled before PMF', recommended_fix: 'Recommended fix',
      pivot_signal: 'Pivot signal', raise_readiness: 'Raise readiness', founded_year: 'Founded year' },
    filters: ['sector', 'stage', 'funding_type', 'region', 'founded_year'],
    metrics: {
      survival: { label: '36-month survival rate', type: 'rate', num: (r) => r.survived_36m, elig: (r) => r.survived_36m != null,
        note: 'Startups whose 36-month mark is after the Sept 2026 cut-off are excluded, not counted as failures.' },
      top10: { label: 'Share reaching top 10%', type: 'rate', num: (r) => r.top10, elig: (r) => r.top10 != null },
      runway: { label: 'Median runway', type: 'median', val: (r) => r.runway_months, unit: ' mo' },
      pmf: { label: 'Median PMF score', type: 'median', val: (r) => r.pmf_score_pct, unit: '%' },
      ltv: { label: 'Median LTV / CAC', type: 'median', val: (r) => r.ltv_cac_ratio, unit: 'x' },
      growth: { label: 'Average monthly growth', type: 'mean', val: (r) => r.mom_growth_pct, unit: '%' },
      churn: { label: 'Average monthly churn', type: 'mean', val: (r) => r.monthly_churn_pct, unit: '%' },
      exp: { label: 'Average industry experience', type: 'mean', val: (r) => r.industry_experience_yrs, unit: ' yrs' },
      count: { label: 'Number of startups', type: 'count' },
      funding: { label: 'Total funding raised', type: 'sum', val: (r) => r.funding_raised_usd / 1e6, unit: 'M' },
    },
  },
  decisions: {
    label: 'Decisions', noun: 'decisions', yearDim: 'decision_year',
    dims: { decision_type: 'Decision type', evidence_basis: 'Evidence used', choice_matched_signal: 'Choice matched signal',
      option_chosen: 'Option chosen', trigger: 'Trigger', decision_year: 'Decision year', sector: 'Sector', stage: 'Stage',
      funding_type: 'Funding type', region: 'Region', founder_age_band: 'Founder age', round_sought: 'Round sought' },
    filters: ['decision_type', 'sector', 'stage', 'funding_type', 'region', 'decision_year'],
    metrics: {
      payoff: { label: 'Decision pay-off rate', type: 'rate', num: (r) => r.decision_paid_off, elig: () => true },
      raise: { label: 'Raise close rate', type: 'rate', num: (r) => r.raise_closed, elig: (r) => r.raise_attempt === 1,
        note: 'Only "Raise now" decisions count; a decision that did not try to raise is not a failed raise.' },
      mrr: { label: 'Average revenue change after 12 months', type: 'mean', val: (r) => r.mrr_change_12m_pct, unit: '%' },
      exps: { label: 'Average experiments run before deciding', type: 'mean', val: (r) => r.experiments_run_before },
      count: { label: 'Number of decisions', type: 'count' },
    },
  },
  survey: {
    label: 'Success survey', noun: 'respondents', yearDim: 'survey_wave',
    dims: { primary_success_definition: 'Definition of success', survey_wave: 'Survey wave', sector: 'Sector', stage: 'Stage',
      funding_type: 'Funding type', region: 'Region', age_band: 'Age band', founder_type: 'Founder type' },
    filters: ['survey_wave', 'sector', 'stage', 'funding_type', 'region'],
    metrics: {
      rev: { label: 'Share choosing sustainable revenue', type: 'rate', num: (r) => (r.primary_success_definition === 'Sustainable revenue' ? 1 : 0), elig: () => true },
      ipo: { label: 'Share choosing IPO', type: 'rate', num: (r) => (r.primary_success_definition === 'IPO' ? 1 : 0), elig: () => true },
      mix: { label: 'Definition mix', type: 'mix' },
      sell: { label: 'Would sell today for USD 10M', type: 'rate', num: (r) => r.would_sell, elig: (r) => r.would_sell != null },
      horizon: { label: 'Average target horizon', type: 'mean', val: (r) => r.target_horizon_years, unit: ' yrs' },
      conf: { label: 'Average confidence of reaching it', type: 'mean', val: (r) => r.confidence_of_reaching_it_pct, unit: '%' },
      count: { label: 'Number of respondents', type: 'count' },
    },
  },
};

// The five KPIs from data contract v1.0, shown on the Overview.
export const KPIS = [['startups', 'survival'], ['decisions', 'payoff'], ['decisions', 'raise'], ['startups', 'runway'], ['survey', 'rev']];

const pad = (p, i) => p + String(i + 1).padStart(5, '0');
function decode(t) {
  return t.rows.map((r) => {
    const o = {};
    t.cats.forEach((c, i) => { o[c] = r[i] < 0 ? null : t.dicts[c][r[i]]; });
    t.nums.forEach((c, j) => { o[c] = r[t.cats.length + j]; });
    return o;
  });
}

export function loadData(json) {
  const startups = decode(json.S).map((r, i) => ({ ...r, id: pad('S', i) }));
  const decisions = decode(json.D).map((r, i) => ({ ...r, id: pad('D', i), startup_id: startups[r.si].id }));
  const survey = decode(json.Q).map((r, i) => ({ ...r, id: pad('R', i) }));
  return { version: json.version, editable: json.editable, counts: json.counts, startups, decisions, survey, edits: {} };
}

// Overlay the latest verified edits (from Supabase) onto the base rows. Returns a new data object.
export function applyEdits(data, edits) {
  const byRecord = {};
  for (const e of edits || []) {
    if (!data.editable[e.field]) continue;
    (byRecord[e.record_id] ||= {})[e.field] = e;
  }
  const startups = data.startups.map((r) => {
    const ed = byRecord[r.id];
    if (!ed) return r;
    const o = { ...r, _edits: ed };
    for (const [f, e] of Object.entries(ed)) o[f] = Number(e.new_value);
    return o;
  });
  return { ...data, startups, edits: byRecord };
}

export function recordIndex(id) {
  const m = /^S(\d{5})$/.exec(String(id || ''));
  return m ? Number(m[1]) - 1 : -1;
}

export function order(dim, vals) {
  if (ORD[dim]) return ORD[dim].filter((v) => vals.includes(v)).concat(vals.filter((v) => !ORD[dim].includes(v)).sort());
  return [...vals].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}
export const keyOf = (r, dim) => (r[dim] == null ? '(blank)' : r[dim]);

// filters: { dim: [values] }. Each dataset applies only the dims it has.
export function filterRows(data, ds, filters) {
  const active = Object.entries(filters || {}).filter(([k, v]) => DS[ds].filters.includes(k) && v && v.length);
  if (!active.length) return data[ds];
  const sets = active.map(([k, v]) => [k, new Set(v.map(String))]);
  return data[ds].filter((r) => sets.every(([k, s]) => s.has(String(r[k]))));
}

export function segmentFilter(rows, segment) {
  if (!segment) return rows;
  let out = rows.filter((r) => String(keyOf(r, segment.group)) === String(segment.value));
  if (segment.split && segment.splitValue != null) out = out.filter((r) => String(keyOf(r, segment.split)) === String(segment.splitValue));
  return out;
}

export function stat(list, m) {
  if (m.type === 'count' || m.type === 'mix') return { v: list.length, n: list.length };
  if (m.type === 'rate') {
    const e = list.filter(m.elig);
    const num = e.reduce((a, r) => a + (m.num(r) || 0), 0);
    return { v: e.length ? num / e.length : null, n: e.length, num, den: e.length, excluded: list.length - e.length };
  }
  const vals = list.map(m.val).filter((v) => v != null && !Number.isNaN(v));
  if (m.type === 'mean') return { v: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length };
  if (m.type === 'sum') return { v: vals.reduce((a, b) => a + b, 0), n: list.length };
  vals.sort((a, b) => a - b);
  const k = vals.length;
  return { v: k ? (k % 2 ? vals[(k - 1) / 2] : (vals[k / 2 - 1] + vals[k / 2]) / 2) : null, n: k };
}

export const isPct = (m) => m.type === 'rate' || m.type === 'mix';
export function fmt(m, v) {
  if (v == null) return m.type === 'rate' ? 'n/a' : '–';
  if (isPct(m)) return (v * 100).toFixed(1) + '%';
  if (m.type === 'count') return Math.round(v).toLocaleString('en-US');
  const u = m.unit || '';
  return u === 'M' ? 'USD ' + v.toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M' : v.toFixed(1) + u;
}
export function fmtField(data, field, v) {
  const f = data.editable[field];
  if (v == null) return '–';
  if (!f) return String(v);
  if (f.unit === 'USD') return 'USD ' + Math.round(v).toLocaleString('en-US');
  if (f.unit === 'months') return Number(v).toFixed(1) + ' mo';
  if (f.unit === 'x') return Number(v).toFixed(2) + 'x';
  return Number(v).toFixed(1) + '%';
}

export function describeFilters(ds, filters) {
  const parts = Object.entries(filters || {})
    .filter(([k, v]) => DS[ds].filters.includes(k) && v && v.length)
    .map(([k, v]) => `${DS[ds].dims[k]}: ${v.join(', ')}`);
  return parts.length ? parts.join('; ') : 'No filters (all records)';
}
export function describeSegment(ds, seg) {
  if (!seg) return null;
  let t = `${DS[ds].dims[seg.group] || seg.group} = ${seg.value}`;
  if (seg.split && seg.splitValue != null) t += `, ${DS[ds].dims[seg.split] || seg.split} = ${seg.splitValue}`;
  return t;
}

// One KPI under filters (+ optional segment). Used by Overview cards, Share finding and Assign investigation.
export function kpi(data, ds, metric, filters, segment) {
  const m = DS[ds].metrics[metric];
  if (!m) throw new Error(`Unknown metric ${ds}.${metric}`);
  const base = filterRows(data, ds, filters);
  const rows = segment ? segmentFilter(base, segment) : base;
  return { m, ds, metric, rows: rows.length, stat: stat(rows, m), all: stat(base, m), value: fmt(m, stat(rows, m).v) };
}

// Grouped series for the Segment chart.
export function compute(data, st) {
  const d = DS[st.ds], m = d.metrics[st.metric];
  const rows = filterRows(data, st.ds, st.filters);
  const overall = stat(rows, m);
  const g = new Map();
  for (const r of rows) { const k = keyOf(r, st.group); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  let cats = order(st.group, [...g.keys()]);
  const gt = new Map(cats.map((c) => [c, stat(g.get(c), m)]));
  cats = cats.filter((c) => (gt.get(c).n || 0) >= (st.minN || 0));
  const sv = (c) => (gt.get(c).v == null ? -Infinity : gt.get(c).v);
  if (st.sort === 'desc') cats.sort((a, b) => sv(b) - sv(a));
  if (st.sort === 'asc') cats.sort((a, b) => sv(a) - sv(b));
  if (st.topN) cats = cats.slice(0, st.topN);
  let series;
  if (!st.split) series = [{ name: m.label, stats: cats.map((c) => gt.get(c)) }];
  else {
    const vals = order(st.split, [...new Set(rows.map((r) => keyOf(r, st.split)))]);
    series = vals.map((s) => ({
      name: s,
      stats: cats.map((c) => {
        const sub = g.get(c).filter((r) => keyOf(r, st.split) === s);
        if (m.type === 'mix') { const tot = g.get(c).length; return { v: tot ? sub.length / tot : null, n: sub.length, num: sub.length, den: tot }; }
        const x = stat(sub, m);
        return st.minN > 0 && (x.n || 0) < st.minN ? { v: null, n: x.n, small: true } : x;
      }),
    }));
  }
  return { d, m, rows, overall, cats, gt, series };
}

// Startups behind a selection: startup rows directly, or the startups behind decisions.
export function recordsFor(data, st) {
  const rows = segmentFilter(filterRows(data, st.ds, st.filters), st.segment && st.segment.ds === st.ds ? st.segment : null);
  if (st.ds === 'startups') return rows;
  if (st.ds === 'decisions') {
    const ids = new Set(rows.map((r) => r.startup_id));
    return data.startups.filter((r) => ids.has(r.id));
  }
  return [];
}
