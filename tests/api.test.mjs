import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../server.mjs';

async function start(t, databasePath = ':memory:', options = {}) {
  const server = createApplication({ databasePath, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.listening
    ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    : undefined);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    request: async (path, options) => {
      const response = await fetch(`${base}${path}`, options);
      return {
        status: response.status,
        headers: response.headers,
        body: await response.json(),
      };
    },
    dashboard: async () => (await fetch(`${base}/api/dashboard`)).json(),
    post: async (overrides = {}) => {
      const response = await fetch(`${base}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAccount: 'checking', toAccount: 'savings', amount: '100.00', requestId: 'test-request-001', ...overrides }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('$100 transfer succeeds, balances reconcile, and receipt is returned', async (t) => {
  const app = await start(t);
  const { status, body } = await app.post();
  assert.equal(status, 200);
  assert.equal(body.transfer.amountCents, 10000);
  assert.match(body.transfer.id, /^[0-9a-f-]{36}$/);
  assert.equal(body.accounts[0].balanceCents, 235000);
  assert.equal(body.accounts[1].balanceCents, 830000);
  assert.equal(body.accounts.reduce((sum, a) => sum + a.balanceCents, 0), 1065000);
  assert.equal((await app.dashboard()).transfers.length, 1);
});

test('HTTPS hosting allows the configured origin without trusting forwarded headers', async (t) => {
  const app = await start(t, ':memory:', { publicOrigin: 'https://demo.onrender.com' });
  const accepted = await app.request('/api/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://demo.onrender.com' },
    body: JSON.stringify(validTransfer),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.accounts[0].balanceCents, 235000);
  const before = await app.dashboard();
  for (const origin of ['https://other.example', 'http://demo.onrender.com']) {
    const rejected = await app.request('/api/transfers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Host': new URL(origin).host,
        'X-Forwarded-Proto': new URL(origin).protocol.slice(0, -1),
      },
      body: JSON.stringify({ ...validTransfer, requestId: 'hosted-rejected-001' }),
    });
    assertError(rejected, 403, 'Cross-origin transfers are not allowed.');
    assert.deepEqual(await app.dashboard(), before);
  }
});

test('local HTTP origin is accepted without hosting configuration', async (t) => {
  const app = await start(t);
  const result = await app.request('/api/transfers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${app.server.address().port}`,
    },
    body: JSON.stringify(validTransfer),
  });
  assert.equal(result.status, 200);
});

test('invalid hosting origins fail at startup', () => {
  for (const publicOrigin of ['invalid-url', 'ftp://demo.example']) {
    assert.throws(() => createApplication({ databasePath: ':memory:', publicOrigin }), TypeError);
  }
});

test('retrying a request does not debit twice; conflicting reuse fails', async (t) => {
  const app = await start(t);
  const first = await app.post();
  const retry = await app.post();
  assert.equal(retry.body.transfer.id, first.body.transfer.id);
  assert.equal(retry.body.accounts[0].balanceCents, 235000);
  assert.equal((await app.post({ amount: '200.00' })).status, 409);
  assert.equal((await app.dashboard()).transfers.length, 1);
});

const validTransfer = {
  fromAccount: 'checking', toAccount: 'savings',
  amount: '100.00', requestId: 'error-code-test-001',
};
const invalidAmountMessage = 'Enter a valid amount with at most two decimal places.';
const errorCases = [
  { name: 'malformed JSON', raw: '{', status: 400, error: 'Invalid JSON body.' },
  { name: 'null payload', payload: null, status: 400, error: 'A transfer object is required.' },
  { name: 'array payload', payload: [], status: 400, error: 'A transfer object is required.' },
  { name: 'scalar payload', payload: 'transfer', status: 400, error: 'A transfer object is required.' },
  { name: 'missing amount', overrides: { amount: undefined }, status: 400, error: invalidAmountMessage },
  { name: 'numeric amount', overrides: { amount: 100 }, status: 400, error: invalidAmountMessage },
  { name: 'negative amount', overrides: { amount: '-1' }, status: 400, error: invalidAmountMessage },
  { name: 'excess decimal places', overrides: { amount: '1.001' }, status: 400, error: invalidAmountMessage },
  { name: 'non-numeric amount', overrides: { amount: 'NaN' }, status: 400, error: invalidAmountMessage },
  { name: 'zero amount', overrides: { amount: '0.00' }, status: 400, error: 'Transfer amount must be greater than $0.00.' },
  { name: 'missing request ID', overrides: { requestId: undefined }, status: 400, error: 'A valid request ID is required.' },
  { name: 'invalid request ID', overrides: { requestId: 'bad id!' }, status: 400, error: 'A valid request ID is required.' },
  { name: 'missing source account', overrides: { fromAccount: undefined }, status: 400, error: 'Select both accounts.' },
  { name: 'missing destination account', overrides: { toAccount: undefined }, status: 400, error: 'Select both accounts.' },
  { name: 'identical accounts', overrides: { toAccount: 'checking' }, status: 400, error: 'Choose two different accounts.' },
  { name: 'unknown source account', overrides: { fromAccount: 'missing' }, status: 400, error: 'Account not found.' },
  { name: 'unknown destination account', overrides: { toAccount: 'missing' }, status: 400, error: 'Account not found.' },
  { name: 'cross-origin request', headers: { Origin: 'https://other.example' }, status: 403, error: 'Cross-origin transfers are not allowed.' },
  { name: 'unknown endpoint', path: '/api/missing', method: 'GET', status: 404, error: 'Not found.' },
  { name: 'unsupported method', method: 'PUT', status: 404, error: 'Not found.' },
  { name: 'oversized body', raw: JSON.stringify({ ...validTransfer, padding: 'x'.repeat(8192) }), status: 413, error: 'Request is too large.' },
  { name: 'wrong content type', headers: { 'Content-Type': 'text/plain' }, status: 415, error: 'Use application/json for transfers.' },
  { name: 'missing content type', headers: { 'Content-Type': undefined }, status: 415, error: 'Use application/json for transfers.' },
  { name: 'insufficient funds', overrides: { amount: '2450.01' }, status: 422, error: 'Insufficient funds in the source account.' },
];

