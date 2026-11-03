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
  let cookie = options.cookie || '';
  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options, headers: { Cookie: cookie, ...options.headers },
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  await request('/api/dashboard');
  return {
    server,
    cookie: () => cookie,
    request,
    dashboard: async () => (await request('/api/dashboard')).body,
    post: async (overrides = {}) => {
      const response = await request('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAccount: 'checking', toAccount: 'savings', amount: '100.00', requestId: 'test-request-001', ...overrides }),
      });
      return response;
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
      CREATE TRIGGER fail_credit BEFORE UPDATE OF balance_cents ON demo_accounts
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
    const firstApp = await start(t, databasePath);
    first = firstApp.server;
    const result = await firstApp.post({ requestId: 'persist-test-001' });
    assert.equal(result.status, 200);
    const receipt = result.body.transfer.id;
    await new Promise((resolve) => first.close(resolve));
    second = await start(t, databasePath, { cookie: firstApp.cookie() });
    const data = await second.dashboard();
    assert.equal(data.accounts[0].balanceCents, 235000);
    assert.equal(data.transfers[0].id, receipt);
  } finally {
    if (first?.listening) await new Promise((resolve) => first.close(resolve));
    if (second?.server.listening) await new Promise((resolve) => second.server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});

const send = (app, path, body) => app.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function otherBrowser(app) {
  let cookie = '';
  return {
    request: async (path, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
        ...options, headers: { Cookie: cookie, ...options.headers },
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

test('browser sessions isolate balances, recipients, schedules, and reset', async (t) => {
  const first = await start(t);
  const second = await otherBrowser(first);
  await second.request('/api/dashboard');
  await first.post();
  const added = await send(first, '/api/recipients', { name: 'Alex Demo', number: '1234' });
  const targetId = added.body.recipients[0].id;
  const date = new Date().toISOString().slice(0, 10);
  const scheduled = await send(first, '/api/schedules', { ...validTransfer, dueDate: date });
  const scheduleId = scheduled.body.schedules[0].id;
  const before = (await second.request('/api/dashboard')).body;
  assert.equal(before.accounts[0].balanceCents, 245000);
  assert.equal(before.recipients.length, 0);
  assert.equal(before.schedules.length, 0);
  assert.equal((await send(second, '/api/payments', {
    kind: 'recipient', targetId, fromAccount: 'checking', amount: '10.00', requestId: 'other-payment-001',
  })).status, 404);
  assert.equal((await send(second, '/api/schedules/cancel', { id: scheduleId })).status, 409);
  assert.deepEqual((await second.request('/api/dashboard')).body, before);
  await send(second, '/api/demo/reset', {});
  assert.equal((await first.dashboard()).accounts[0].balanceCents, 235000);
  assert.equal((await first.dashboard()).recipients.length, 1);
});

test('session cookies are HttpOnly, SameSite, and Secure on HTTPS hosting', async (t) => {
  const app = await start(t, ':memory:', { publicOrigin: 'https://demo.onrender.com' });
  const browser = await otherBrowser(app);
  const response = await browser.request('/api/dashboard');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=86400; Secure/);
  assert.match(response.headers.get('set-cookie'), /^evergreen_session=[0-9a-f-]{36};/);
});

test('recipient validation and payments enforce exact cents and idempotent retries', async (t) => {
  const app = await start(t);
  for (const payload of [{ name: 'A', number: '1234' }, { name: 'Alex', number: '12345' }, { name: null, number: '1234' }]) {
    assert.equal((await send(app, '/api/recipients', payload)).status, 400);
  }
  const added = await send(app, '/api/recipients', { name: ' Alex Demo ', number: '1234' });
  assert.equal(added.body.recipients[0].name, 'Alex Demo');
  const payload = {
    kind: 'recipient', targetId: added.body.recipients[0].id,
    fromAccount: 'savings', amount: '12.34', requestId: 'recipient-pay-001',
  };
  const paid = await send(app, '/api/payments', payload);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.accounts[1].balanceCents, 818766);
  const retry = await send(app, '/api/payments', payload);
  assert.equal(retry.body.payment.id, paid.body.payment.id);
  assert.equal(retry.body.payments.length, 1);
  assert.equal((await send(app, '/api/payments', { ...payload, amount: '15.00' })).status, 409);
  assert.equal((await send(app, '/api/payments', { ...payload, kind: 'unknown' })).status, 400);
  assert.equal((await send(app, '/api/payments', { ...payload, amount: 12.34 })).status, 400);
  assert.equal((await app.dashboard()).payments.length, 1);
});

test('bill payment reconciles balances, marks paid once, and rejects underpayment', async (t) => {
  const app = await start(t);
  const payload = { kind: 'bill', targetId: 'electric', fromAccount: 'checking', amount: '85.00', requestId: 'bill-pay-001' };
  assert.equal((await send(app, '/api/payments', { ...payload, amount: '84.99' })).status, 400);
  const paid = await send(app, '/api/payments', payload);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.accounts[0].balanceCents, 236500);
  assert.equal(paid.body.bills.find((bill) => bill.id === 'electric').status, 'paid');
  const retry = await send(app, '/api/payments', payload);
  assert.equal(retry.body.payment.id, paid.body.payment.id);
  assert.equal((await send(app, '/api/payments', { ...payload, requestId: 'bill-pay-002' })).status, 409);
  assert.equal((await app.dashboard()).payments.length, 1);
});

