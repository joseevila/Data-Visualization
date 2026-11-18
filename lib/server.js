// Server-only helpers for the /api functions. Secrets come from Vercel environment variables and
// never reach the browser. Every outgoing number is recomputed here from the bundled dataset plus
// the verified edits in Supabase, using the same lib/metrics.js the dashboard uses.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as M from './metrics.js';

let BASE = null;
export function baseData() {
  if (!BASE) BASE = M.loadData(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data.json'), 'utf8')));
  return BASE;
}

export function env() {
  const e = process.env;
  return {
    resendKey: e.RESEND_API_KEY || '',
    from: e.RESEND_FROM || '',
    allowed: (e.ALLOWED_RECIPIENTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    dataOwner: (e.DATA_OWNER_EMAIL || '').trim().toLowerCase(),
    passcode: e.DASHBOARD_PASSCODE || '',
    sbUrl: (e.SUPABASE_URL || '').replace(/\/$/, ''),
    sbKey: e.SUPABASE_SERVICE_ROLE_KEY || '',
    baseUrl: (e.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  };
}

export function configStatus() {
  const c = env();
  const missing = [];
  if (!c.passcode) missing.push('DASHBOARD_PASSCODE');
  if (!c.sbUrl) missing.push('SUPABASE_URL');
  if (!c.sbKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  const emailMissing = [];
  if (!c.resendKey) emailMissing.push('RESEND_API_KEY');
  if (!c.from) emailMissing.push('RESEND_FROM');
  if (!c.allowed.length) emailMissing.push('ALLOWED_RECIPIENTS');
  return { storage: missing.length === 0, email: missing.length === 0 && emailMissing.length === 0, missing: [...missing, ...emailMissing] };
}

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error(e);
      return send(res, 500, { error: 'Server error. Check the audit trail before retrying, in case part of the action went through.' });
    }
  };
}

export function requireMethod(req, method) {
  if (req.method !== method) throw new HttpError(405, `Use ${method}.`);
}

export function requirePasscode(req) {
  const { passcode } = env();
  if (!passcode) throw new HttpError(503, 'Actions are not configured: DASHBOARD_PASSCODE is missing in the server settings.');
  const given = String(req.headers['x-dashboard-passcode'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(passcode).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Wrong passcode.');
}

export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { throw new HttpError(400, 'Body must be JSON.'); }
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
export function checkRecipients(list) {
  const { allowed } = env();
  const to = [...new Set((list || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  if (!to.length) throw new HttpError(400, 'Add at least one recipient.');
  if (to.length > 5) throw new HttpError(400, 'At most 5 recipients per message.');
  for (const t of to) {
    if (!EMAIL.test(t)) throw new HttpError(400, `"${t}" is not a valid email address.`);
    const domain = '@' + t.split('@')[1];
    if (!allowed.includes(t) && !allowed.includes(domain)) throw new HttpError(403, `${t} is not on the recipient allowlist.`);
  }
  return to;
}

// ---- Supabase (service role, server only) --------------------------------------------------
export async function sb(pathAndQuery, { method = 'GET', body: payload, prefer } = {}) {
  const { sbUrl, sbKey } = env();
  if (!sbUrl || !sbKey) throw new HttpError(503, 'Storage is not configured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.');
  const r = await fetch(`${sbUrl}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const msg = (json && (json.message || json.hint)) || `Supabase error ${r.status}`;
    throw new HttpError(r.status === 409 || /not current|between/.test(msg) ? 409 : 502, msg);
  }
  return json;
}

export async function currentVersion() {
  const rows = await sb('dataset_manifest?select=version&is_current=eq.true');
  return rows && rows[0] ? rows[0].version : null;
}

export async function latestEdits(recordId) {
  const q = recordId ? `&record_id=eq.${encodeURIComponent(recordId)}` : '';
  return sb(`v_latest_edit?select=id,record_id,field,old_value,new_value,reason,created_at${q}&order=created_at.desc&limit=5000`);
}

// Base dataset + verified edits = what the dashboard shows.
export async function liveData() {
  const base = baseData();
  const { sbUrl, sbKey } = env();
  if (!sbUrl || !sbKey) return base;
  return M.applyEdits(base, await latestEdits());
}

// ---- Resend ---------------------------------------------------------------------------------
export async function resendSend(msg, idempotencyKey) {
  const { resendKey } = env();
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Resend refused the email: ${json.message || r.status}`);
  return json.id;
}

export async function resendStatus(id) {
  const { resendKey } = env();
  const r = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${resendKey}` } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j ? j.last_event || 'accepted' : null;
}

// ---- Rendering ------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderEmail({ from, to, subject, note, facts, link }) {
  const notice = 'Simulated data for demonstration. Effects are documented generator assumptions, not findings about real startups.';
  const lines = facts.map(([k, v]) => `${k}: ${v}`);
  const text = [note ? note.trim() : null, note ? '' : null, ...lines, link ? `\nOpen this view: ${link}` : null, '', notice]
    .filter((x) => x !== null).join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2333;line-height:1.5">`
    + (note ? `<p style="white-space:pre-wrap">${esc(note.trim())}</p>` : '')
    + `<table style="border-collapse:collapse;margin:8px 0">${facts.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#5d6778">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>`
    + (link ? `<p><a href="${esc(link)}">Open this view in Startup Decision Maker</a></p>` : '')
    + `<p style="color:#8a93a3;font-size:12px">${esc(notice)}</p></div>`;
  return { from, to, subject: subject.trim(), text, html };
}

export function previewHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

export function viewLink(req, state) {
  const base = env().baseUrl || (req.headers.host ? `https://${req.headers.host}` : '');
  if (!base) return null;
  return `${base}/#v=${encodeURIComponent(JSON.stringify(state))}`;
}
