// POST /api/preview - exact preview of what an action will send and/or write. Nothing is sent.
import { handle, send, requireMethod, requirePasscode, body } from '../lib/server.js';
import { prepare } from '../lib/actions.js';

export default handle(async (req, res) => {
  requireMethod(req, 'POST');
  requirePasscode(req);
  const p = await prepare(req, body(req));
  send(res, 200, { preview: p.preview, preview_hash: p.hash, action: p.action });
});
