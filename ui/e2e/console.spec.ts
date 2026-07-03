/**
 * M8b acceptance (Playwright, chromium): the console against the live demo
 * gateway — rendering, refresh reconstruction, seq-gap resnapshot, command
 * round trips, and the two-step kill switch.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

interface GwHook {
  skipSeq(): void;
  stats: { snapshots: number; deltas: number; gaps: number; resnapshots: number };
  lastSeq: number;
}

function gw(page: Page): { stats: () => Promise<GwHook['stats']>; lastSeq: () => Promise<number> } {
  return {
    stats: () => page.evaluate(() => (window as unknown as { __gw: GwHook }).__gw.stats),
    lastSeq: () => page.evaluate(() => (window as unknown as { __gw: GwHook }).__gw.lastSeq),
  };
}

test('(a) renders live state and a completed trade lands in the blotter', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('mode-banner')).toContainText('PAPER');
  await expect(page.getByTestId('chain-strip')).toContainText('24500');
  await expect(page.getByTestId('underlying-chart')).toBeVisible();
  // The demo loops a full trade every ~15s — one must land.
  await expect(page.getByTestId('blotter-trade-row').first()).toBeVisible({ timeout: 45_000 });
  // Net-of-charges column is populated (₹ value present).
  await expect(page.getByTestId('blotter-trade-row').first()).toContainText('₹');
});

test('(b) refresh mid-session reconstructs the full state from snapshot', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('blotter-trade-row').first()).toBeVisible({ timeout: 45_000 });

  await page.reload();
  await expect(page.getByTestId('mode-banner')).toContainText('PAPER', { timeout: 10_000 });
  // Trades survive the refresh (server state, not UI state).
  await expect(page.getByTestId('blotter-trade-row').first()).toBeVisible({ timeout: 15_000 });
  // Fresh connection: per-client seq restarted and is advancing.
  expect(await gw(page).lastSeq()).toBeGreaterThanOrEqual(1);
});

test('(c) a seq gap forces resnapshot and the stream recovers', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('mode-banner')).toBeVisible();
  const hooks = gw(page);

  await page.evaluate(() => (window as unknown as { __gw: GwHook }).__gw.skipSeq());
  await expect.poll(async () => (await hooks.stats()).resnapshots, { timeout: 10_000 }).toBeGreaterThan(0);

  // After recovery, deltas keep applying gap-free.
  const before = (await hooks.stats()).deltas;
  await expect.poll(async () => (await hooks.stats()).deltas, { timeout: 10_000 }).toBeGreaterThan(before);
});

test('(d) command round trip: DISARM then ARM, acked and reflected in the banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('banner-lifecycle')).toBeVisible();

  await page.getByTestId('disarm-btn').click();
  await expect(page.getByTestId('cmd-result')).toContainText('DISARM: ok', { timeout: 5_000 });
  await expect(page.getByTestId('banner-lifecycle')).toHaveText('DISARMED', { timeout: 10_000 });

  await page.getByTestId('arm-btn').click();
  await expect(page.getByTestId('cmd-result')).toContainText('ARM: ok', { timeout: 5_000 });
  await expect(page.getByTestId('banner-lifecycle')).toHaveText(/ARMED|ACTIVE|COOLDOWN/, {
    timeout: 10_000,
  });
});

test('(e) kill switch is two-step: a click never fires; hold fires and surfaces the ack', async ({ page }) => {
  await page.goto('/');
  const kill = page.getByTestId('kill-switch');
  await expect(kill).toBeVisible();

  // Step 1 alone (quick click) must NOT send the command.
  await kill.click();
  await page.waitForTimeout(600);
  await expect(page.getByTestId('kill-result')).toHaveText('');

  // Click + 1s hold fires. Until M9 registers KILL, the gateway rejects it —
  // and the UI must SHOW that rejection, never pretend success.
  const box = await kill.boundingBox();
  if (box === null) throw new Error('kill switch has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_300);
  await page.mouse.up();
  await expect(page.getByTestId('kill-result')).toContainText('REJECTED: UNKNOWN_COMMAND', {
    timeout: 5_000,
  });
});
