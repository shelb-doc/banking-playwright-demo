# Evergreen transfer demo

A responsive banking test playground, Node.js HTTP backend, and SQLite ledger.
**Simulated funds only. No real banking integration.**

Live demo: https://banking-playwright-demo.onrender.com/

## What you can explore

- **Overview:** combined balances, spending breakdown, and remaining demo bills.
- **Accounts & transactions:** per-account filters, search by name/type/confirmation,
  payment-type filters, and individual receipts.
- **Move money:** review before confirming an instant transfer, or schedule a
  one-time transfer and cancel it while pending.
- **Bills & payments:** pay seeded bills once or send fictional money to a saved
  demo recipient. External payments reduce the source balance; internal transfers
  preserve the combined balance.
- **Recipients:** save invented names and four demo account digits.
- **Cards:** freeze/unfreeze the demo debit card, change a daily spending limit,
  and simulate a purchase. Limits use UTC days and include sample purchases.
- **Test lab:** 1.5-second response delay, a one-shot 503 with no mutation, three
  idempotent sample purchases, manual schedule processing, and session-only reset.

Each browser gets a random HttpOnly, SameSite cookie and its **own isolated
accounts and ledger**. Tabs in the same browser share that session; private
windows or separate browser contexts get fresh accounts. Cookies must be enabled.
Sessions expire after 24 hours (not renewed on activity). This is demo isolation,
not login or production authentication. A full capacity of 200 active sessions
returns an explicit 503 until sessions expire. Expired data is cleaned on API
requests. History is capped at 1,000 transfers and 1,000 payments per session,
with 100 schedules and 50 recipients; reset your demo if a limit is reached.

## Run

Requires Node.js 22.13+ (uses the built-in experimental `node:sqlite` module).

```powershell
npm install
npm start
```

Open http://127.0.0.1:3000 and choose **Move money**. Checking starts at
**$2,450.00** and savings at **$8,200.00**. Review and confirm a **$100.00**
transfer to see checking become **$2,350.00**,
savings become **$8,300.00**, a success confirmation with a transaction ID,
and a completed activity entry.

The database is stored in `data\bank.sqlite` and survives restarts locally.
An unexpired session cookie restores that browser's saved ledger after restart.
New session-isolated data uses `demo_*` tables; any original pre-session
`accounts`/`transfers` tables are left untouched and are not exposed to visitors.
`PORT`, `HOST`, and `DB_PATH` environment variables override the defaults.
Use `DB_PATH=:memory:` for an ephemeral demo.

## Free hosting on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/shelb-doc/banking-playwright-demo)

1. Push this repository, then click **Deploy to Render** and sign in with GitHub.
2. Approve access to this repository and create the Blueprint using `render.yaml`.
3. Confirm the web service uses the **Free** plan. No paid database or disk is needed.
4. After deployment succeeds, open the service's Render URL. GitHub Pages does not
   run this Node.js backend and is not the working app's URL.

The Blueprint pins Node.js, binds to `0.0.0.0` on Render's assigned `PORT`,
and health-checks the session-free `/api/health` endpoint. Render supplies `RENDER_EXTERNAL_URL` so
same-origin transfers work over HTTPS behind its proxy. On another host, set
`PUBLIC_ORIGIN` to the public URL (for example `https://demo.example.com`).
Do not set it to the GitHub Pages URL.

**Free-demo limitations:** SQLite runs in memory and all balances and transfers
reset whenever the process restarts, redeploys, or spins down. Free services
sleep after 15 minutes without traffic; waking can take about a minute. Render
also applies monthly free usage limits. Simulated accounts are isolated per
browser cookie. Never enter real financial or
personal data. This configuration is not suitable for production banking.

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
Additional browser/API tests cover cross-session isolation, recipient and bill
payments, card freezing and daily limits, payment retries, transaction filters
and receipts, manual schedule completion/cancellation/failure, test controls,
sample-data rollback, resetting, and keyboard-accessible review dialogs.

To run the same browser suite against your deployed **demo** (no local server
is started), use PowerShell:

```powershell
$env:PLAYWRIGHT_BASE_URL = 'https://banking-playwright-demo.onrender.com'
npm run test:e2e
Remove-Item Env:\PLAYWRIGHT_BASE_URL
```

Tests create separate browser sessions and only mutate their own simulated data.
Wake the free service first if needed. If you already deployed the older
Blueprint, sync its latest changes in Render so the health check uses
`/api/health`, not `/api/dashboard` (which now creates a browser session).

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

- `GET /api/dashboard`: session accounts (integer `balanceCents`), transfers,
  payments, recipients, bills, cards, schedules, and test controls.
- `GET /api/health`: stateless health check; creates no browser session.
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

All API clients must retain the session cookie from the initial dashboard
response and send it on later requests (Playwright browser contexts do this
automatically). Without that cookie, a request starts a new isolated demo.
All POST bodies must use `Content-Type: application/json`.

| POST endpoint | JSON fields / behavior |
| --- | --- |
| `/api/recipients` | `name` (2-60 characters), `number` (four invented digits) |
| `/api/payments` | `kind` (`bill`, `recipient`, `card`), `targetId`, `fromAccount`, `amount` (decimal string), `requestId` |
| `/api/cards` | `frozen` (boolean), `limit` (positive decimal string, up to 10000 USD) |
| `/api/schedules` | Same fields as transfer, plus `dueDate` (`YYYY-MM-DD`, today or later in UTC) |
| `/api/schedules/cancel` | `id` of a pending schedule in this session |
| `/api/demo/process` | `asOf` (`YYYY-MM-DD`): execute pending schedules due by this simulated date |
| `/api/demo/controls` | `delayMs` (0 or 1500), `failNext` (boolean) |
| `/api/demo/samples` | `{}`: three card purchases totaling $80; retries do not duplicate them |
| `/api/demo/reset` | `{}`: clear this session's data and restore seeded balances/bills/card |

Payments and schedules also require idempotent `requestId` values. A paid bill
cannot be paid again with another request ID. Bills are paid in full from
checking in the UI; the API supports either source account. Card purchases use
checking only. These are one-time seeded bills, not recurring billing.

Scheduled transfers **do not run automatically**, reserve no balance, and do
not depend on a timer that stops during free-hosting sleep. Use **Test lab >
Process due transfers** to run them through a date. Successful transfers create
receipts; insufficient funds marks a schedule failed without moving money.
Completed, cancelled, and failed schedules are terminal; create a new schedule
to try again. Processing the same date twice does not debit twice. Delay/failure
settings apply to banking POST requests, not lab controls or dashboard reads.
Reset also clears those settings.

## Demo boundaries

The server binds to loopback by default; the Render demo explicitly enables public
access. Accounts are seeded separately for each browser session. There is
intentionally no login or multi-user authorization. Public hosting is only for
disposable, simulated data; never use it for real funds. Production would
require authentication, account ownership checks, stronger request controls,
auditing, operational monitoring, and a production-grade financial ledger.
