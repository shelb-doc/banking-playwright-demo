const $ = (selector) => document.querySelector(selector);
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const timestamp = (value) => new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const today = new Date().toISOString().slice(0, 10);
const views = {
  overview: ['Overview', 'Good things start here.', 'Your everyday, a little more in balance.'],
  transfer: ['Move money', 'A little move. A step forward.', 'Between your accounts, today or another day.'],
  activity: ['Transactions', 'Every move, in view.', 'Search your history and open a receipt for the details.'],
  payments: ['Bills & payments', 'One less thing on your list.', 'Fictional bills. Real confidence exploring the flow.'],
  recipients: ['Recipients', 'Your people. Your playground.', 'Save invented destinations for simulated payments.'],
  cards: ['Cards', 'A little control goes a long way.', 'Freeze, set limits, and try a simulated purchase.'],
  'test-lab': ['Test lab', 'Curiosity looks good on you.', 'Explore loading, errors, scheduling, and a fresh start.'],
};
let state;
let busy = false;
let reviewAction;
const pendingRequests = new Map();
const reviewDialog = $('#review-dialog');
const receiptDialog = $('#receipt-dialog');
$('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  $('#main').focus();
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function viewName() {
  return Object.hasOwn(views, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
}

function navigate() {
  const name = viewName();
  const [title, heading, description] = views[name];
  $('#page-title').textContent = title;
  $('#page-heading').textContent = heading;
  $('#page-description').textContent = description;
  document.title = `Evergreen | ${title}`;
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name;
  for (const link of document.querySelectorAll('nav a')) {
    const active = link.hash === `#${name}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (state) {
    renderHistory();
    window.scrollTo(0, 0);
  }
}

async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
  return result;
}

function setBusy(value) {
  busy = value;
  $('#workspace').setAttribute('aria-busy', String(value || !state));
  $('#busy-message').hidden = !value;
  for (const control of document.querySelectorAll('form button, form input, form select, #sample-button, #reset-button, .list-row button')) {
    control.disabled = value || !state;
  }
  if (state && !busy && !state.recipients.length) {
    $('#payment-recipient').disabled = true;
    $('#payment-form button').disabled = true;
  }
}

function notice(title, detail, receipt) {
  const confirmation = $('#confirmation');
  confirmation.replaceChildren(node('h3', '', title));
  if (detail) confirmation.append(node('p', '', detail));
  if (receipt) confirmation.append(node('small', '', `Confirmation: ${receipt}`));
  confirmation.hidden = false;
  confirmation.focus({ preventScroll: true });
}

async function mutate(path, payload, onSuccess) {
  if (busy) return;
  $('#action-error').hidden = true;
  $('#transfer-error').hidden = true;
  $('#confirmation').hidden = true;
  setBusy(true);
  try {
    const result = await api(path, payload);
    render(result);
    pendingRequests.delete(path);
    onSuccess(result);
  } catch (error) {
    const box = $('#action-error');
    box.textContent = `${error.message} For connection errors, retry with the same details to avoid duplicate payments.`;
    box.hidden = false;
    box.focus();
  } finally {
    setBusy(false);
  }
}

function idempotent(path, payload) {
  const signature = JSON.stringify(payload);
  if (pendingRequests.get(path)?.signature !== signature) {
    pendingRequests.set(path, { signature, requestId: crypto.randomUUID() });
  }
  return { ...payload, requestId: pendingRequests.get(path).requestId };
}

function review(title, detail, confirmLabel, action) {
  if (busy || !state) return;
  reviewAction = action;
  $('#review-title').textContent = title;
  $('#review-detail').textContent = detail;
  $('#review-confirm').textContent = confirmLabel;
  reviewDialog.showModal();
  $('#review-cancel').focus();
}
$('#review-cancel').addEventListener('click', () => reviewDialog.close());
reviewDialog.addEventListener('close', () => { reviewAction = undefined; });
$('#review-confirm').addEventListener('click', () => {
  const action = reviewAction;
  reviewDialog.close();
  if (action) action();
});
$('#receipt-close').addEventListener('click', () => receiptDialog.close());

function accountName(id) {
  return state.accounts.find((account) => account.id === id)?.name || id;
}

function empty(container, message) {
  container.replaceChildren(node('p', 'empty-state', message));
}

function listRow(title, detail, status, buttonLabel, onClick) {
  const row = node('div', 'list-row');
  row.append(node('strong', '', title), node('p', '', detail));
  if (status) row.append(node('span', 'pill', status));
  if (buttonLabel) {
    const button = node('button', 'secondary', buttonLabel);
    button.type = 'button';
    button.addEventListener('click', onClick);
    row.append(button);
  }
  return row;
}

function render(data) {
  state = data;
  for (const account of state.accounts) $(`#${account.id}-balance`).textContent = money(account.balanceCents);
  $('#accounts').setAttribute('aria-busy', 'false');
  for (const select of document.querySelectorAll('[data-accounts]')) {
    const selected = select.value || (select.id === 'to-account' ? 'savings' : 'checking');
    select.replaceChildren(...state.accounts.map((account) => new Option(
      `${account.name} (${account.number}) - ${money(account.balanceCents)}`, account.id,
    )));
    select.value = selected;
  }
  const selectedRecipient = $('#payment-recipient').value;
  $('#payment-recipient').replaceChildren(...(state.recipients.length
    ? state.recipients.map((recipient) => new Option(`${recipient.name} (${recipient.number})`, recipient.id))
    : [new Option('Add a demo recipient first', '')]));
  if (state.recipients.some((recipient) => recipient.id === selectedRecipient)) $('#payment-recipient').value = selectedRecipient;

  const unpaid = state.bills.filter((bill) => bill.status === 'unpaid');
  $('#total-balance').textContent = money(state.accounts.reduce((sum, account) => sum + account.balanceCents, 0));
  $('#total-spending').textContent = money(state.payments.reduce((sum, payment) => sum + payment.amountCents, 0));
  $('#bills-remaining').textContent = money(unpaid.reduce((sum, bill) => sum + bill.amountCents, 0));
  $('#bills-count').textContent = `${unpaid.length} unpaid demo bill${unpaid.length === 1 ? '' : 's'}`;
  const chart = $('#spending-chart');
  chart.replaceChildren();
  const total = state.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  for (const [kind, label] of [['bill', 'Bills'], ['recipient', 'Recipient payments'], ['card', 'Card purchases']]) {
    const spent = state.payments.filter((payment) => payment.kind === kind).reduce((sum, payment) => sum + payment.amountCents, 0);
    const row = node('div', 'chart-row');
    const caption = node('div', 'chart-label');
    caption.append(node('span', '', label), node('strong', '', money(spent)));
    const meter = node('meter');
    meter.max = Math.max(total, 1);
    meter.value = spent;
    meter.setAttribute('aria-label', `${label}: ${money(spent)}`);
    row.append(caption, meter);
    chart.append(row);
  }
  if (!total) chart.append(node('p', 'empty-state', 'No spending yet. Try a bill or load sample activity in the Test lab.'));

  const recipients = $('#recipient-list');
  recipients.replaceChildren();
  for (const recipient of state.recipients) {
    recipients.append(listRow(recipient.name, `Demo account ending ${recipient.number}`, 'Simulated destination'));
  }
  if (!state.recipients.length) empty(recipients, 'A fresh address book. Add your first fictional recipient.');

  const bills = $('#bill-list');
  bills.replaceChildren();
  for (const bill of state.bills) {
    bills.append(listRow(bill.name, `${money(bill.amountCents)} - Due ${bill.dueDate}`, bill.status === 'paid' ? 'Paid' : 'Unpaid',
      bill.status === 'paid' ? undefined : `Pay ${bill.name}`, () => {
        const payload = { kind: 'bill', targetId: bill.id, fromAccount: 'checking', amount: (bill.amountCents / 100).toFixed(2) };
        review('Review bill payment', `Pay ${money(bill.amountCents)} to ${bill.name} from Everyday Checking?`,
          'Confirm payment', () => pay(payload, bill.name));
      }));
  }
  const card = state.cards[0];
  $('#card-state').textContent = card.frozen ? 'FROZEN' : 'ACTIVE';
  $('#card-frozen').checked = card.frozen;
  $('#card-limit').value = (card.limitCents / 100).toFixed(2);
  $('#card-spent').textContent = `${money(card.spentTodayCents)} spent today of ${money(card.limitCents)} daily limit.`;
  $('#demo-delay').value = String(state.controls.delayMs);
  $('#demo-failure').checked = Boolean(state.controls.failNext);
  const schedules = $('#schedule-list');
  schedules.replaceChildren();
  for (const item of state.schedules) {
    schedules.append(listRow(`${money(item.amountCents)} on ${item.dueDate}`,
      `${accountName(item.fromAccount)} to ${accountName(item.toAccount)}${item.message ? ` - ${item.message}` : ''}`,
      item.status, item.status === 'pending' ? 'Cancel scheduled transfer' : undefined,
      () => mutate('/api/schedules/cancel', { id: item.id }, () => notice('Schedule cancelled', 'No funds were moved.'))));
  }
  if (!state.schedules.length) empty(schedules, 'Nothing scheduled. Choose a date when making a transfer.');
  renderHistory();
  setBusy(busy);
}

function historyItems() {
  return [
    ...state.transfers.map((transfer) => ({
      ...transfer, kind: 'transfer', name: `${accountName(transfer.fromAccount)} to ${accountName(transfer.toAccount)}`,
    })),
    ...state.payments,
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function openReceipt(item) {
  const details = node('dl');
  for (const [label, value] of [
    ['Destination', item.name], ['Amount', money(item.amountCents)], ['Type', item.kind],
    ['From', accountName(item.fromAccount)], ['Date', timestamp(item.createdAt)],
    ['Confirmation', item.id], ['Status', 'Completed (simulated)'],
  ]) details.append(node('dt', '', label), node('dd', '', value));
  $('#receipt-detail').replaceChildren(details);
  receiptDialog.showModal();
}
function renderHistory() {
  const full = viewName() === 'activity';
  let items = historyItems();
  const search = $('#history-search').value.trim().toLowerCase();
  const account = $('#history-account').value;
  const kind = $('#history-kind').value;
  if (full) {
    items = items.filter((item) => (!search || `${item.name} ${item.kind} ${item.id}`.toLowerCase().includes(search)) &&
      (!account || item.fromAccount === account || item.toAccount === account) && (!kind || item.kind === kind));
  }
  $('#activity-title').textContent = full ? 'Transaction history' : 'Recent activity';
  $('#history-count').textContent = `${items.length} transaction${items.length === 1 ? '' : 's'}${full ? ' matching your filters' : ' in your demo session'}`;
  if (!full) items = items.slice(0, 5);
  const activity = $('#activity-list');
  activity.replaceChildren();
  if (!items.length) return empty(activity, full ? 'No transactions match these filters.' : 'A fresh start. Your transfers and payments will appear here.');
  for (const item of items) {
    const row = node('button', 'activity-row');
    row.type = 'button';
    row.setAttribute('aria-label', `View receipt: ${item.name}, ${money(item.amountCents)}`);
    const icon = node('span', 'activity-icon', item.kind === 'transfer' ? '\u2194' : '\u2197');
    icon.setAttribute('aria-hidden', 'true');
    const details = node('span', 'activity-details');
    details.append(node('strong', '', item.name), node('small', '', `${timestamp(item.createdAt)} - ${item.kind}`));
    const value = node('span', 'activity-amount', `${item.kind === 'transfer' ? '' : '-'}${money(item.amountCents)}`);
    value.append(node('small', '', 'Completed'));
    row.append(icon, details, value);
    row.addEventListener('click', () => openReceipt(item));
    activity.append(row);
  }
}
for (const selector of ['#history-search', '#history-account', '#history-kind']) {
  $(selector).addEventListener('input', () => { if (state) renderHistory(); });
}
for (const link of document.querySelectorAll('[data-account-link]')) {
  link.addEventListener('click', () => {
    $('#history-account').value = link.dataset.accountLink;
    $('#history-search').value = '';
    $('#history-kind').value = '';
    if (state) renderHistory();
  });
}
function payloadFor(form) {
  return Object.fromEntries(new FormData(form));
}
function amountValue(amount) {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
$('#transfer-form').addEventListener('input', () => { $('#transfer-error').hidden = true; });
$('#transfer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || !state) return;
  const payload = payloadFor(event.currentTarget);
  const cents = amountValue(payload.amount);
  let message;
  if (payload.fromAccount === payload.toAccount) message = 'Choose two different accounts.';
  else if (cents === null || cents <= 0) message = 'Enter an amount greater than $0.00 with at most two decimal places.';
  else if (!payload.dueDate && cents > state.accounts.find((account) => account.id === payload.fromAccount).balanceCents) message = 'Insufficient funds in the source account.';
  if (message) {
    $('#transfer-error').textContent = message;
    $('#transfer-error').hidden = false;
    return;
  }
  const scheduled = Boolean(payload.dueDate);
  const detail = `${money(cents)} from ${accountName(payload.fromAccount)} to ${accountName(payload.toAccount)}${scheduled ? ` on ${payload.dueDate} (run from Test lab)` : ', instantly'}.`;
  const path = scheduled ? '/api/schedules' : '/api/transfers';
  review(scheduled ? 'Review scheduled transfer' : 'Review transfer', detail,
    scheduled ? 'Confirm schedule' : 'Confirm transfer',
    () => mutate(path, idempotent(path, payload), (result) => {
      if (scheduled) notice('Transfer scheduled', detail);
      else notice('Transfer successful',
        `${money(result.transfer.amountCents)} transferred from ${accountName(result.transfer.fromAccount)} to ${accountName(result.transfer.toAccount)}.`,
        result.transfer.id);
    }));
});
function pay(payload, destination) {
  return mutate('/api/payments', idempotent('/api/payments', payload), (result) =>
    notice('Payment successful', `${money(result.payment.amountCents)} paid to ${destination}.`, result.payment.id));
}
$('#payment-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const payload = { ...payloadFor(event.currentTarget), kind: 'recipient' };
  const recipient = state.recipients.find((item) => item.id === payload.targetId);
  if (!recipient) return;
  review('Review recipient payment',
    `Pay $${payload.amount} to ${recipient.name} (ending ${recipient.number}) from ${accountName(payload.fromAccount)}?`,
    'Confirm payment', () => pay(payload, recipient.name));
});
$('#recipient-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  mutate('/api/recipients', payloadFor(form), () => {
    form.reset();
    notice('Recipient saved', 'Your fictional destination is ready in Bills & payments.');
  });
});
$('#card-form').addEventListener('submit', (event) => {
  event.preventDefault();
  mutate('/api/cards', { frozen: $('#card-frozen').checked, limit: $('#card-limit').value },
    () => notice('Card controls saved', 'Freeze and daily limit settings now apply to simulated purchases.'));
});
$('#purchase-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const payload = { ...payloadFor(event.currentTarget), kind: 'card', targetId: 'debit', fromAccount: 'checking' };
  review('Review demo purchase', `Simulate a $${payload.amount} card purchase from Everyday Checking?`,
    'Confirm purchase', () => pay(payload, 'Everyday debit'));
});
$('#controls-form').addEventListener('submit', (event) => {
  event.preventDefault();
  mutate('/api/demo/controls', { delayMs: Number($('#demo-delay').value), failNext: $('#demo-failure').checked },
    () => notice('Test settings applied', 'Try a banking action to see the configured response.'));
});
$('#process-form').addEventListener('submit', (event) => {
  event.preventDefault();
  mutate('/api/demo/process', payloadFor(event.currentTarget),
    (result) => notice('Schedule processing complete', `${result.processed} due transfer(s) processed. Check Move money for completed or failed results.`));
});
$('#sample-button').addEventListener('click', () => mutate('/api/demo/samples', {},
  () => notice('Sample activity loaded', 'Three simulated card purchases. Repeating this action does not debit twice.')));
$('#reset-button').addEventListener('click', () => review('Reset your demo?',
  'This clears all your demo activity and recipients, and restores starting balances, bills, and card settings. Other visitors are unaffected.',
  'Reset my demo', () => mutate('/api/demo/reset', {}, () => {
    pendingRequests.clear();
    for (const form of document.querySelectorAll('form')) form.reset();
    $('#process-date').value = today;
    $('#history-search').value = '';
    $('#history-account').value = '';
    $('#history-kind').value = '';
    render(state);
    notice('A fresh start', 'Your demo has been reset. No other session was changed.');
  })));

$('#transfer-date').min = today;
$('#process-date').value = today;
window.addEventListener('hashchange', navigate);
navigate();
setBusy(false);
try {
  render(await api('/api/dashboard'));
} catch (error) {
  $('#load-error').textContent = `Could not load your demo: ${error.message} Refresh this page to try again.`;
  $('#load-error').hidden = false;
  $('#accounts').setAttribute('aria-busy', 'false');
  $('#workspace').setAttribute('aria-busy', 'false');
  for (const balance of document.querySelectorAll('.balance')) balance.textContent = 'Unavailable';
  $('#activity-list').textContent = 'Activity unavailable.';
}
