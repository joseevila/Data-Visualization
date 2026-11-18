// The four dashboard actions. prepare() builds the exact preview (what will be sent and/or written)
// and a hash of it; commit() rebuilds it, refuses if anything changed, then executes and verifies.
import * as M from './metrics.js';
import { HttpError, baseData, liveData, env, sb, checkRecipients, renderEmail, previewHash, viewLink, resendSend, resendStatus } from './server.js';

const ACTIONS = ['share_finding', 'assign_investigation', 'edit_record', 'report_issue'];
const IMPACT = { runway_months: 'runway', pmf_score_pct: 'pmf', ltv_cac_ratio: 'ltv', mom_growth_pct: 'growth', monthly_churn_pct: 'churn' };

function cleanState(s = {}) {
  const ds = M.DS[s.ds] ? s.ds : 'startups';
  const filters = {};
  for (const [k, v] of Object.entries(s.filters || {})) if (Array.isArray(v) && v.length) filters[k] = v.map(String).slice(0, 50);
  const seg = s.segment && M.DS[s.segment.ds] && M.DS[s.segment.ds].dims[s.segment.group]
    ? { ds: s.segment.ds, group: s.segment.group, value: String(s.segment.value),
        ...(s.segment.split && M.DS[s.segment.ds].dims[s.segment.split] && s.segment.splitValue != null ? { split: s.segment.split, splitValue: String(s.segment.splitValue) } : {}) }
    : null;
  return { view: s.view || 'overview', ds, metric: M.DS[ds].metrics[s.metric] ? s.metric : Object.keys(M.DS[ds].metrics)[0],
    group: s.group, split: s.split, filters, segment: seg, record: s.record || null };
}
const basis = (st) => (st.den != null ? `${st.num.toLocaleString('en-US')} of ${st.den.toLocaleString('en-US')}` : `n = ${(st.n || 0).toLocaleString('en-US')}`);
const text = (v, max, label, min = 0) => {
  const s = String(v ?? '').trim();
  if (s.length < min) throw new HttpError(400, `${label} needs at least ${min} characters.`);
  if (s.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters).`);
  return s;
};

export async function prepare(req, input) {
  const action = input.action;
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Unknown action.');
  const base = baseData();
  if (input.dataset_version !== base.version) {
    throw new HttpError(409, `The dashboard is showing dataset ${input.dataset_version || 'unknown'}, but the server has ${base.version}. Reload the page; nothing was sent.`, { reload: true });
  }
  const data = await liveData();
  const state = cleanState(input.state);
  const msg = input.message || {};
  const version = base.version;
  const facts = [];
  let email = null, write = null, preview = {}, context = {};

  if (action === 'share_finding') {
    const seg = state.segment && state.segment.ds === state.ds ? state.segment : null;
    const k = M.kpi(data, state.ds, state.metric, state.filters, seg);
    facts.push(['Finding', `${k.m.label}: ${k.value}`], ['Based on', basis(k.stat)], ['Data', M.DS[state.ds].label],
      ['Filters', M.describeFilters(state.ds, state.filters)]);
    if (seg) facts.push(['Segment', M.describeSegment(state.ds, seg)], [`All filtered ${M.DS[state.ds].noun}`, `${M.fmt(k.m, k.all.v)} (${basis(k.all)})`]);
    if (k.m.note) facts.push(['Note', k.m.note]);
    context = { ds: state.ds, metric: state.metric, filters: state.filters, segment: seg, value: k.stat.v, num: k.stat.num ?? null, den: k.stat.den ?? null, n: k.stat.n };
  }

  if (action === 'assign_investigation') {
    const seg = state.segment;
    if (!seg) throw new HttpError(400, 'Select a bar in the Segment view first.');
    if (!M.DS[seg.ds].metrics[state.metric] || state.ds !== seg.ds) throw new HttpError(400, 'The selected bar belongs to a different dataset than the selected metric.');
    const due = String(input.due || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) throw new HttpError(400, 'Pick a due date.');
    const k = M.kpi(data, seg.ds, state.metric, state.filters, seg);
    if (!k.rows) throw new HttpError(409, 'That bar has no rows under the current filters. Select it again.');
    const gap = k.stat.v != null && k.all.v != null ? k.stat.v - k.all.v : null;
    facts.push(['Investigate', M.describeSegment(seg.ds, seg)], ['Metric', k.m.label],
      ['This segment', `${k.value} (${basis(k.stat)})`], ['All filtered', `${M.fmt(k.m, k.all.v)} (${basis(k.all)})`]);
    if (gap != null) facts.push(['Gap', M.isPct(k.m) ? `${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)} points` : `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}${k.m.unit && k.m.unit !== 'M' ? k.m.unit : ''}`]);
    facts.push(['Filters', M.describeFilters(seg.ds, state.filters)], ['Due', due]);
    context = { ds: seg.ds, metric: state.metric, filters: state.filters, segment: seg, due, value: k.stat.v, all: k.all.v, rows: k.rows };
  }

  if (action === 'edit_record') {
    const i = M.recordIndex(input.record_id);
    if (i < 0 || i >= data.startups.length) throw new HttpError(400, 'That record is not in the current dataset.');
    const field = input.field;
    const def = data.editable[field];
    if (!def) throw new HttpError(400, 'That field cannot be edited.');
    const nv = Number(input.new_value);
    if (input.new_value === '' || input.new_value == null || !Number.isFinite(nv)) throw new HttpError(400, 'Enter a number.');
    if (nv < def.min || nv > def.max) throw new HttpError(400, `${def.label} must be between ${def.min} and ${def.max}.`);
    const rec = data.startups[i];
    const current = rec[field] == null ? null : Number(rec[field]);
    if (input.expected_old != null && current !== Number(input.expected_old)) {
      throw new HttpError(409, `This value changed to ${M.fmtField(data, field, current)} since you opened it. Review again.`, { current });
    }
    if (current === nv) throw new HttpError(400, 'The new value is the same as the current one.');
    const reason = text(input.reason, 500, 'Reason', 3);
    write = { record_id: rec.id, field, old_value: current, new_value: nv, reason };
    preview.change = { record: rec.id, field: def.label, from: M.fmtField(data, field, current), to: M.fmtField(data, field, nv), reason };
    if (IMPACT[field]) {
      const m = M.DS.startups.metrics[IMPACT[field]];
      const before = M.kpi(data, 'startups', IMPACT[field], state.filters);
      const after = M.kpi(M.applyEdits(data, [{ record_id: rec.id, field, new_value: nv }]), 'startups', IMPACT[field], state.filters);
      preview.change.impact = `${m.label} (current filters): ${before.value} → ${after.value}`;
    }
    context = { record_id: rec.id, field, filters: state.filters };
  }

  if (action === 'report_issue') {
    let recId = input.record_id || null, audit = null;
    if (input.audit_edit_id != null) {
      const rows = await sb(`record_edits?select=id,record_id,field,old_value,new_value,reason,created_at&id=eq.${Number(input.audit_edit_id)}`);
      if (!rows || !rows[0]) throw new HttpError(400, 'That audit entry does not exist.');
      audit = rows[0]; recId = audit.record_id;
    }
    const i = M.recordIndex(recId);
    if (i < 0 || i >= data.startups.length) throw new HttpError(400, 'Report the issue from a record or an audit entry.');
    const rec = data.startups[i];
    const severity = ['low', 'medium', 'high'].includes(input.severity) ? input.severity : null;
    if (!severity) throw new HttpError(400, 'Pick a severity.');
    const description = text(input.description, 2000, 'Description', 5);
    facts.push(['Record', `${rec.id} (${rec.sector}, ${rec.stage}, ${rec.funding_type})`]);
    if (audit) {
      const lbl = data.editable[audit.field] ? data.editable[audit.field].label : audit.field;
      facts.push(['Audit entry', `#${audit.id}: ${lbl} ${M.fmtField(data, audit.field, audit.old_value)} → ${M.fmtField(data, audit.field, audit.new_value)} on ${String(audit.created_at).slice(0, 10)} ("${audit.reason}")`]);
    }
    facts.push(['Severity', severity], ['Issue', description]);
    write = { record_id: rec.id, audit_edit_id: audit ? audit.id : null, severity, description };
    context = { record_id: rec.id, audit_edit_id: audit ? audit.id : null, filters: state.filters };
  }

  if (action !== 'edit_record') {
    facts.push(['Dataset version', version]);
    const to = checkRecipients(msg.to && msg.to.length ? msg.to : action === 'report_issue' && env().dataOwner ? [env().dataOwner] : []);
    const subject = text(msg.subject, 200, 'Subject', 3);
    const note = text(msg.note || '', 4000, 'Message');
    if (!env().from) throw new HttpError(503, 'Email is not configured: RESEND_FROM is missing in the server settings.');
    email = renderEmail({ from: env().from, to, subject, note, facts, link: viewLink(req, state) });
    preview.email = email;
  }

  const hash = previewHash({ action, version, write, email });
  return { action, version, state, context, write, email, preview, hash };
}

