import { expect, test } from '@playwright/test';

let sequence = 0;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function openPlayer(browser, baseURL, prefix) {
  sequence += 1;
  const context = await browser.newContext({ baseURL });
  const response = await context.request.post('/api/auth/register', {
    data: {
      email: `doudizhu-hand-${runId}-${sequence}@example.test`,
      nickname: `${prefix}${sequence}`,
      password: 'password-123'
    }
  });
  expect(response.status()).toBe(201);
  const page = await context.newPage();
  await page.goto('/doudizhu.html');
  await expect(page.locator('#lobbyView')).toBeVisible();
  return { context, page };
}

async function handGeometry(page) {
  return page.evaluate(() => {
    const hand = document.getElementById('hand');
    const handBox = hand.getBoundingClientRect();
    const cards = [...hand.querySelectorAll('.card')].map((card) => {
      const box = card.getBoundingClientRect();
      return { id: card.dataset.cardId, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    });
    return {
      cards,
      hand: { left: handBox.left, right: handBox.right, clientWidth: hand.clientWidth, scrollWidth: hand.scrollWidth }
    };
  });
}

function cardPoint(geometry, index) {
  const card = geometry.cards[index];
  const step = geometry.cards.length > 1 ? geometry.cards[1].left - geometry.cards[0].left : card.width;
  const visible = index === geometry.cards.length - 1 ? card.width : Math.min(step, card.width);
  return { x: card.left + visible / 2, y: card.top + card.height / 2 };
}

async function dragAcross(page, indexes) {
  let geometry = await handGeometry(page);
  const start = cardPoint(geometry, indexes[0]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const index of indexes.slice(1)) {
    geometry = await handGeometry(page);
    const point = cardPoint(geometry, index);
    await page.mouse.move(point.x, point.y);
  }
  await page.mouse.up();
}

async function clickUntil(page, label, done) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await done()) return;
    const button = page.getByRole('button', { name: label, exact: true });
    if (await button.count()) await button.first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  expect(await done(), `"${label}" did not take effect`).toBe(true);
}

async function startRound(host, guest) {
  await host.page.locator('#createButton').click();
  await expect(host.page.locator('#roomView')).toBeVisible();
  const roomCode = (await host.page.locator('#roomCode').textContent()).trim();

  const row = guest.page.locator('.room-card').filter({ hasText: `房间 ${roomCode}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '加入牌桌' }).click();
  await expect(guest.page.locator('#roomView')).toBeVisible();

  const readyCount = (page) => page.locator('.player-card .ready-tag').count();
  await clickUntil(guest.page, '准备', async () => (await readyCount(guest.page)) >= 1);
  await clickUntil(host.page, '准备', async () => (await readyCount(host.page)) >= 2);
  await clickUntil(host.page, '开始游戏', async () => (await host.page.locator('#hand .card').count()) > 0);
  await expect(host.page.locator('#hand .card').first()).toBeVisible();
}

test('selects Doudizhu hand cards by dragging without lifting them above their neighbours', async ({ browser, baseURL }) => {
  const host = await openPlayer(browser, baseURL, '滑选房主');
  const guest = await openPlayer(browser, baseURL, '滑选客人');
  await startRound(host, guest);

  const cards = host.page.locator('#hand .card');
  const dealt = await cards.count();
  expect(dealt).toBeGreaterThan(3);

  await dragAcross(host.page, [0, 1, 2]);
  await expect(host.page.locator('#hand .card.selected')).toHaveCount(3);
  await expect(host.page.locator('#selectionHint')).toHaveText('已选择 3 张牌');

  await dragAcross(host.page, [2, 1]);
  await expect(host.page.locator('#hand .card.selected')).toHaveCount(1);
  await expect(host.page.locator('#selectionHint')).toHaveText('已选择 1 张牌');

  const stacking = await host.page.evaluate(() => {
    const cardNodes = [...document.querySelectorAll('#hand .card')];
    const selected = cardNodes[0];
    const first = selected.getBoundingClientRect();
    const second = cardNodes[1].getBoundingClientRect();
    const overlapX = (second.left + first.right) / 2;
    const hit = document.elementFromPoint(overlapX, first.bottom - 5)?.closest('.card');
    return {
      selectedIsFirst: selected.classList.contains('selected'),
      zIndex: getComputedStyle(selected).zIndex,
      liftedAbove: second.top - first.top,
      overlaps: first.right > second.left,
      hitId: hit?.dataset.cardId ?? null,
      secondId: cardNodes[1].dataset.cardId
    };
  });
  expect(stacking.selectedIsFirst).toBe(true);
  expect(stacking.overlaps).toBe(true);
  expect(stacking.zIndex).toBe('auto');
  expect(stacking.liftedAbove).toBeGreaterThan(8);
  expect(stacking.hitId).toBe(stacking.secondId);

  await guest.context.close();
  await host.context.close();
});

test('fits the whole Doudizhu hand inside a phone viewport without horizontal scrolling', async ({ browser, baseURL }) => {
  const host = await openPlayer(browser, baseURL, '手机房主');
  const guest = await openPlayer(browser, baseURL, '手机客人');
  await host.page.setViewportSize({ width: 390, height: 844 });
  await startRound(host, guest);

  await host.page.waitForFunction(() => {
    const hand = document.getElementById('hand');
    const cards = [...hand.querySelectorAll('.card')];
    if (!cards.length) return false;
    const box = hand.getBoundingClientRect();
    return cards[0].getBoundingClientRect().left >= box.left - 1 && cards.at(-1).getBoundingClientRect().right <= box.right + 1;
  });

  const geometry = await handGeometry(host.page);
  expect(geometry.cards.length).toBeGreaterThan(3);
  expect(geometry.hand.scrollWidth).toBeLessThanOrEqual(geometry.hand.clientWidth + 1);
  for (const card of geometry.cards) {
    expect(card.left).toBeGreaterThanOrEqual(geometry.hand.left - 1);
    expect(card.right).toBeLessThanOrEqual(geometry.hand.right + 1);
    expect(card.width).toBeGreaterThanOrEqual(28);
  }

  const table = await host.page.evaluate(() => {
    const box = document.getElementById('table').getBoundingClientRect();
    const hand = document.getElementById('hand').getBoundingClientRect();
    const hint = document.getElementById('selectionHint').getBoundingClientRect();
    return { tableBottom: box.bottom, tableRight: box.right, handBottom: hand.bottom, handTop: hand.top, hintBottom: hint.bottom };
  });
  expect(table.handBottom).toBeLessThanOrEqual(table.tableBottom + 1);
  expect(table.hintBottom).toBeLessThanOrEqual(table.handTop + 1);

  await guest.context.close();
  await host.context.close();
});
