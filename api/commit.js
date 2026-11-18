// POST /api/commit - executes a previewed action after confirmation, then verifies it.
import { handle, send, requireMethod, requirePasscode, body } from '../lib/server.js';
import { commit } from '../lib/actions.js';

export default handle(async (req, res) => {
  requireMethod(req, 'POST');
  requirePasscode(req);
  send(res, 200, await commit(req, body(req)));
});