function assertError(result, status, message) {
  assert.equal(result.status, status);
  assert.match(result.headers.get('content-type'), /^application\/json\b/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.body, { error: message });
}

for (const scenario of errorCases) {
  test(`${scenario.status}: ${scenario.name} leaves balances and history unchanged`, async (t) => {
    const app = await start(t);
    const before = await app.dashboard();
    const method = scenario.method || 'POST';
    const headers = { 'Content-Type': 'application/json', ...scenario.headers };
    // A byte body prevents fetch from automatically adding a text/plain content type.
    const body = Buffer.from(scenario.raw ?? JSON.stringify(
      Object.hasOwn(scenario, 'payload') ? scenario.payload : { ...validTransfer, ...scenario.overrides }
    ));
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    const result = await app.request(scenario.path || '/api/transfers', {
      method, headers, ...(method === 'GET' ? {} : { body }),
    });
    assertError(result, scenario.status, scenario.error);
    assert.deepEqual(await app.dashboard(), before);
  });
}

test('409: conflicting request ID preserves the original transfer', async (t) => {
  const app = await start(t);
  assert.equal((await app.post()).status, 200);
  const before = await app.dashboard();
  for (const changes of [
    { amount: '200.00' },
    { fromAccount: 'savings', toAccount: 'checking' },
  ]) {
    const result = await app.request('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validTransfer, requestId: 'test-request-001', ...changes }),
    });
    assertError(result, 409, 'This request ID was already used for a different transfer.');
    assert.deepEqual(await app.dashboard(), before);
  }
});

test('500: database failure rolls back the debit and hides internal details', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'evergreen-error-test-'));
  const databasePath = join(folder, 'test.sqlite');
  let app;
  let control;
  try {
    app = await start(t, databasePath);
    const before = await app.dashboard();
    control = new DatabaseSync(databasePath);
    // Fail the credit after the debit has executed to verify atomic rollback.
    control.exec(`
      CREATE TRIGGER fail_credit BEFORE UPDATE OF balance_cents ON accounts
      WHEN NEW.balance_cents > OLD.balance_cents
      BEGIN SELECT RAISE(ABORT, 'injected database failure'); END;
    `);
    const logged = t.mock.method(console, 'error', () => {});
    const result = await app.request('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validTransfer),
    });
    assertError(result, 500, 'Something went wrong. Please try again.');
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(logged.mock.calls[0].arguments[0], 'Request failed:');
    assert.match(logged.mock.calls[0].arguments[1].message, /injected database failure/);
    assert.deepEqual(await app.dashboard(), before);
    control.exec('DROP TRIGGER fail_credit');
    assert.equal((await app.post()).status, 200);
  } finally {
    control?.close();
    if (app?.server.listening) await new Promise((resolve) => app.server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});

test('cent precision and reverse transfers are preserved', async (t) => {
  const app = await start(t);
  const result = await app.post({ fromAccount: 'savings', toAccount: 'checking', amount: '0.01' });
  assert.equal(result.body.accounts[0].balanceCents, 245001);
  assert.equal(result.body.accounts[1].balanceCents, 819999);
});

test('concurrent transfers cannot overdraw an account', async (t) => {
  const app = await start(t);
  const results = await Promise.all([
    app.post({ amount: '2000.00', requestId: 'concurrent-001' }),
    app.post({ amount: '2000.00', requestId: 'concurrent-002' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 422]);
  const data = await app.dashboard();
  assert.equal(data.accounts[0].balanceCents, 45000);
  assert.equal(data.transfers.length, 1);
});

test('balances and confirmation survive reopening the database', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'evergreen-test-'));
  const databasePath = join(folder, 'test.sqlite');
  let first;
  let second;
  try {
    first = createApplication({ databasePath });
    first.listen(0, '127.0.0.1');
    await once(first, 'listening');
    const result = await fetch(`http://127.0.0.1:${first.address().port}/api/transfers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromAccount: 'checking', toAccount: 'savings', amount: '100.00', requestId: 'persist-test-001' }),
    });
    assert.equal(result.status, 200);
    const receipt = (await result.json()).transfer.id;
    await new Promise((resolve) => first.close(resolve));
    second = await start(t, databasePath);
    const data = await second.dashboard();
    assert.equal(data.accounts[0].balanceCents, 235000);
    assert.equal(data.transfers[0].id, receipt);
  } finally {
    if (first?.listening) await new Promise((resolve) => first.close(resolve));
    if (second?.server.listening) await new Promise((resolve) => second.server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
