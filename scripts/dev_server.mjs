// Local server: static files + the real /api functions. With MOCK=1 it uses in-memory Supabase/Resend.
//   MOCK=1 node scripts/dev_server.mjs   then open http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
if (process.env.MOCK) (await import('./mocks.mjs')).installMocks();
const api = {};
for (const n of ['context', 'edits', 'preview', 'commit']) api[n] = (await import(`../api/${n}.js`)).default;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/api\/(\w+)$/);
  if (m && api[m[1]]) {
    let raw = ''; for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : {};
    return api[m[1]](req, res);
  }
  const f = path.join(process.cwd(), u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(process.cwd()) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('dev server on', process.env.PORT || 3000));
