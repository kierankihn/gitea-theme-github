import fs from 'node:fs';
import path from 'node:path';
import {test as base, expect} from 'playwright/test';

const state = JSON.parse(fs.readFileSync(process.env.VISUAL_STATE, 'utf8'));
const test = base.extend({
  reference: async ({browser}, use, testInfo) => {
    const context = await browser.newContext({
      storageState: state.reference.storageState,
      viewport: testInfo.project.use.viewport,
      colorScheme: testInfo.project.use.colorScheme,
      locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce',
    });
    await use(await context.newPage());
    await context.close();
  },
});

async function open(page, url) {
  const pending = new Set();
  let lastRequest = Date.now();
  const ignore = (request) => ['eventsource', 'websocket'].includes(request.resourceType()) || /\.sharedworker\.|\/user\/events/.test(request.url());
  page.on('request', (request) => {
    if (!ignore(request)) { pending.add(request); lastRequest = Date.now(); }
  });
  const done = (request) => { if (pending.delete(request)) lastRequest = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  await page.clock.setFixedTime(new Date('2027-01-01T12:00:00Z'));
  const origin = new URL(url).origin;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  const response = await page.goto(url, {waitUntil: 'load'});
  expect(response.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'github-auto');
  // Wait for lazy Vue/CSS chunks too; the notification SharedWorker never finishes its request.
  await page.waitForFunction(() => window.config?.frontendInited);
  await expect.poll(() => pending.size === 0 && Date.now() - lastRequest >= 300, {timeout: 15_000}).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    // Seeded issue timestamps are created by Gitea; normalize their visible relative-time elements.
    for (const time of document.querySelectorAll('relative-time')) {
      time.setAttribute('datetime', '2026-01-01T00:00:00Z');
    }
  });
}

async function compare(page, reference, testInfo, name) {
  // The actionability probe moves the pointer; do not compare its emoji tooltip with an unhovered reference.
  for (const p of [reference, page]) {
    await p.mouse.move(0, 0);
    await expect(p.locator('.tippy-box[data-state="visible"]')).toHaveCount(0);
  }
  const expected = testInfo.snapshotPath(name);
  fs.mkdirSync(path.dirname(expected), {recursive: true});
  await reference.screenshot({path: expected, animations: 'disabled', caret: 'hide'});
  const actual = testInfo.outputPath(name);
  await page.screenshot({path: actual, animations: 'disabled', caret: 'hide'});
  await testInfo.attach(name, {path: actual, contentType: 'image/png'});
  await expect(page).toHaveScreenshot(name);
}

async function openMenu(page, prefix, kind) {
  const trigger = page.locator(`${prefix} .${kind}`).first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 180));
  await trigger.click();
  await expect(trigger.locator('> .menu')).toBeVisible();
  // Fomantic finishes its transition bookkeeping after the menu becomes visible.
  await page.waitForTimeout(300);
  return trigger;
}

async function expectUnclipped(trigger) {
  const items = trigger.locator('> .menu > .item');
  expect(await items.count()).toBeGreaterThan(0);
  const hits = await items.evaluateAll((elements) => elements.map((el) => {
    const r = el.getBoundingClientRect();
    return {text: el.textContent.trim(), clickable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))};
  }));
  expect(hits.filter((item) => !item.clickable), 'Every menu item must be painted above surrounding content').toEqual([]);
  await items.last().click({trial: true});
}

for (const [name, route] of [
  ['repository', ''],
  ['issue list', '/issues'],
  ['issue conversation', '/issues/1'],
]) {
  test(name, async ({page, reference}, testInfo) => {
    await open(reference, state.reference.url + state.repo + route);
    await open(page, state.candidate.url + state.repo + route);
    await compare(page, reference, testInfo, 'page.png');
  });
}

