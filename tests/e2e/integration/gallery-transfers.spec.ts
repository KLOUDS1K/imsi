import { expect, test } from '@playwright/test';

test('the upload panel counts queued files and cannot discard an active batch', async ({ page }) => {
  await page.goto('/tests/e2e/io/probe.html');
  const state = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.dataset.role = 'transfers';
    host.hidden = true;
    document.body.append(host);
    const transferPath = '/gallery/src/app/transfers.ts';
    const { beginTransfer } = await import(transferPath);
    const jobs = ['one.jpg', 'two.jpg', 'three.jpg', 'four.jpg'].map((name) => beginTransfer(name));
    const head = () => host.querySelector('.transfers__head')?.textContent;
    const close = host.querySelector<HTMLButtonElement>('.transfers__close')!;
    const queued = { head: head(), closeDisabled: close.disabled, rows: host.querySelectorAll('.transfer').length };
    close.click();
    const stayedOpen = !host.hidden;
    jobs[0].finish();
    jobs[1].finish('Network error');
    const midway = head();
    jobs[2].finish();
    jobs[3].finish();
    const done = { head: head(), closeDisabled: close.disabled, rows: host.querySelectorAll('.transfer').length };
    close.click();
    return { queued, stayedOpen, midway, done, closed: host.hidden };
  });

  expect(state).toEqual({
    queued: { head: 'Uploading 1 of 4', closeDisabled: true, rows: 4 },
    stayedOpen: true,
    midway: 'Uploading 3 of 4',
    done: { head: '3 done · 1 failed', closeDisabled: false, rows: 4 },
    closed: true,
  });
});
