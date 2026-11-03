import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { createBank, RequestError } from './bank.mjs';

const root = dirname(fileURLToPath(import.meta.url));

export function createApplication({ databasePath = join(root, 'data', 'bank.sqlite'), publicOrigin } = {}) {
  const externalUrl = publicOrigin ? new URL(publicOrigin) : undefined;
  if (externalUrl && !['http:', 'https:'].includes(externalUrl.protocol)) {
    throw new TypeError('Public origin must use HTTP or HTTPS.');
  }
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const bank = createBank(databasePath);
  const routes = new Map([
    ['/api/transfers', bank.transfer],
    ['/api/recipients', bank.recipient],
    ['/api/payments', bank.payment],
    ['/api/cards', bank.card],
    ['/api/schedules', bank.schedule],
    ['/api/schedules/cancel', bank.cancelSchedule],
    ['/api/demo/process', bank.processSchedules],
    ['/api/demo/controls', bank.controls],
    ['/api/demo/reset', bank.reset],
    ['/api/demo/samples', bank.samples],
  ]);
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ]);
  const server = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/health') return json(200, { status: 'ok' });
      if ((req.method === 'GET' && path === '/api/dashboard') || (req.method === 'POST' && routes.has(path))) {
        let input;
        if (req.method === 'POST') {
          const expectedOrigin = externalUrl?.origin || `http://${req.headers.host}`;
          if (req.headers.origin && req.headers.origin !== expectedOrigin) {
            throw new RequestError(403, 'Cross-origin transfers are not allowed.');
          }
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
            throw new RequestError(415, 'Use application/json for transfers.');
          }
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 8192) throw new RequestError(413, 'Request is too large.');
            chunks.push(chunk);
          }
          try { input = JSON.parse(Buffer.concat(chunks).toString()); }
          catch { throw new RequestError(400, 'Invalid JSON body.'); }
        }
        const cookieId = req.headers.cookie?.split(';').map((cookie) => cookie.trim())
          .find((cookie) => cookie.startsWith('evergreen_session='))?.slice('evergreen_session='.length);
        const session = bank.session(cookieId);
        if (session.fresh) {
          const secure = externalUrl?.protocol === 'https:' ? '; Secure' : '';
          res.setHeader('Set-Cookie', `evergreen_session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
        }
        if (req.method === 'GET') return json(200, bank.dashboard(session.id));
        if (!path.startsWith('/api/demo/')) {
          const simulation = bank.simulation(session.id);
          if (simulation.delayMs) await setTimeout(simulation.delayMs);
          if (simulation.failNext) throw new RequestError(503, 'Simulated service failure. No money moved; retry to continue.');
        }
        return json(200, routes.get(path)(session.id, input));
      }
      if (req.method === 'GET' && staticFiles.has(path)) {
        const [file, type] = staticFiles.get(path);
        const content = await readFile(join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(content);
      }
      json(404, { error: 'Not found.' });
    } catch (error) {
      if (!(error instanceof RequestError)) console.error('Request failed:', error);
      json(error instanceof RequestError ? error.status : 500, {
        error: error instanceof RequestError ? error.message : 'Something went wrong. Please try again.',
      });
    }
  });
  server.on('close', () => bank.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApplication({
    databasePath: process.env.DB_PATH || undefined,
    publicOrigin: process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL,
  });
  const host = process.env.HOST || '127.0.0.1';
  server.listen(Number(process.env.PORT || 3000), host, () => {
    console.log(`Transfer demo ready at http://${host}:${server.address().port}`);
  });
}
