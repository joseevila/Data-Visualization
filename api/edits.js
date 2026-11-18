// GET /api/edits             latest verified value per record and field (dashboard overlay)
// GET /api/edits?record_id=  full audit trail and reported issues for one record
import { handle, send, requireMethod, configStatus, latestEdits, sb, HttpError } from '../lib/server.js';
import { recordIndex } from '../lib/metrics.js';

export default handle(async (req, res) => {
  requireMethod(req, 'GET');
  if (!configStatus().storage) return send(res, 200, { edits: [], configured: false });
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('record_id');
  if (!id) return send(res, 200, { edits: await latestEdits(), configured: true });
  if (recordIndex(id) < 0) throw new HttpError(400, 'Bad record id.');
  const [history, issues] = await Promise.all([
    sb(`record_edits?select=id,field,old_value,new_value,reason,created_at,action_id&record_id=eq.${id}&order=created_at.desc&limit=200`),
    sb(`data_issues?select=id,audit_edit_id,severity,description,created_at&record_id=eq.${id}&order=created_at.desc&limit=200`),
  ]);
  send(res, 200, { history, issues, configured: true });
});