// The API fixture creates unsigned commits. Exercise Gitea's signed badge markup on the real page CSS too.
for (const [name, route, selector] of [
  ['repository', '', '#repo-files-table .commit-id-short'],
  ['file', '/src/branch/main/src/colors.go', '#repo-file-commit-box .commit-id-short'],
  ['commits', '/commits/branch/main', '#commits-table .commit-id-short'],
]) {
  test(`${name} commit signatures`, async ({page}, testInfo) => {
    await open(page, state.candidate.url + state.repo + route);
    const link = page.locator(selector).first();
    // Gitea intentionally hides these SHA links on mobile.
    if (!(await link.isVisible())) {
      expect(page.viewportSize().width).toBe(390);
      return;
    }
    const original = await link.innerHTML();
    const href = await link.getAttribute('href');
    const avatar = await page.locator('img.avatar').first().evaluate((el) => {
      const image = el.cloneNode();
      image.width = image.height = 20; // repo/commit_sign_badge.tmpl's signing avatar size.
      return image.outerHTML;
    });
    const colors = [];
    for (const status of ['trusted', 'untrusted', 'unmatched', 'warning']) {
      const icon = fs.readFileSync(new URL(`../../src/icons/svg/gitea-${status === 'warning' ? 'unlock' : 'lock'}.svg`, import.meta.url), 'utf8');
      await link.evaluate((el, {status, original, icon, avatar}) => {
        el.classList.add('commit-is-signed', `sign-${status}`);
        const badge = document.createElement('span');
        badge.className = `ui label commit-sign-badge commit-is-signed sign-${status}`;
        badge.innerHTML = `<span data-tooltip-content="Signature reason">${icon}</span>`
          + (status === 'warning' ? '' : `<span data-tooltip-content="Signing key">${avatar}</span>`);
        badge.querySelector('svg').setAttribute('class', `svg gitea-${status === 'warning' ? 'unlock' : 'lock'}`);
        el.innerHTML = original;
        el.append(badge);
      }, {status, original, icon, avatar});
      const badge = link.locator('.commit-sign-badge');
      const color = await badge.evaluate((el) => getComputedStyle(el).color);
      colors.push(color);
      for (const hover of [false, true]) {
        if (hover) await link.hover();
        const geometry = await link.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const text = document.createRange();
          text.selectNodeContents(el.firstChild);
          const parts = [text.getBoundingClientRect(), ...Array.from(el.querySelectorAll('.commit-sign-badge, .commit-sign-badge > *, .commit-sign-badge svg, .commit-sign-badge img'), (child) => child.getBoundingClientRect())];
          const css = getComputedStyle(el);
          return {border: css.borderTopWidth, background: css.backgroundColor,
            clipped: parts.some((p) => p.left < r.left - 1 || p.right > r.right + 1 || p.top < r.top - 1 || p.bottom > r.bottom + 1)};
        });
        expect(geometry).toEqual({border: '0px', background: 'rgba(0, 0, 0, 0)', clipped: false});
        await expect(badge).toHaveCSS('color', color);
        await expect(link).toHaveAttribute('href', href);
        await expect(badge.locator('[data-tooltip-content]').first()).toHaveAttribute('data-tooltip-content', 'Signature reason');
      }
      if (status === 'trusted') await testInfo.attach('trusted-signature.png', {body: await page.screenshot(), contentType: 'image/png'});
      await page.mouse.move(0, 0);
      await link.evaluate((el, status) => el.classList.remove('commit-is-signed', `sign-${status}`), status);
    }
    expect(new Set(colors).size, 'Verification states must remain distinguishable').toBe(4);
    await link.evaluate((el, original) => { el.innerHTML = original; }, original);
  });
}

for (const view of ['conversation', 'unified', 'split']) {
  test(`PR ${view} menus`, async ({page, reference}, testInfo) => {
    const suffix = `/pulls/2${view === 'conversation' ? '' : `/files?style=${view}`}`;
    const prefix = view === 'conversation' ? '.code-comments-list' : '.code-diff .comment-code-cloud';
    await open(reference, state.reference.url + state.repo + suffix);
    await open(page, state.candidate.url + state.repo + suffix);
    for (const kind of ['context-dropdown', 'select-reaction']) {
      await openMenu(reference, prefix, kind);
      const trigger = await openMenu(page, prefix, kind);
      await expectUnclipped(trigger);
      await compare(page, reference, testInfo, `${kind}.png`);
      for (const p of [reference, page]) await p.mouse.click(4, 180);
    }
    if (view === 'split' && testInfo.project.use.viewport.width === 390) {
      const trigger = page.locator(`${prefix} .context-dropdown`).first();
      const scroller = page.locator('.code-diff-split').filter({has: page.locator('.comment-code-cloud')}).first();
      await scroller.evaluate((el) => { el.scrollLeft = 80; });
      expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(80);
      await trigger.click();
      await expectUnclipped(trigger);
      await page.mouse.click(4, 180);
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(80);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
  });
}

test('PR reply editor', async ({page, reference}, testInfo) => {
  for (const [p, server] of [[reference, state.reference], [page, state.candidate]]) {
    await open(p, server.url + state.repo + '/pulls/2');
    const reply = p.locator('.code-comments-list .comment-form-reply').first();
    await reply.click();
    await expect(p.locator('.code-comments-list form.comment-form').first()).toBeVisible();
    await reply.evaluate((el) => window.scrollBy(0, el.closest('.conversation-holder').getBoundingClientRect().top - 20));
  }
  await compare(page, reference, testInfo, 'reply.png');
});
