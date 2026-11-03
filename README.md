# Evergreen transfer demo

A responsive banking dashboard, Node.js HTTP backend, and persistent SQLite ledger.
**Simulated funds only. No real banking integration.**

## Run

Requires Node.js 22.13+ (uses the built-in experimental `node:sqlite` module).

```powershell
npm install
npm start
```

Open http://127.0.0.1:3000. Checking starts at **$2,450.00** and savings at
**$8,200.00**. Transfer **$100.00** to see checking become **$2,350.00**,
savings become **$8,300.00**, a success confirmation with a transaction ID,
and a completed activity entry.

The database is stored in `data\bank.sqlite` and survives restarts.
`PORT` and `DB_PATH` environment variables override the defaults.
Use `DB_PATH=:memory:` for an ephemeral demo.

## Verify the challenge

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

API tests verify the exact amount, reconciled balances, transaction receipt,
validation without mutations, insufficient funds, cent precision, reverse transfers,
concurrent overdraft prevention, idempotent retries, and persistence after reopening
the database. The browser test uses its own in-memory backend on port 3100 and
verifies the $100 transfer, visible confirmation, account balances, activity,
reload behavior, invalid account selection, insufficient funds, and mobile layout.

### Error-code tests

Run `npm test` for the full backend suite, or only error-code cases:

```powershell
node --test --test-name-pattern="^(400|403|404|409|413|415|422|500):" tests/api.test.mjs
```

| HTTP status | Tested scenarios |
| --- | --- |
| 400 | Malformed JSON, invalid payloads, invalid or zero amounts, missing/invalid request IDs, missing/unknown/same accounts |
| 403 | Cross-origin transfer request |
| 404 | Unknown endpoint or unsupported HTTP method (current API behavior) |
| 409 | Request ID reused with a different amount or account direction |
| 413 | Request body exceeds 8,192 bytes |
| 415 | Missing or non-JSON content type |
| 422 | Insufficient funds |
| 500 | Injected database failure during credit, after the debit |

Each error-code test asserts the exact status, JSON error message, response shape,
content type, no-store caching, and unchanged balances/history. The 500 test also
verifies transaction rollback, server-side error logging, no leaked database
details, and recovery after the fault is removed. Tests use isolated databases
and never change the demo's saved funds.

## API

- `GET /api/dashboard`: accounts (integer `balanceCents`) and latest 20 transfers.
- `POST /api/transfers`: JSON body:

```json
{
  "fromAccount": "checking",
  "toAccount": "savings",
  "amount": "100.00",
  "requestId": "unique-request-0001"
}
```

Returns `transfer`, updated `accounts`, and recent `transfers`. Errors include an
`error` message and a non-2xx HTTP status. Amounts are decimal strings converted
to integer cents. SQLite transactions commit the debit, credit, and receipt
atomically. Reusing the request ID for identical details returns the original
receipt without moving money twice; different details return 409.

## Demo boundaries

The server binds to loopback only. Accounts are seeded demo accounts shared by
all local visitors. There is intentionally no login or multi-user authorization.
Do not expose this service publicly or use it for real funds. Production would
require authentication, account ownership checks, stronger request controls,
auditing, operational monitoring, and a production-grade financial ledger.