test('insufficient funds rolls back bill status as well as balance', async (t) => {
  const app = await start(t);
  await app.post({ amount: '2400.00' });
  const before = await app.dashboard();
  assert.equal((await send(app, '/api/payments', {
    kind: 'bill', targetId: 'electric', fromAccount: 'checking', amount: '85.00', requestId: 'bill-fail-001',
  })).status, 422);
  assert.deepEqual(await app.dashboard(), before);
});

test('cards enforce freezing, exact daily limits, and idempotent purchases', async (t) => {
  const app = await start(t);
  const payload = { kind: 'card', targetId: 'debit', fromAccount: 'checking', amount: '25.00', requestId: 'purchase-001' };
  await send(app, '/api/cards', { frozen: true, limit: '50.00' });
  assert.equal((await send(app, '/api/payments', payload)).status, 422);
  assert.equal((await app.dashboard()).payments.length, 0);
  await send(app, '/api/cards', { frozen: false, limit: '50.00' });
  assert.equal((await send(app, '/api/payments', payload)).status, 200);
  assert.equal((await send(app, '/api/payments', payload)).status, 200);
  assert.equal((await send(app, '/api/payments', { ...payload, requestId: 'purchase-002' })).status, 200);
  const before = await app.dashboard();
  assert.equal(before.cards[0].spentTodayCents, 5000);
  assert.equal((await send(app, '/api/payments', { ...payload, amount: '0.01', requestId: 'purchase-003' })).status, 422);
  assert.deepEqual(await app.dashboard(), before);
  assert.equal((await send(app, '/api/cards', { frozen: 'false', limit: '50' })).status, 400);
  assert.equal((await send(app, '/api/cards', { frozen: false, limit: '10000.01' })).status, 400);
});

test('concurrent payments cannot exceed card limit', async (t) => {
  const app = await start(t);
  await send(app, '/api/cards', { frozen: false, limit: '25.00' });
  const payload = { kind: 'card', targetId: 'debit', fromAccount: 'checking', amount: '25.00' };
  const results = await Promise.all(['concurrent-card-001', 'concurrent-card-002'].map((requestId) =>
    send(app, '/api/payments', { ...payload, requestId })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 422]);
  assert.equal((await app.dashboard()).accounts[0].balanceCents, 242500);
});

test('schedules reserve no funds, cancel, process once, and record insufficient funds', async (t) => {
  const app = await start(t);
  const dueDate = new Date().toISOString().slice(0, 10);
  const payload = { ...validTransfer, dueDate };
  const created = await send(app, '/api/schedules', payload);
  assert.equal(created.body.accounts[0].balanceCents, 245000);
  assert.equal((await send(app, '/api/schedules', payload)).body.schedules.length, 1);
  assert.equal((await send(app, '/api/schedules', { ...payload, amount: '200' })).status, 409);
  await send(app, '/api/schedules', { ...payload, requestId: 'schedule-cancel-001' });
  const cancelled = (await app.dashboard()).schedules[1].id;
  await send(app, '/api/schedules/cancel', { id: cancelled });
  await send(app, '/api/schedules', { ...payload, requestId: 'schedule-fail-001', amount: '99999.00' });
  const processed = await send(app, '/api/demo/process', { asOf: dueDate });
  assert.equal(processed.body.processed, 2);
  assert.equal(processed.body.accounts[0].balanceCents, 235000);
  assert.deepEqual(processed.body.schedules.map((item) => item.status), ['completed', 'cancelled', 'failed']);
  const retry = await send(app, '/api/demo/process', { asOf: dueDate });
  assert.equal(retry.body.processed, 0);
  assert.equal(retry.body.transfers.length, 1);
});

test('schedules validate real dates and do not process before due date', async (t) => {
  const app = await start(t);
  const future = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
  for (const dueDate of ['2026-02-30', 'not-a-date', '2000-01-01', null]) {
    assert.equal((await send(app, '/api/schedules', { ...validTransfer, dueDate })).status, 400);
  }
  await send(app, '/api/schedules', { ...validTransfer, dueDate: future });
  const result = await send(app, '/api/demo/process', { asOf: new Date().toISOString().slice(0, 10) });
  assert.equal(result.body.processed, 0);
  assert.equal(result.body.accounts[0].balanceCents, 245000);
});

test('test controls simulate delayed one-shot failure without moving funds', async (t) => {
  const app = await start(t);
  await send(app, '/api/demo/controls', { delayMs: 1500, failNext: true });
  const time = performance.now();
  const failed = await app.post();
  assert.equal(failed.status, 503);
  assert.ok(performance.now() - time >= 1450);
  const after = await app.dashboard();
  assert.equal(after.controls.failNext, 0);
  assert.equal(after.accounts[0].balanceCents, 245000);
  await send(app, '/api/demo/controls', { delayMs: 0, failNext: false });
  assert.equal((await app.post()).status, 200);
  assert.equal((await send(app, '/api/demo/controls', { delayMs: -1, failNext: false })).status, 400);
});

