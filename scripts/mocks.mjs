// In-memory Supabase + Resend that mimic the real constraints. Used by the tests and the dev server.
import fs from 'node:fs';
export function installMocks() {
  const DATA = JSON.parse(fs.readFileSync('data.json', 'utf8'));
  Object.assign(process.env, {
    DASHBOARD_PASSCODE: 'test-pass', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc',
    RESEND_API_KEY: 're_test', RESEND_FROM: 'Startup Decision Maker <onboarding@resend.dev>',
    ALLOWED_RECIPIENTS: 'jose@example.com,@team.example.com', DATA_OWNER_EMAIL: 'jose@example.com', PUBLIC_BASE_URL: 'https://sdm.test',
  });
  const db = { action_log: [], record_edits: [], data_issues: [], current: DATA.version, editable: DATA.editable };
  const sent = [];
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 10, 17, 12, 0, seq++)).toISOString();
  const reply = (status, json) => new Response(json == null ? null : JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  function where(rows, params) {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const [, val] = v.split(/^eq\./);
      rows = rows.filter((r) => String(r[k]) === val);
    }
    return rows;
  }
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.host === 'api.resend.com') {
      if (method === 'POST') { const id = `re_${sent.length + 1}`; sent.push({ id, ...body, idem: opts.headers['Idempotency-Key'] }); return reply(200, { id }); }
      return reply(200, { id: u.pathname.split('/').pop(), last_event: 'delivered' });
    }
    const table = u.pathname.replace('/rest/v1/', '');
    const params = [...u.searchParams.entries()];
    if (table === 'dataset_manifest') return reply(200, [{ version: db.current }]);
    if (table === 'v_latest_edit') {
      const latest = {};
      for (const e of db.record_edits) latest[e.record_id + e.field] = e;
      return reply(200, where(Object.values(latest), params));
    }
    const rows = db[table];
    if (method === 'GET') return reply(200, where(rows, params));
    if (method === 'PATCH') { where(rows, params).forEach((r) => Object.assign(r, body)); return reply(204, null); }
    if (method === 'POST') {
      if (body.dataset_version !== db.current) return reply(400, { message: `dataset_version ${body.dataset_version} is not current; reload the dashboard` });
      if (table === 'record_edits') {
        const f = db.editable[body.field];
        if (!f || body.new_value < f.min || body.new_value > f.max) return reply(400, { message: `${body.field} must be between` });
      }
      const row = { id: rows.length + 1, created_at: now(), ...body };
      rows.push(row);
      return reply(201, [row]);
    }
    throw new Error('unmocked ' + method + ' ' + url);
  };
  
  return { db, sent };
}
