import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createBank(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS demo_sessions (
      id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
      delay_ms INTEGER NOT NULL DEFAULT 0, fail_next INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS demo_accounts (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, name TEXT NOT NULL, number TEXT NOT NULL,
      balance_cents INTEGER NOT NULL CHECK(balance_cents >= 0),
      PRIMARY KEY(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS demo_transfers (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, request_id TEXT NOT NULL,
      from_account TEXT NOT NULL, to_account TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, id), UNIQUE(session_id, request_id),
      FOREIGN KEY(session_id, from_account) REFERENCES demo_accounts(session_id, id),
      FOREIGN KEY(session_id, to_account) REFERENCES demo_accounts(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS demo_recipients (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, name TEXT NOT NULL, number TEXT NOT NULL,
      PRIMARY KEY(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS demo_bills (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, name TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unpaid',
      PRIMARY KEY(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS demo_cards (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, name TEXT NOT NULL, number TEXT NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 0, limit_cents INTEGER NOT NULL DEFAULT 50000,
      PRIMARY KEY(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS demo_payments (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL,
      target_id TEXT NOT NULL, name TEXT NOT NULL, from_account TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, id), UNIQUE(session_id, request_id),
      FOREIGN KEY(session_id, from_account) REFERENCES demo_accounts(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS demo_schedules (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, request_id TEXT NOT NULL, from_account TEXT NOT NULL,
      to_account TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      message TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(session_id, id), UNIQUE(session_id, request_id),
      FOREIGN KEY(session_id, from_account) REFERENCES demo_accounts(session_id, id),
      FOREIGN KEY(session_id, to_account) REFERENCES demo_accounts(session_id, id)
    );
  `);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const today = () => new Date().toISOString().slice(0, 10);
  function seed(id) {
    run('INSERT INTO demo_accounts VALUES (?, ?, ?, ?, ?)', id, 'checking', 'Everyday Checking', '4829', 245000);
    run('INSERT INTO demo_accounts VALUES (?, ?, ?, ?, ?)', id, 'savings', 'High-Yield Savings', '9012', 820000);
    run('INSERT INTO demo_cards (session_id, id, name, number) VALUES (?, ?, ?, ?)', id, 'debit', 'Everyday debit', '6248');
    for (const [billId, name, amount] of [
      ['electric', 'Evergreen Electric', 8500], ['internet', 'Demo Internet', 6000], ['water', 'City Water', 3500],
    ]) {
      run('INSERT INTO demo_bills (session_id, id, name, amount_cents, due_date) VALUES (?, ?, ?, ?, ?)',
        id, billId, name, amount, today());
    }
  }
  function session(cookieId) {
    run('DELETE FROM demo_sessions WHERE expires_at <= ?', Date.now());
    if (cookieId && get('SELECT id FROM demo_sessions WHERE id = ?', cookieId)) return { id: cookieId, fresh: false };
    if (get('SELECT COUNT(*) AS count FROM demo_sessions').count >= 200) {
      throw new RequestError(503, 'The demo is at capacity. Please try again after existing sessions expire.');
    }
    return transaction(() => {
      const id = randomUUID();
      run('INSERT INTO demo_sessions (id, expires_at) VALUES (?, ?)', id, Date.now() + 86400000);
      seed(id);
      return { id, fresh: true };
    });
  }
  const accounts = (id) => all(`SELECT id, name, number, balance_cents AS balanceCents
    FROM demo_accounts WHERE session_id = ? ORDER BY id`, id);
  const transferByRequest = (id, requestId) => get(`SELECT id, from_account AS fromAccount,
    to_account AS toAccount, amount_cents AS amountCents, created_at AS createdAt
    FROM demo_transfers WHERE session_id = ? AND request_id = ?`, id, requestId);
  function dashboard(id) {
    const transfers = all(`SELECT id, from_account AS fromAccount, to_account AS toAccount,
      amount_cents AS amountCents, created_at AS createdAt FROM demo_transfers
      WHERE session_id = ? ORDER BY rowid DESC`, id);
    const payments = all(`SELECT id, kind, target_id AS targetId, name, from_account AS fromAccount,
      amount_cents AS amountCents, created_at AS createdAt FROM demo_payments
      WHERE session_id = ? ORDER BY rowid DESC`, id);
    return {
      accounts: accounts(id), transfers, payments,
      recipients: all('SELECT id, name, number FROM demo_recipients WHERE session_id = ? ORDER BY name', id),
      bills: all(`SELECT id, name, amount_cents AS amountCents, due_date AS dueDate, status
        FROM demo_bills WHERE session_id = ? ORDER BY id`, id),
      cards: all(`SELECT id, name, number, frozen, limit_cents AS limitCents
        FROM demo_cards WHERE session_id = ?`, id).map((card) => ({
        ...card, frozen: Boolean(card.frozen),
        spentTodayCents: payments.filter((payment) => payment.kind === 'card' && payment.targetId === card.id &&
          payment.createdAt.slice(0, 10) === today()).reduce((sum, payment) => sum + payment.amountCents, 0),
      })),
      schedules: all(`SELECT id, from_account AS fromAccount, to_account AS toAccount,
        amount_cents AS amountCents, due_date AS dueDate, status, message
        FROM demo_schedules WHERE session_id = ? ORDER BY due_date, rowid`, id),
      controls: get('SELECT delay_ms AS delayMs, fail_next AS failNext FROM demo_sessions WHERE id = ?', id),
    };
  }
  function object(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new RequestError(400, 'A transfer object is required.');
    }
  }
  function cents(amount) {
    if (typeof amount !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(amount)) {
      throw new RequestError(400, 'Enter a valid amount with at most two decimal places.');
    }
    const [whole, fraction = ''] = amount.split('.');
    const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (value <= 0) throw new RequestError(400, 'Transfer amount must be greater than $0.00.');
    return value;
  }
  function requestId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(value)) {
      throw new RequestError(400, 'A valid request ID is required.');
    }
  }
  function accountPair(id, input) {
    const { fromAccount, toAccount } = input;
    if (typeof fromAccount !== 'string' || typeof toAccount !== 'string') throw new RequestError(400, 'Select both accounts.');
    if (fromAccount === toAccount) throw new RequestError(400, 'Choose two different accounts.');
    if (![fromAccount, toAccount].every((value) => accounts(id).some((account) => account.id === value))) {
      throw new RequestError(400, 'Account not found.');
    }
  }
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new RequestError(400, 'Enter a valid date (YYYY-MM-DD).');
    }
    return value;
  }
  function debit(id, account, amount) {
    const result = run(`UPDATE demo_accounts SET balance_cents = balance_cents - ?
      WHERE session_id = ? AND id = ? AND balance_cents >= ?`, amount, id, account, amount);
    if (result.changes !== 1) throw new RequestError(422, 'Insufficient funds in the source account.');
  }
  function capacity(id, table, limit = 1000) {
    if (get(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`, id).count >= limit) {
      throw new RequestError(422, 'Demo history limit reached. Reset your demo to continue.');
    }
  }
  function transfer(id, input) {
    object(input);
    const amount = cents(input.amount);
    requestId(input.requestId);
    accountPair(id, input);
    return transaction(() => {
      const previous = transferByRequest(id, input.requestId);
      if (previous) {
        if (previous.fromAccount !== input.fromAccount || previous.toAccount !== input.toAccount || previous.amountCents !== amount) {
          throw new RequestError(409, 'This request ID was already used for a different transfer.');
        }
        return { transfer: previous, ...dashboard(id) };
      }
      capacity(id, 'demo_transfers');
      debit(id, input.fromAccount, amount);
      run('UPDATE demo_accounts SET balance_cents = balance_cents + ? WHERE session_id = ? AND id = ?', amount, id, input.toAccount);
      run('INSERT INTO demo_transfers VALUES (?, ?, ?, ?, ?, ?, ?)', id, randomUUID(), input.requestId,
        input.fromAccount, input.toAccount, amount, new Date().toISOString());
      return { transfer: transferByRequest(id, input.requestId), ...dashboard(id) };
    });
  }
  function recipient(id, input) {
    object(input);
    if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 60 ||
        typeof input.number !== 'string' || !/^\d{4}$/.test(input.number)) {
      throw new RequestError(400, 'Enter a recipient name (2-60 characters) and four demo account digits.');
    }
    if (get('SELECT COUNT(*) AS count FROM demo_recipients WHERE session_id = ?', id).count >= 50) {
      throw new RequestError(422, 'Limit of 50 demo recipients reached. Reset the demo to start over.');
    }
    run('INSERT INTO demo_recipients VALUES (?, ?, ?, ?)', id, randomUUID(), input.name.trim(), input.number);
    return dashboard(id);
  }
  function payment(id, input, withinTransaction = false) {
    object(input);
    const amount = cents(input.amount);
    requestId(input.requestId);
    if (!['bill', 'recipient', 'card'].includes(input.kind) || typeof input.targetId !== 'string' ||
        !accounts(id).some((account) => account.id === input.fromAccount)) {
      throw new RequestError(400, 'Choose a valid payment type, destination, and source account.');
    }
    const action = () => {
      const previous = get(`SELECT id, kind, target_id AS targetId, from_account AS fromAccount,
        amount_cents AS amountCents FROM demo_payments WHERE session_id = ? AND request_id = ?`, id, input.requestId);
      if (previous) {
        if (previous.kind !== input.kind || previous.targetId !== input.targetId ||
            previous.fromAccount !== input.fromAccount || previous.amountCents !== amount) {
          throw new RequestError(409, 'This request ID was already used for a different payment.');
        }
        return { payment: previous, ...dashboard(id) };
      }
      capacity(id, 'demo_payments');
      const tables = { bill: 'demo_bills', recipient: 'demo_recipients', card: 'demo_cards' };
      const target = get(`SELECT * FROM ${tables[input.kind]} WHERE session_id = ? AND id = ?`, id, input.targetId);
      if (!target) throw new RequestError(404, 'Payment destination not found in your demo.');
      if (input.kind === 'bill') {
        if (target.status === 'paid') throw new RequestError(409, 'This bill is already paid.');
        if (amount !== target.amount_cents) throw new RequestError(400, 'Pay the exact bill amount.');
        run("UPDATE demo_bills SET status = 'paid' WHERE session_id = ? AND id = ?", id, target.id);
      }
      if (input.kind === 'card') {
        if (input.fromAccount !== 'checking') throw new RequestError(400, 'The demo debit card uses checking.');
        if (target.frozen) throw new RequestError(422, 'Your card is frozen. Unfreeze it before making a purchase.');
        const spent = get(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM demo_payments
          WHERE session_id = ? AND kind = 'card' AND target_id = ? AND substr(created_at, 1, 10) = ?`, id, target.id, today()).total;
        if (spent + amount > target.limit_cents) throw new RequestError(422, 'This purchase exceeds your daily card limit.');
      }
      debit(id, input.fromAccount, amount);
      const paymentId = randomUUID();
      run('INSERT INTO demo_payments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, paymentId, input.requestId,
        input.kind, target.id, target.name, input.fromAccount, amount, new Date().toISOString());
      return { payment: { id: paymentId, amountCents: amount }, ...dashboard(id) };
    };
    return withinTransaction ? action() : transaction(action);
  }
  function card(id, input) {
    object(input);
    if (typeof input.frozen !== 'boolean') throw new RequestError(400, 'Choose a valid frozen state.');
    const limit = cents(input.limit);
    if (limit > 1000000) throw new RequestError(400, 'The daily card limit cannot exceed $10,000.');
    run('UPDATE demo_cards SET frozen = ?, limit_cents = ? WHERE session_id = ?', Number(input.frozen), limit, id);
    return dashboard(id);
  }
  function schedule(id, input) {
    object(input);
    const amount = cents(input.amount);
    requestId(input.requestId);
    accountPair(id, input);
    const due = date(input.dueDate);
    if (due < today()) throw new RequestError(400, 'Choose today or a future date.');
    const previous = get('SELECT * FROM demo_schedules WHERE session_id = ? AND request_id = ?', id, input.requestId);
    if (previous) {
      if (previous.from_account !== input.fromAccount || previous.to_account !== input.toAccount ||
          previous.amount_cents !== amount || previous.due_date !== due) {
        throw new RequestError(409, 'This request ID was already used for a different schedule.');
      }
      return dashboard(id);
    }
    capacity(id, 'demo_schedules', 100);
    run(`INSERT INTO demo_schedules (session_id, id, request_id, from_account, to_account, amount_cents, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, id, randomUUID(), input.requestId, input.fromAccount, input.toAccount, amount, due);
    return dashboard(id);
  }
  function cancelSchedule(id, input) {
    object(input);
    if (typeof input.id !== 'string') throw new RequestError(400, 'Choose a schedule.');
    if (run(`UPDATE demo_schedules SET status = 'cancelled'
      WHERE session_id = ? AND id = ? AND status = 'pending'`, id, input.id).changes !== 1) {
      throw new RequestError(409, 'Schedule not found or no longer pending.');
    }
    return dashboard(id);
  }
  function processSchedules(id, input) {
    object(input);
    const asOf = date(input.asOf);
    return transaction(() => {
      const due = all("SELECT * FROM demo_schedules WHERE session_id = ? AND status = 'pending' AND due_date <= ? ORDER BY due_date, rowid", id, asOf);
      for (const item of due) {
        const source = accounts(id).find((account) => account.id === item.from_account);
        if (source.balanceCents < item.amount_cents) {
          run("UPDATE demo_schedules SET status = 'failed', message = 'Insufficient funds' WHERE session_id = ? AND id = ?", id, item.id);
          continue;
        }
        capacity(id, 'demo_transfers');
        debit(id, item.from_account, item.amount_cents);
        run('UPDATE demo_accounts SET balance_cents = balance_cents + ? WHERE session_id = ? AND id = ?', item.amount_cents, id, item.to_account);
        run('INSERT INTO demo_transfers VALUES (?, ?, ?, ?, ?, ?, ?)', id, randomUUID(), `schedule-${item.id}`,
          item.from_account, item.to_account, item.amount_cents, new Date().toISOString());
        run("UPDATE demo_schedules SET status = 'completed' WHERE session_id = ? AND id = ?", id, item.id);
      }
      return { processed: due.length, ...dashboard(id) };
    });
  }
  function controls(id, input) {
    object(input);
    if (![0, 1500].includes(input.delayMs) || typeof input.failNext !== 'boolean') {
      throw new RequestError(400, 'Choose a supported delay and failure mode.');
    }
    run('UPDATE demo_sessions SET delay_ms = ?, fail_next = ? WHERE id = ?', input.delayMs, Number(input.failNext), id);
    return dashboard(id);
  }
  function reset(id, input) {
    object(input);
    return transaction(() => {
      for (const table of ['demo_transfers', 'demo_payments', 'demo_schedules', 'demo_recipients', 'demo_bills', 'demo_cards', 'demo_accounts']) {
        run(`DELETE FROM ${table} WHERE session_id = ?`, id);
      }
      run('UPDATE demo_sessions SET delay_ms = 0, fail_next = 0 WHERE id = ?', id);
      seed(id);
      return dashboard(id);
    });
  }
  function samples(id, input) {
    object(input);
    return transaction(() => {
      for (const [index, amount] of ['25.00', '40.00', '15.00'].entries()) {
        payment(id, { kind: 'card', targetId: 'debit', fromAccount: 'checking', amount, requestId: `sample-purchase-${index}` }, true);
      }
      return dashboard(id);
    });
  }
  return {
    session, dashboard, transfer, recipient, payment, card, schedule, cancelSchedule,
    processSchedules, controls, reset, samples,
    simulation: (id) => {
      const settings = get('SELECT delay_ms AS delayMs, fail_next AS failNext FROM demo_sessions WHERE id = ?', id);
      if (settings.failNext) run('UPDATE demo_sessions SET fail_next = 0 WHERE id = ?', id);
      return settings;
    },
    close: () => db.close(),
  };
}
