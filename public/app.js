const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const form = document.querySelector('#transfer-form');
const from = document.querySelector('#from-account');
const to = document.querySelector('#to-account');
const amount = document.querySelector('#amount');
const submit = document.querySelector('#submit-transfer');
const errorBox = document.querySelector('#transfer-error');
const confirmation = document.querySelector('#confirmation');
let currentAccounts = [];
let pendingRequest = null;
let busy = false;

async function api(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}

function amountCents() {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount.value)) return null;
  const [whole, fraction = ''] = amount.value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function updateButton() {
  const cents = amountCents();
  submit.textContent = busy ? 'Transferring...' : `Transfer ${cents === null ? '' : money(cents)} \u2192`;
}

function render(data) {
  currentAccounts = data.accounts;
  for (const account of currentAccounts) {
    document.querySelector(`#${account.id}-balance`).textContent = money(account.balanceCents);
  }
  for (const select of [from, to]) {
    const selected = select.value;
    select.replaceChildren(...currentAccounts.map((account) => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = `${account.name} (${account.number}) - ${money(account.balanceCents)}`;
      return option;
    }));
    select.value = selected || (select === from ? 'checking' : 'savings');
  }
  document.querySelector('#accounts').setAttribute('aria-busy', 'false');
  const activity = document.querySelector('#activity-list');
  activity.replaceChildren();
  if (data.transfers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'A fresh start. Your transfers will appear here.';
    activity.append(empty);
  }
  for (const transfer of data.transfers) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = '\u2194';
    icon.setAttribute('aria-hidden', 'true');
    const details = document.createElement('div');
    details.className = 'activity-details';
    const title = document.createElement('strong');
    title.textContent = `${currentAccounts.find((a) => a.id === transfer.fromAccount).name} to ${currentAccounts.find((a) => a.id === transfer.toAccount).name}`;
    const date = document.createElement('small');
    date.textContent = new Date(transfer.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    details.append(title, date);
    const value = document.createElement('div');
    value.className = 'activity-amount';
    const valueText = document.createElement('span');
    valueText.textContent = money(transfer.amountCents);
    const status = document.createElement('small');
    status.textContent = 'Completed';
    value.append(valueText, status);
    row.append(icon, details, value);
    activity.append(row);
  }
}

form.addEventListener('input', () => {
  errorBox.hidden = true;
  confirmation.hidden = true;
  updateButton();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  errorBox.hidden = true;
  confirmation.hidden = true;
  const cents = amountCents();
  let message;
  if (from.value === to.value) message = 'Choose two different accounts.';
  else if (cents === null || cents <= 0) message = 'Enter an amount greater than $0.00 with at most two decimal places.';
  else if (cents > currentAccounts.find((a) => a.id === from.value).balanceCents) message = 'Insufficient funds in the source account.';
  if (message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    return;
  }
  const payload = { fromAccount: from.value, toAccount: to.value, amount: amount.value };
  const signature = JSON.stringify(payload);
  if (pendingRequest?.signature !== signature) {
    pendingRequest = { signature, requestId: crypto.randomUUID() };
  }
  busy = true;
  for (const control of [from, to, amount, submit]) control.disabled = true;
  updateButton();
  try {
    const result = await api('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, requestId: pendingRequest.requestId }),
    });
    render(result);
    const heading = document.createElement('h3');
    heading.textContent = 'Transfer successful';
    const detail = document.createElement('p');
    detail.textContent = `${money(result.transfer.amountCents)} transferred from ${currentAccounts.find((a) => a.id === result.transfer.fromAccount).name} to ${currentAccounts.find((a) => a.id === result.transfer.toAccount).name}.`;
    const receipt = document.createElement('small');
    receipt.textContent = `Confirmation: ${result.transfer.id}`;
    confirmation.replaceChildren(heading, detail, receipt);
    confirmation.hidden = false;
    confirmation.focus();
    pendingRequest = null;
  } catch (error) {
    errorBox.textContent = `${error.message} If the connection was interrupted, retry without changing the details to avoid a duplicate transfer.`;
    errorBox.hidden = false;
  } finally {
    busy = false;
    for (const control of [from, to, amount, submit]) control.disabled = false;
    updateButton();
  }
});

try {
  render(await api('/api/dashboard'));
  from.disabled = to.disabled = submit.disabled = false;
} catch (error) {
  const loadError = document.querySelector('#load-error');
  loadError.textContent = `Could not load your accounts: ${error.message} Refresh this page to try again.`;
  loadError.hidden = false;
  document.querySelector('#accounts').setAttribute('aria-busy', 'false');
  for (const balance of document.querySelectorAll('.balance')) balance.textContent = 'Unavailable';
  document.querySelector('#activity-list').textContent = 'Activity unavailable.';
}
