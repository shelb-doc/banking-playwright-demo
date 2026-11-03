import { test, expect } from '@playwright/test';

async function open(page, hash = 'overview') {
  await page.goto(`/#${hash}`);
  await expect(page.locator('#checking-balance')).toHaveText('$2,450.00');
}
async function nav(page, name) {
  await page.getByRole('navigation').getByRole('link', { name, exact: true }).click();
}
async function confirm(page, label) {
  await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
}

test('recipient payments, bills, history search, receipts, and overview spending', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, 'recipients');
  await page.getByLabel('Demo recipient name').fill('Alex Demo');
  await page.getByLabel('Last four demo account digits').fill('1234');
  await page.getByRole('button', { name: 'Save recipient' }).click();
  await expect(page.getByRole('status')).toContainText('Recipient saved');
  await expect(page.locator('#recipient-list')).toContainText('Alex Demo');
  await nav(page, 'Bills & payments');
  await page.getByLabel('Payment amount (USD)', { exact: true }).fill('12.34');
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Alex Demo');
  await confirm(page, 'Go back');
  await expect(page.locator('#checking-balance')).toHaveText('$2,450.00');
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  await confirm(page, 'Confirm payment');
  await expect(page.locator('#checking-balance')).toHaveText('$2,437.66');
  await page.getByRole('button', { name: 'Pay Evergreen Electric', exact: true }).click();
  await confirm(page, 'Confirm payment');
  await expect(page.locator('#checking-balance')).toHaveText('$2,352.66');
  await expect(page.locator('#bill-list').getByRole('button', { name: 'Pay Evergreen Electric' })).toHaveCount(0);
  await nav(page, 'Transactions');
  await page.getByLabel('Search transactions').fill('Alex');
  await expect(page.locator('.activity-row')).toHaveCount(1);
  await page.locator('.activity-row').click();
  await expect(page.getByRole('dialog')).toContainText('$12.34');
  await expect(page.getByRole('dialog')).toContainText('Everyday Checking');
  await page.getByRole('button', { name: 'Close receipt' }).click();
  await page.getByLabel('Search transactions').fill('missing');
  await expect(page.locator('#activity-list')).toContainText('No transactions match');
  await page.getByLabel('Search transactions').fill('');
  await page.getByLabel('Type', { exact: true }).selectOption('bill');
  await expect(page.locator('.activity-row')).toHaveCount(1);
  await nav(page, 'Overview');
  await expect(page.locator('#total-spending')).toHaveText('$97.34');
  await expect(page.locator('#total-balance')).toHaveText('$10,552.66');
  await expect(page.locator('#bills-remaining')).toHaveText('$95.00');
  expect(errors).toEqual([]);
});

test('card freeze, spending limit, purchase, and reload persistence', async ({ page }) => {
  await open(page, 'cards');
  await page.getByLabel('Freeze demo card').check();
  await page.getByRole('button', { name: 'Save card controls' }).click();
  await expect(page.locator('#card-state')).toHaveText('FROZEN');
  await page.getByRole('button', { name: 'Review demo purchase' }).click();
  await confirm(page, 'Confirm purchase');
  await expect(page.getByRole('alert')).toContainText('Your card is frozen');
  await expect(page.locator('#checking-balance')).toHaveText('$2,450.00');
  await page.getByLabel('Freeze demo card').uncheck();
  await page.getByLabel('Daily spending limit').fill('25.00');
  await page.getByRole('button', { name: 'Save card controls' }).click();
  await expect(page.locator('#card-state')).toHaveText('ACTIVE');
  await page.getByRole('button', { name: 'Review demo purchase' }).click();
  await confirm(page, 'Confirm purchase');
  await expect(page.locator('#checking-balance')).toHaveText('$2,425.00');
  await expect(page.locator('#card-spent')).toContainText('$25.00 spent today');
  await page.getByRole('button', { name: 'Review demo purchase' }).click();
  await confirm(page, 'Confirm purchase');
  await expect(page.getByRole('alert')).toContainText('daily card limit');
  await page.reload();
  await expect(page.getByLabel('Daily spending limit')).toHaveValue('25.00');
  await expect(page.locator('#checking-balance')).toHaveText('$2,425.00');
});

