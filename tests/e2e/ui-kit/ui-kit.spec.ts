/**
 * UI kit gallery: screenshots (light, dark, 390px) + interaction checks for
 * the slider, dialogs (focus trap, Escape), menus (keyboard), rating, colour
 * wheel, sections, segmented control, theme toggle and context menu.
 *
 *   PW_PORT=5211 npx playwright test tests/e2e/ui-kit
 *
 * Screenshots land in test-results/ui-kit/ (git-ignored).
 */
import { expect, test, type Page } from '@playwright/test';

const URL = '/tests/e2e/ui-kit/gallery.html';
const SHOTS = 'test-results/ui-kit';

interface KitLog {
  events: string[];
  slider: { input: number[]; change: number[]; gestures: number };
  lastMenu: string | null;
  rating: number;
  confirm: boolean | null;
  prompt: string | null | undefined;
}

async function open(page: Page, theme: 'light' | 'dark' = 'light'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // Web fonts may be blocked in CI; anything else is a real error.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${URL}?theme=${theme}`);
  await page.waitForSelector('html[data-gallery-ready]');
  return errors;
}

const kit = (page: Page): Promise<KitLog> => page.evaluate(() => (window as unknown as { __kit: KitLog }).__kit);

async function fullShot(page: Page, path: string): Promise<void> {
  // The gallery scrolls inside <main>; unroll it for a full-page capture.
  await page.addStyleTag({ content: '#app{height:auto!important} body{overflow:visible!important} .g-main{overflow:visible!important}' });
  await page.waitForTimeout(150);
  await page.screenshot({ path, fullPage: true });
}