test('sample transactions are atomic, idempotent, and respect card controls', async (t) => {
  const app = await start(t);
  await send(app, '/api/cards', { frozen: false, limit: '50' });
  assert.equal((await send(app, '/api/demo/samples', {})).status, 422);
  assert.equal((await app.dashboard()).payments.length, 0);
  assert.equal((await app.dashboard()).accounts[0].balanceCents, 245000);
  await send(app, '/api/cards', { frozen: false, limit: '100' });
  const loaded = await send(app, '/api/demo/samples', {});
  assert.equal(loaded.body.payments.length, 3);
  assert.equal(loaded.body.accounts[0].balanceCents, 237000);
  const retry = await send(app, '/api/demo/samples', {});
  assert.equal(retry.body.accounts[0].balanceCents, 237000);
  assert.equal(retry.body.payments.length, 3);
  const reset = await send(app, '/api/demo/reset', {});
  assert.equal(reset.body.accounts[0].balanceCents, 245000);
  assert.equal(reset.body.accounts[1].balanceCents, 820000);
  assert.equal(reset.body.payments.length, 0);
  assert.equal(reset.body.cards[0].limitCents, 50000);
});

test('health checks allocate no sessions; capacity rejects new sessions but permits existing ones', async (t) => {
  const app = await start(t);
  const probe = await otherBrowser(app);
  for (let i = 0; i < 205; i++) {
    const health = await probe.request('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok' });
    assert.equal(health.headers.get('set-cookie'), null);
  }
  for (let i = 0; i < 199; i++) {
    const browser = await otherBrowser(app);
    assert.equal((await browser.request('/api/dashboard')).status, 200);
  }
  const extra = await otherBrowser(app);
  const rejected = await extra.request('/api/dashboard');
  assert.equal(rejected.status, 503);
  assert.match(rejected.body.error, /capacity/);
  assert.equal((await app.post()).status, 200);
  assert.equal((await probe.request('/api/health')).status, 200);
});

test('expired sessions cascade-delete only their own data and start with fresh balances', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'evergreen-expiry-test-'));
  const databasePath = join(folder, 'test.sqlite');
  let app;
  let control;
  try {
    app = await start(t, databasePath);
    const second = await otherBrowser(app);
    await second.request('/api/dashboard');
    await app.post();
    await send(app, '/api/recipients', { name: 'Expired Demo', number: '1234' });
    control = new DatabaseSync(databasePath);
    control.prepare('UPDATE demo_sessions SET expires_at = 0 WHERE id = ?').run(app.cookie().split('=')[1]);
    const oldCookie = app.cookie();
    const fresh = await app.dashboard();
    assert.notEqual(app.cookie(), oldCookie);
    assert.equal(fresh.accounts[0].balanceCents, 245000);
    assert.equal(fresh.recipients.length, 0);
    assert.equal(fresh.transfers.length, 0);
    assert.equal(control.prepare('SELECT COUNT(*) AS count FROM demo_sessions').get().count, 2);
    assert.equal(control.prepare('SELECT COUNT(*) AS count FROM demo_recipients').get().count, 0);
    assert.equal((await second.request('/api/dashboard')).body.accounts[0].balanceCents, 245000);
  } finally {
    control?.close();
    if (app?.server.listening) await new Promise((resolve) => app.server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});

test('reset restores all feature state and does not change another session', async (t) => {
  const app = await start(t);
  const other = await otherBrowser(app);
  const otherBefore = (await other.request('/api/dashboard')).body;
  await app.post();
  await send(app, '/api/recipients', { name: 'Reset Demo', number: '1234' });
  await send(app, '/api/payments', { kind: 'bill', targetId: 'water', fromAccount: 'checking', amount: '35.00', requestId: 'reset-bill-001' });
  await send(app, '/api/cards', { frozen: true, limit: '12.34' });
  await send(app, '/api/schedules', { ...validTransfer, dueDate: new Date().toISOString().slice(0, 10) });
  await send(app, '/api/demo/controls', { delayMs: 1500, failNext: true });
  const reset = await send(app, '/api/demo/reset', {});
  assert.equal(reset.body.accounts[0].balanceCents, 245000);
  for (const key of ['transfers', 'payments', 'schedules', 'recipients']) assert.equal(reset.body[key].length, 0);
  assert.ok(reset.body.bills.every((bill) => bill.status === 'unpaid'));
  assert.equal(reset.body.cards[0].frozen, false);
  assert.equal(reset.body.cards[0].limitCents, 50000);
  assert.deepEqual(reset.body.controls, { delayMs: 0, failNext: 0 });
  assert.deepEqual((await other.request('/api/dashboard')).body, otherBefore);
});
