import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApplication({ databasePath = join(root, 'data', 'bank.sqlite'), publicOrigin } = {}) {
  const externalUrl = publicOrigin ? new URL(publicOrigin) : undefined;
  if (externalUrl && !['http:', 'https:'].includes(externalUrl.protocol)) {
    throw new TypeError('Public origin must use HTTP or HTTPS.');
  }
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, number TEXT NOT NULL,
      balance_cents INTEGER NOT NULL CHECK(balance_cents >= 0)
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
      from_account TEXT NOT NULL REFERENCES accounts(id),
      to_account TEXT NOT NULL REFERENCES accounts(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO accounts VALUES ('checking', 'Everyday Checking', '4829', 245000);
    INSERT OR IGNORE INTO accounts VALUES ('savings', 'High-Yield Savings', '9012', 820000);
  `);

  const accounts = () => db.prepare(
    'SELECT id, name, number, balance_cents AS balanceCents FROM accounts ORDER BY id'
  ).all();
  const transferByRequest = (id) => db.prepare(`
    SELECT id, from_account AS fromAccount, to_account AS toAccount,
      amount_cents AS amountCents, created_at AS createdAt
    FROM transfers WHERE request_id = ?
  `).get(id);
  const dashboard = () => ({
    accounts: accounts(),
    transfers: db.prepare(`
      SELECT id, from_account AS fromAccount, to_account AS toAccount,
        amount_cents AS amountCents, created_at AS createdAt
      FROM transfers ORDER BY rowid DESC LIMIT 20
    `).all(),
  });

  function transfer(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new RequestError(400, 'A transfer object is required.');
    }
    const { fromAccount, toAccount, amount, requestId } = input;
    if (typeof amount !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(amount)) {
      throw new RequestError(400, 'Enter a valid amount with at most two decimal places.');
    }
    const [whole, fraction = ''] = amount.split('.');
    const amountCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (amountCents <= 0) throw new RequestError(400, 'Transfer amount must be greater than $0.00.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) {
      throw new RequestError(400, 'A valid request ID is required.');
    }
    if (typeof fromAccount !== 'string' || typeof toAccount !== 'string') {
      throw new RequestError(400, 'Select both accounts.');
    }
    if (fromAccount === toAccount) throw new RequestError(400, 'Choose two different accounts.');
    const source = accounts().find((account) => account.id === fromAccount);
    const target = accounts().find((account) => account.id === toAccount);
    if (!source || !target) throw new RequestError(400, 'Account not found.');

    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = transferByRequest(requestId);
      if (previous) {
        if (previous.fromAccount !== fromAccount || previous.toAccount !== toAccount ||
            previous.amountCents !== amountCents) {
          throw new RequestError(409, 'This request ID was already used for a different transfer.');
        }
        db.exec('COMMIT');
        return { transfer: previous, ...dashboard() };
      }
      const debit = db.prepare(`
        UPDATE accounts SET balance_cents = balance_cents - ?
        WHERE id = ? AND balance_cents >= ?
      `).run(amountCents, fromAccount, amountCents);
      if (debit.changes !== 1) throw new RequestError(422, 'Insufficient funds in the source account.');
      db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?')
        .run(amountCents, toAccount);
      db.prepare('INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), requestId, fromAccount, toAccount, amountCents, new Date().toISOString());
      const result = { transfer: transferByRequest(requestId), ...dashboard() };
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

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
      if (req.method === 'GET' && path === '/api/dashboard') return json(200, dashboard());
      if (req.method === 'POST' && path === '/api/transfers') {
        const expectedOrigin = externalUrl?.origin || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expectedOrigin) {
          throw new RequestError(403, 'Cross-origin transfers are not allowed.');
        }
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
          throw new RequestError(415, 'Use application/json for transfers.');
        }
        let body = '';
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) throw new RequestError(413, 'Request is too large.');
          body += chunk.toString();
        }
        let input;
        try { input = JSON.parse(body); }
        catch { throw new RequestError(400, 'Invalid JSON body.'); }
        return json(200, transfer(input));
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
  server.on('close', () => db.close());
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