test.describe('ui-kit gallery', () => {
  test('renders in light and dark without errors', async ({ page }) => {
    const errors = await open(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await fullShot(page, `${SHOTS}/light.png`);
    await page.goto(`${URL}?theme=dark`);
    await page.waitForSelector('html[data-gallery-ready]');
    await expect(page.locator('[data-testid=theme]')).toHaveText('Theme: dark');
    await fullShot(page, `${SHOTS}/dark.png`);
    expect(errors).toEqual([]);
    // Every icon rendered with a path.
    const empty = await page.locator('.g-icon svg:not(:has(path))').count();
    expect(empty).toBe(0);
  });

  test('works at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await open(page, 'light');
    // No horizontal overflow of the page.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/mobile-light.png` });
    await page.goto(`${URL}?theme=dark`);
    await page.waitForSelector('html[data-gallery-ready]');
    await page.locator('#g-develop').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/mobile-dark.png` });
    // Drawer opens from the toolbar menu button and closes with Escape.
    await page.getByRole('button', { name: 'Sections' }).click();
    await expect(page.locator('.k-drawer.is-open')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/mobile-drawer.png` });
    await page.keyboard.press('Escape');
    await expect(page.locator('.k-drawer.is-open')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('slider: drag, shift-drag, wheel, dblclick reset, keyboard, typed value', async ({ page }) => {
    await open(page);
    const slider = page.locator('.k-slider[data-id=exposure]');
    const thumb = slider.locator('[role=slider]');
    await slider.scrollIntoViewIfNeeded();
    await expect(thumb).toHaveAttribute('aria-valuenow', '0');

    // Drag the thumb 40px right → positive value, one gesture, one change.
    const box = (await thumb.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 20, cy, { steps: 4 });
    await page.mouse.move(cx + 40, cy, { steps: 4 });
    await page.mouse.up();
    const afterDrag = Number(await thumb.getAttribute('aria-valuenow'));
    expect(afterDrag).toBeGreaterThan(0.5);
    let log = await kit(page);
    expect(log.slider.gestures).toBe(1);
    expect(log.slider.change).toEqual([afterDrag]);
    expect(log.slider.input.length).toBeGreaterThan(1);

    // Shift-drag the same distance moves ~10× less.
    const box2 = (await thumb.boundingBox())!;
    const x2 = box2.x + box2.width / 2;
    await page.mouse.move(x2, cy);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(x2 + 40, cy, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const afterFine = Number(await thumb.getAttribute('aria-valuenow'));
    expect(afterFine - afterDrag).toBeGreaterThan(0);
    expect(afterFine - afterDrag).toBeLessThan((afterDrag - 0) / 4);

    // Double-click the thumb resets to the default.
    await thumb.dblclick();
    await expect(thumb).toHaveAttribute('aria-valuenow', '0');
    await expect(slider).not.toHaveClass(/is-modified/);

    // Wheel over the slider: one step per notch; commit after idle.
    const t = (await slider.locator('.k-slider__track').boundingBox())!;
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.move(t.x + t.width / 2 + 2, t.y + t.height / 2);
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await expect(thumb).toHaveAttribute('aria-valuenow', '0.1');
    await page.waitForTimeout(500);
    log = await kit(page);
    expect(log.slider.change.at(-1)).toBeCloseTo(0.1, 5);

    // Keyboard: arrows = step, Shift = fine, Home/End, Delete = reset.
    await thumb.focus();
    await page.keyboard.press('ArrowRight');
    await expect(thumb).toHaveAttribute('aria-valuenow', '0.15');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(thumb).toHaveAttribute('aria-valuenow', '0.16');
    await page.keyboard.press('ArrowLeft');
    await expect(thumb).toHaveAttribute('aria-valuenow', '0.11');
    await page.keyboard.press('End');
    await expect(thumb).toHaveAttribute('aria-valuenow', '5');
    await expect(thumb).toHaveAttribute('aria-valuetext', '+5.00');
    await page.keyboard.press('Home');
    await expect(thumb).toHaveAttribute('aria-valuenow', '-5');
    await page.keyboard.press('Delete');
    await expect(thumb).toHaveAttribute('aria-valuenow', '0');

    // Click the readout to type a value.
    await slider.locator('.k-slider__value').click();
    const input = slider.locator('.k-slider__input');
    await expect(input).toBeVisible();
    await input.fill('1,25');
    await input.press('Enter');
    await expect(thumb).toHaveAttribute('aria-valuenow', '1.25');
    await expect(slider.locator('.k-slider__value')).toHaveText('+1.25');
    // Escape cancels typing.
    await slider.locator('.k-slider__value').click();
    await input.fill('3');
    await input.press('Escape');
    await expect(thumb).toHaveAttribute('aria-valuenow', '1.25');
  });

  test('dialogs: focus trap, Escape, prompt', async ({ page }) => {
    await open(page);
    const trigger = page.locator('.g-open-confirm');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Delete 3 photos?' });
    await expect(dialog).toBeVisible();
    // Destructive confirm focuses Cancel.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeFocused();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/dialog.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await kit(page)).confirm).toBe(false);
    await expect(trigger).toBeFocused();

    // Confirm resolves true.
    await trigger.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(async () => (await kit(page)).confirm).toBe(true);

    // Prompt: Enter submits the typed text.
    await page.locator('.g-open-prompt').click();
    const field = page.getByRole('dialog').getByRole('textbox');
    await expect(field).toBeFocused();
    await field.fill('Film look');
    await field.press('Enter');
    await expect.poll(async () => (await kit(page)).prompt).toBe('Film look');
  });

  test('menu: keyboard navigation, submenu, Escape, context menu', async ({ page }) => {
    await open(page);
    const btn = page.locator('.g-menu-trigger');
    await btn.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Copy settings/ })).toBeFocused();
    await page.keyboard.press('ArrowUp'); // wraps to the last item
    await expect(page.getByRole('menuitem', { name: /Remove from library/ })).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /Sort by/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitemcheckbox', { name: 'Name' })).toBeFocused();
    await page.screenshot({ path: `${SHOTS}/menu.png` });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft'); // back to the parent
    await expect(page.getByRole('menuitem', { name: /Sort by/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect((await kit(page)).lastMenu).toBe('sort-date');
    await expect(btn).toBeFocused();

    // Escape closes, typeahead jumps.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('e');
    await expect(page.getByRole('menuitem', { name: /Export/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Right-click opens a context menu at the pointer; outside click closes it.
    const ctx = page.locator('[data-testid=ctx]');
    await ctx.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.mouse.click(5, 300);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('splitter: keyboard, double-click reset', async ({ page }) => {
    await open(page);
    const split = page.getByRole('separator', { name: 'Resize edit panel' });
    const panel = page.locator('[data-testid=panel]');
    await split.scrollIntoViewIfNeeded();
    await split.focus();
    await page.keyboard.press('ArrowRight');
    await expect(split).toHaveAttribute('aria-valuenow', '320');
    expect(Math.round((await panel.boundingBox())!.width)).toBe(320);
    await page.keyboard.press('Home');
    await expect(split).toHaveAttribute('aria-valuenow', '260');
    // Drag 60px right.
    const b = (await split.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + 40);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 60, b.y + 40, { steps: 5 });
    await page.mouse.up();
    await expect(split).toHaveAttribute('aria-valuenow', '320');
    await split.dblclick();
    await expect(split).toHaveAttribute('aria-valuenow', '312');
  });

  test('bottom sheet: snap by drag, close by dragging down', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await page.getByRole('button', { name: 'Bottom sheet' }).click();
    const sheet = page.locator('.k-sheet');
    await expect(sheet).toHaveAttribute('data-snap', '1');
    await page.waitForTimeout(350);
    const handle = page.getByRole('button', { name: 'Resize Edit' });
    const hb = (await handle.boundingBox())!;
    const x = hb.x + hb.width / 2;
    // Drag up ~300px → top snap.
    await page.mouse.move(x, hb.y + 10);
    await page.mouse.down();
    await page.mouse.move(x, hb.y - 150, { steps: 6 });
    await page.mouse.move(x, hb.y - 300, { steps: 6 });
    await page.waitForTimeout(250); // let velocity settle
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-snap', '2');
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/mobile-sheet.png` });
    // Keyboard on the handle: ↓ steps down one snap.
    await handle.focus();
    await page.keyboard.press('ArrowDown');
    await expect(sheet).toHaveAttribute('data-snap', '1');
    await page.waitForTimeout(350);
    // Drag far down → closes.
    const hb2 = (await handle.boundingBox())!;
    await page.mouse.move(x, hb2.y + 10);
    await page.mouse.down();
    await page.mouse.move(x, 830, { steps: 8 });
    await page.mouse.up();
    await expect(sheet).not.toHaveClass(/is-open/);
    await expect(sheet).toBeHidden();
    expect((await kit(page)).events).toContain('sheet:closed');
  });

  test('rating, labels, segmented, section, theme toggle, colour wheel', async ({ page }) => {
    await open(page);
    const stars = page.locator('[data-testid=rating] .k-rating').first();
    await stars.locator('[data-value="4"]').click();
    expect((await kit(page)).rating).toBe(4);
    await stars.locator('[data-value="4"]').click(); // clicking the current value clears
    expect((await kit(page)).rating).toBe(0);
    await stars.locator('[data-value="1"]').focus();
    await page.keyboard.press('5');
    expect((await kit(page)).rating).toBe(5);
    await page.keyboard.press('ArrowLeft');
    expect((await kit(page)).rating).toBe(4);

    // Segmented control (toolbar view toggle): arrows move + select.
    const grid = page.getByRole('radio', { name: 'Grid' });
    await grid.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'List' })).toBeFocused();

    // Collapsed section opens.
    const head = page.locator('[data-section="gallery.range"] .k-section__toggle');
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-section="gallery.range"] .k-range').first()).toBeVisible();

    // Colour wheel: click moves the point, double-click resets to the default.
    const wheel = page.getByRole('slider', { name: 'Midtones hue and saturation' });
    await wheel.scrollIntoViewIfNeeded();
    const wb = (await wheel.boundingBox())!;
    await page.mouse.click(wb.x + wb.width * 0.5, wb.y + wb.height * 0.15); // straight up → hue 90
    await expect(wheel).toHaveAttribute('aria-valuetext', /Hue 90°/);
    await wheel.dblclick({ position: { x: wb.width * 0.2, y: wb.height * 0.5 } });
    await expect(wheel).toHaveAttribute('aria-valuenow', '0');

    // Theme toggle flips html[data-theme] and persists it.
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('kloud-theme'))).toBe('dark');
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  });
});
