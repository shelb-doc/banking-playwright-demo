import { test, expect } from '@playwright/test';

test('transfer $100 and verify receipt, balances, history, and persistence on reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#checking-balance')).toHaveText('$2,450.00');
  await expect(page.locator('#savings-balance')).toHaveText('$8,200.00');
  await page.getByLabel('From account').selectOption('checking');
  await page.getByLabel('To account').selectOption('savings');
  await page.getByLabel('Amount', { exact: false }).fill('100.00');
  await page.getByRole('button', { name: /Transfer \$100.00/ }).click();
  const confirmation = page.getByRole('status');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Transfer successful');
  await expect(confirmation).toContainText('$100.00 transferred from Everyday Checking to High-Yield Savings.');
  await expect(confirmation).toContainText(/Confirmation: [0-9a-f-]{36}/);
  await expect(page.locator('#checking-balance')).toHaveText('$2,350.00');
  await expect(page.locator('#savings-balance')).toHaveText('$8,300.00');
  await expect(page.locator('.activity-row')).toHaveCount(1);
  await expect(page.locator('.activity-row')).toContainText('$100.00');
  await expect(page.locator('.activity-row')).toContainText('Completed');
  await page.reload();
  await expect(page.locator('#checking-balance')).toHaveText('$2,350.00');
  await expect(page.locator('.activity-row')).toHaveCount(1);

  await page.getByLabel('To account').selectOption('checking');
  await page.getByRole('button', { name: /Transfer \$100.00/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Choose two different accounts.' })).toBeVisible();
  await page.getByLabel('To account').selectOption('savings');
  await page.locator('#amount').fill('99999.00');
  await page.getByRole('button', { name: /Transfer/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Insufficient funds' })).toBeVisible();
  await expect(page.locator('.activity-row')).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#amount')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