export async function commit(req, input) {
  if (input.confirm !== true) throw new HttpError(400, 'Confirm the preview first.');
  const p = await prepare(req, input);
  if (p.hash !== input.preview_hash) {
    throw new HttpError(409, 'Something changed since the preview (data, recipients or wording). Nothing was sent. Review the new preview.', { preview: p.preview, preview_hash: p.hash });
  }
  const [log] = await sb('action_log', {
    method: 'POST', prefer: 'return=representation',
    body: { action: p.action, dataset_version: p.version, context: p.context, recipients: p.email ? p.email.to : [],
      subject: p.email ? p.email.subject : null, body_text: p.email ? p.email.text : null, preview_hash: p.hash, status: 'pending' },
  });
  const checks = [{ label: `Logged as action #${log.id}`, ok: true }];
  const result = { action_id: log.id, checks };

  if (p.action === 'edit_record') {
    const [row] = await sb('record_edits', { method: 'POST', prefer: 'return=representation', body: { ...p.write, dataset_version: p.version, action_id: log.id } });
    await sb(`action_log?id=eq.${log.id}`, { method: 'PATCH', body: { status: 'stored' } });
    const [back] = await sb(`v_latest_edit?select=id,new_value&record_id=eq.${p.write.record_id}&field=eq.${p.write.field}`);
    const ok = back && back.id === row.id && Number(back.new_value) === p.write.new_value;
    checks.push({ label: `Saved as edit #${row.id}`, ok: true }, { label: `Read back from Supabase: ${p.preview.change.to}`, ok });
    result.edit_id = row.id;
    if (!ok) throw new HttpError(500, 'The edit was saved but the read-back did not match. Check the audit trail.', result);
    return result;
  }

  if (p.action === 'report_issue') {
    const [row] = await sb('data_issues', { method: 'POST', prefer: 'return=representation', body: { ...p.write, dataset_version: p.version, action_id: log.id } });
    checks.push({ label: `Issue #${row.id} stored`, ok: true });
    result.issue_id = row.id;
  }

  let resendId;
  try {
    resendId = await resendSend(p.email, `sdm-${log.id}`);
  } catch (e) {
    await sb(`action_log?id=eq.${log.id}`, { method: 'PATCH', body: { status: 'failed', error: String(e.message).slice(0, 500) } });
    checks.push({ label: 'Email not sent', ok: false });
    throw new HttpError(502, `${e.message}. Action #${log.id} is logged as failed; nothing was sent.`, result);
  }
  await sb(`action_log?id=eq.${log.id}`, { method: 'PATCH', body: { status: 'sent', resend_id: resendId } });
  const [back] = await sb(`action_log?select=status,resend_id&id=eq.${log.id}`);
  const delivery = await resendStatus(resendId);
  checks.push({ label: `Resend accepted it (id ${resendId})`, ok: true },
    { label: `Log reads back as "${back.status}"`, ok: back.status === 'sent' && back.resend_id === resendId },
    { label: `Delivery status: ${delivery || 'not reported yet'}`, ok: delivery !== 'bounced' && delivery !== 'failed' });
  result.resend_id = resendId;
  result.to = p.email.to;
  return result;
}
