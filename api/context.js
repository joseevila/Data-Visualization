// GET /api/context - what the browser needs to know about the server. No secrets.
import { handle, send, requireMethod, baseData, configStatus, currentVersion, env } from '../lib/server.js';
import crypto from 'node:crypto';

export default handle(async (req, res) => {
  requireMethod(req, 'GET');
  const base = baseData();
  const cfg = configStatus();
  let supabaseVersion = null, supabaseError = null;
  if (cfg.storage) {
    try { supabaseVersion = await currentVersion(); } catch (e) { supabaseError = e.message; }
  }
  const c = env();
  const given = String(req.headers['x-dashboard-passcode'] || '');
  const authed = !!(c.passcode && given &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(c.passcode).digest()));
  send(res, 200, {
    dataset_version: base.version,
    supabase_version: supabaseVersion,
    versions_match: supabaseVersion === base.version,
    supabase_error: supabaseError,
    configured: cfg,
    authed,
    // Recipient allowlist and data owner are shown only after unlocking.
    recipients: authed ? c.allowed : null,
    data_owner: authed ? c.dataOwner || null : null,
  });
});