test('scheduled transfer is manual, processes once, and can be cancelled', async ({ page }) => {
  await open(page, 'transfer');
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel('When', { exact: true }).fill(today);
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await confirm(page, 'Confirm schedule');
  await expect(page.locator('#schedule-list')).toContainText('pending');
  await expect(page.locator('#checking-balance')).toHaveText('$2,450.00');
  await nav(page, 'Test lab');
  await page.getByRole('button', { name: 'Process due transfers' }).click();
  await expect(page.locator('#checking-balance')).toHaveText('$2,350.00');
  await page.getByRole('button', { name: 'Process due transfers' }).click();
  await expect(page.getByRole('status')).toContainText('0 due transfer(s)');
  await nav(page, 'Move money');
  await expect(page.locator('#schedule-list')).toContainText('completed');
  await page.getByLabel('Amount (USD)', { exact: true }).fill('50.00');
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await confirm(page, 'Confirm schedule');
  await page.getByRole('button', { name: 'Cancel scheduled transfer' }).click();
  await expect(page.locator('#schedule-list')).toContainText('cancelled');
  await expect(page.locator('#checking-balance')).toHaveText('$2,350.00');
});

test('test lab exposes pending/error states, retries safely, seeds and resets', async ({ page }) => {
  await open(page, 'test-lab');
  await page.getByLabel('Response speed').selectOption('1500');
  await page.getByLabel('Fail the next banking action').check();
  await page.getByRole('button', { name: 'Apply test settings' }).click();
  await expect(page.getByRole('status')).toContainText('Test settings applied');
  await nav(page, 'Move money');
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await confirm(page, 'Confirm transfer');
  await expect(page.locator('#busy-message')).toBeVisible();
  await expect(page.locator('#submit-transfer')).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Simulated service failure');
  await expect(page.locator('#checking-balance')).toHaveText('$2,450.00');
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await confirm(page, 'Confirm transfer');
  await expect(page.locator('#checking-balance')).toHaveText('$2,350.00');
  await nav(page, 'Test lab');
  await expect(page.getByLabel('Fail the next banking action')).not.toBeChecked();
  await page.getByRole('button', { name: 'Load sample transactions' }).click();
  await expect(page.locator('#checking-balance')).toHaveText('$2,270.00');
  await page.getByRole('button', { name: 'Load sample transactions' }).click();
  await expect(page.locator('#checking-balance')).toHaveText('$2,270.00');
  await page.getByRole('button', { name: 'Reset my demo', exact: true }).click();
  await confirm(page, 'Reset my demo');
  await expect(page.locator('#checking-balance')).toHaveText('$2,450.00');
  await expect(page.locator('#activity-list')).toContainText('A fresh start');
});

test('separate browser contexts do not share money or recipients', async ({ page, browser, baseURL }) => {
  await open(page, 'recipients');
  await page.getByLabel('Demo recipient name').fill('<img src=x onerror=alert(1)>');
  await page.getByLabel('Last four demo account digits').fill('4321');
  await page.getByRole('button', { name: 'Save recipient' }).click();
  await expect(page.locator('#recipient-list')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#recipient-list img')).toHaveCount(0);
  const context = await browser.newContext({ baseURL });
  try {
    const other = await context.newPage();
    await other.goto('/#recipients');
    await expect(other.locator('#checking-balance')).toHaveText('$2,450.00');
    await expect(other.locator('#recipient-list')).toContainText('Add your first fictional recipient');
    await expect(other.locator('#recipient-list')).not.toContainText('onerror');
  } finally {
    await context.close();
  }
});

test('mobile navigation, all views, and keyboard-accessible review fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  for (const name of ['Overview', 'Transactions', 'Bills & payments', 'Recipients', 'Cards', 'Test lab', 'Move money']) {
    await nav(page, name);
    await expect(page.locator('#page-title')).toHaveText(name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go back' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeFocused();
});

test('failed initial loading is visible and banking controls stay disabled', async ({ page }) => {
  await page.route('**/api/dashboard', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The demo is at capacity.' }),
  }));
  await page.goto('/#transfer');
  await expect(page.getByRole('alert')).toContainText('Could not load your demo: The demo is at capacity.');
  await expect(page.locator('#checking-balance')).toHaveText('Unavailable');
  await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled();
  await expect(page.locator('#from-account')).toBeDisabled();
});
