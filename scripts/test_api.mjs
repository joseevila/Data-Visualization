// End-to-end test of the /api functions with in-memory Supabase and Resend mocks.
//   node scripts/test_api.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DATA = JSON.parse(fs.readFileSync('data.json', 'utf8'));

import { installMocks } from './mocks.mjs';
const { db, sent } = installMocks();

// ---- harness --------------------------------------------------------------------------------
const handlers = {
  context: (await import('../api/context.js')).default, edits: (await import('../api/edits.js')).default,
  preview: (await import('../api/preview.js')).default, commit: (await import('../api/commit.js')).default,
};
async function call(name, { method = 'POST', body, pass = 'test-pass', url = `/api/${name}` } = {}) {
  const req = { method, url, body, headers: { host: 'sdm.test', ...(pass ? { 'x-dashboard-passcode': pass } : {}) } };
  let status, out;
  const res = { setHeader() {}, set statusCode(s) { status = s; }, end(t) { out = JSON.parse(t); } };
  await handlers[name](req, res);
  return { status, ...out };
}
const V = DATA.version;
const state = { view: 'segment', ds: 'startups', metric: 'survival', group: 'sector', filters: { stage: ['Seed'] },
  segment: { ds: 'startups', group: 'sector', value: 'Fintech' } };
let pass = 0; const ok = (name, cond, extra) => { assert.ok(cond, `${name} ${extra ? JSON.stringify(extra).slice(0, 300) : ''}`); pass++; console.log('PASS', name); };

// context
let r = await call('context', { method: 'GET' });
ok('context reports matching versions and unlock', r.status === 200 && r.versions_match && r.authed && r.recipients.length === 2, r);
r = await call('context', { method: 'GET', pass: 'nope' });
ok('context hides allowlist without passcode', r.status === 200 && !r.authed && r.recipients === null);

// auth + validation
r = await call('preview', { body: { action: 'share_finding', dataset_version: V, state, message: { to: ['jose@example.com'], subject: 'x x x' } }, pass: 'wrong' });
ok('wrong passcode rejected', r.status === 401);
r = await call('preview', { body: { action: 'share_finding', dataset_version: 'old', state, message: { to: ['jose@example.com'], subject: 'Finding' } } });
ok('stale dataset version rejected', r.status === 409 && r.reload);
r = await call('preview', { body: { action: 'share_finding', dataset_version: V, state, message: { to: ['someone@gmail.com'], subject: 'Finding' } } });
ok('recipient outside allowlist rejected', r.status === 403);

// share finding: preview -> commit
const share = { action: 'share_finding', dataset_version: V, state, message: { to: ['jose@example.com', 'ana@team.example.com'], subject: 'Fintech seed survival', note: 'Worth a look.' } };
r = await call('preview', { body: share });
ok('share preview has exact email with server-computed KPI', r.status === 200 && r.preview.email.text.includes('36-month survival rate') && r.preview.email.text.includes('Segment: Sector = Fintech'), r);
const p1 = r;
r = await call('commit', { body: { ...share, message: { ...share.message, subject: 'Edited after preview' }, preview_hash: p1.preview_hash, confirm: true } });
ok('commit refuses when text changed after preview', r.status === 409 && r.preview_hash && r.preview_hash !== p1.preview_hash);
r = await call('commit', { body: { ...share, preview_hash: p1.preview_hash } });
ok('commit requires confirm', r.status === 400);
r = await call('commit', { body: { ...share, preview_hash: p1.preview_hash, confirm: true } });
ok('share sent and verified', r.status === 200 && r.resend_id === 're_1' && r.checks.every((c) => c.ok), r);
ok('email sent is exactly the preview', sent[0].text === p1.preview.email.text && sent[0].subject === p1.preview.email.subject && sent[0].idem === `sdm-${r.action_id}`);

// assign investigation
const assign = { action: 'assign_investigation', dataset_version: V, state, due: '2026-12-01', message: { to: ['ana@team.example.com'], subject: 'Investigate Fintech', note: '' } };
r = await call('preview', { body: { ...assign, state: { ...state, segment: null } } });
ok('assign requires a selected bar', r.status === 400);
r = await call('preview', { body: assign });
ok('assign preview shows segment vs all and gap', r.status === 200 && /This segment: .*%/.test(r.preview.email.text) && r.preview.email.text.includes('Gap:'), r);
r = await call('commit', { body: { ...assign, preview_hash: r.preview_hash, confirm: true } });
ok('assign sent and verified', r.status === 200 && r.checks.every((c) => c.ok), r);

// edit record
const edit = { action: 'edit_record', dataset_version: V, state, record_id: 'S00012', field: 'runway_months', new_value: 14.5, reason: 'Corrected from bank statement' };
const before = (await import('../lib/server.js')).baseData().startups[11].runway_months;
r = await call('preview', { body: { ...edit, new_value: 99 } });
ok('out-of-range edit rejected', r.status === 400);
r = await call('preview', { body: { ...edit, record_id: 'S99999' } });
ok('unknown record rejected', r.status === 400);
r = await call('preview', { body: { ...edit, field: 'sector' } });
ok('non-editable field rejected', r.status === 400);
r = await call('preview', { body: { ...edit, expected_old: before } });
ok('edit preview shows from, to and KPI impact', r.status === 200 && r.preview.change.to === '14.5 mo' && /Median runway/.test(r.preview.change.impact), r);
const pe = r;
r = await call('commit', { body: { ...edit, expected_old: before, preview_hash: pe.preview_hash, confirm: true } });
ok('edit stored and read back', r.status === 200 && r.edit_id === 1 && r.checks.every((c) => c.ok), r);
r = await call('commit', { body: { ...edit, expected_old: before, preview_hash: pe.preview_hash, confirm: true } });
ok('second commit of the same preview refused as stale', r.status === 409, r);
r = await call('edits', { method: 'GET', pass: null });
ok('overlay endpoint returns the verified edit', r.edits.length === 1 && r.edits[0].new_value === 14.5);

// report issue on audit entry, default recipient = data owner
const report = { action: 'report_issue', dataset_version: V, state, audit_edit_id: 1, severity: 'high', description: 'Runway edit looks wrong', message: { subject: 'Data issue on S00012' } };
r = await call('preview', { body: report });
ok('issue preview cites audit entry and defaults to data owner', r.status === 200 && r.preview.email.to[0] === 'jose@example.com' && r.preview.email.text.includes('Audit entry: #1'), r);
r = await call('commit', { body: { ...report, preview_hash: r.preview_hash, confirm: true } });
ok('issue stored, emailed and verified', r.status === 200 && r.issue_id === 1 && r.checks.every((c) => c.ok), r);
r = await call('edits', { method: 'GET', pass: null, url: '/api/edits?record_id=S00012' });
ok('record audit shows edit and issue', r.history.length === 1 && r.issues.length === 1);

// dataset changes in Supabase but not in the bundle -> writes refused
db.current = 'newer-version';
r = await call('preview', { body: { ...edit, new_value: 20 } });
r = await call('commit', { body: { ...edit, new_value: 20, preview_hash: r.preview_hash, confirm: true } });
ok('Supabase refuses writes when the bundle is behind', r.status === 409, r);
console.log(`\n${pass} checks passed. Emails sent: ${sent.length}. Actions logged: ${db.action_log.length}.`);
