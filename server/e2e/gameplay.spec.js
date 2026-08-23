import { expect, test } from '@playwright/test';

let sequence = 0;

async function registerUi(page, prefix) {
  sequence += 1;
  const email = `browser-${sequence}@example.test`;
  const nickname = `${prefix}${sequence}`;
  await page.goto('/');
  await page.locator('#authModeToggle').click();
  await page.locator('#emailInput').fill(email);
  await page.locator('#nicknameInput').fill(nickname);
  await page.locator('#passwordInput').fill('password-123');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#tableView')).toBeVisible();
  return { email, nickname };
}

async function registerApi(context, prefix, index) {
  const email = `${prefix}-${index}-${Date.now()}@example.test`;
  const nickname = `${prefix}${index}`;
  const response = await context.request.post('/api/auth/register', { data: { email, nickname, password: 'password-123' } });
  expect(response.status()).toBe(201);
  return { ...(await response.json()).user, nickname };
}

async function joinVisibleRoom(page, code) {
  await expect(page.locator('#roomLobby')).toBeVisible();
  const row = page.locator('.room-row').filter({ hasText: `房间 ${code}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '加入' }).click();
  await expect(page.locator('#tableLayout')).toBeVisible();
}

async function expectSouthSeat(page) {
  const position = await page.evaluate(() => {
    const felt = document.querySelector('.felt').getBoundingClientRect();
    const self = document.querySelector('.player-seat.self').getBoundingClientRect();
    return {
      selfCenter: self.top + self.height / 2,
      southThreshold: felt.top + felt.height * 0.52,
      horizontalDelta: Math.abs(self.left + self.width / 2 - (felt.left + felt.width / 2))
    };
  });
  expect(position.selfCenter).toBeGreaterThan(position.southThreshold);
  expect(position.horizontalDelta).toBeLessThan(8);
}

async function expectSeatsInsideWithoutOverlap(page, count) {
  await expect(page.locator('.player-seat')).toHaveCount(count);
  const layout = await page.evaluate(() => {
    const felt = document.querySelector('.felt').getBoundingClientRect();
    const seats = [...document.querySelectorAll('.player-seat')].map((seat) => {
      const box = seat.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const overlaps = [];
    for (let left = 0; left < seats.length; left += 1) {
      for (let right = left + 1; right < seats.length; right += 1) {
        const a = seats[left];
        const b = seats[right];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4) overlaps.push([left, right]);
      }
    }
    return {
      overlaps,
      inside: seats.every((seat) => seat.left >= felt.left - 2 && seat.right <= felt.right + 2 && seat.top >= felt.top - 2 && seat.bottom <= felt.bottom + 2)
    };
  });
  expect(layout.inside).toBe(true);
  expect(layout.overlaps).toEqual([]);
}

test('two players keep their own south seat and use hidden cards, dialogs, chat, rankings, and settings', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  await registerUi(firstPage, '浏览甲');
  await firstPage.locator('#createRoomButton').click();
  await expect(firstPage.locator('#tableLayout')).toBeVisible();
  const code = (await firstPage.locator('#roomCode').textContent()).trim();
  await registerUi(secondPage, '浏览乙');
  await joinVisibleRoom(secondPage, code);
  await expect(firstPage.locator('.player-seat')).toHaveCount(2);
  await expect(firstPage.locator('#preparationDialog')).toBeVisible();
  await expect(secondPage.locator('#preparationDialog')).toBeVisible();
  await firstPage.locator('#prepReadyButton').click();
  await secondPage.locator('#prepReadyButton').click();

  await expect(firstPage.locator('.player-seat')).toHaveCount(2);
  await expect(secondPage.locator('.player-seat')).toHaveCount(2);
  await expectSouthSeat(firstPage);
  await expectSouthSeat(secondPage);
  await expect(firstPage.locator('.player-seat.self .card.back')).toHaveCount(3);
  await expect(secondPage.locator('.player-seat.self .card.back')).toHaveCount(3);

  await firstPage.locator('#seeButton').click();
  await expect(firstPage.locator('.player-seat.self .card.back')).toHaveCount(0);
  await expect(firstPage.locator('.player-seat.self .card')).toHaveCount(3);
  await firstPage.locator('#raiseButton').click();
  await expect(firstPage.locator('#raiseDialog')).toBeVisible();
  await expect(firstPage.locator('#raisePresets button')).toHaveCount(4);
  await expect(firstPage.locator('#raisePreview')).toContainText('实际扣豆');
  await firstPage.locator('[data-close-dialog="raiseDialog"]').click();

  await firstPage.locator('#compareButton').click();
  await expect(firstPage.locator('#compareDialog')).toBeVisible();
  await expect(firstPage.locator('.compare-target-button')).toHaveCount(1);
  await firstPage.locator('[data-close-dialog="compareDialog"]').click();

  await firstPage.locator('#chatInput').fill('浏览器聊天');
  await firstPage.locator('#chatSendButton').click();
  await expect(secondPage.locator('#chatMessages')).toContainText('浏览器聊天');

  await firstPage.locator('#settingsButton').click();
  await firstPage.locator('#motionSelect').selectOption('cinematic');
  await expect(firstPage.locator('body')).toHaveAttribute('data-motion', 'cinematic');
  await firstPage.locator('#motionSelect').selectOption('disabled');
  await expect(firstPage.locator('body')).toHaveAttribute('data-motion', 'disabled');
  await firstPage.route('**/api/me/settings', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '设置保存失败' }) }));
  await firstPage.locator('#motionSelect').selectOption('light');
  await expect(firstPage.locator('body')).toHaveAttribute('data-motion', 'disabled');
  await expect(firstPage.locator('#motionSelect')).toHaveValue('disabled');
  await firstPage.unroute('**/api/me/settings');
  await firstPage.locator('#settingsDialog .icon-button').click();

  await firstPage.locator('#leaderboardButton').click();
  await expect(firstPage.locator('#leaderboardView')).toBeVisible();
  await firstPage.locator('[data-kind="wealth"]').click();
  await expect(firstPage.locator('.leader-row')).toHaveCount(2);
  await expect(firstPage.locator('.leader-row').first()).toContainText('豆');
  await first.close();
  await second.close();
});

test('six-player desktop, mobile, and spectator tables stay inside the felt without seat overlap', async ({ browser, baseURL }) => {
  const contexts = [];
  for (let index = 0; index < 6; index += 1) {
    const context = await browser.newContext({ baseURL, viewport: index === 5 ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    contexts.push(context);
    await registerApi(context, '六人', index);
  }
  const spectatorContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await registerApi(spectatorContext, '六人观战', 6);
  const created = await contexts[0].request.post('/api/rooms', { data: { allowSpectators: true } });
  const room = (await created.json()).room;
  for (const context of contexts.slice(1)) {
    expect((await context.request.post(`/api/rooms/${room.id}/join`, { data: {} })).status()).toBe(200);
  }
  for (const context of contexts) expect((await context.request.post(`/api/rooms/${room.id}/ready`, { data: { ready:true } })).status()).toBe(200);
  expect((await contexts[0].request.post(`/api/rooms/${room.id}/start-next`, { data: {} })).status()).toBe(200);

  for (const index of [0, 5]) {
    await contexts[index].addInitScript((roomId) => sessionStorage.setItem('zhajinhua.roomId', roomId), room.id);
    const page = await contexts[index].newPage();
    await page.goto('/');
    await expect(page.locator('#tableLayout')).toBeVisible();
    await expectSeatsInsideWithoutOverlap(page, 6);
    await expectSouthSeat(page);
    await expect(page.locator('.card.back')).toHaveCount(18);
  }
  await spectatorContext.request.post(`/api/rooms/${room.id}/spectate`, { data: { enabled: true } });
  await spectatorContext.addInitScript((roomId) => sessionStorage.setItem('zhajinhua.roomId', roomId), room.id);
  const spectatorPage = await spectatorContext.newPage();
  await spectatorPage.goto('/');
  await expect(spectatorPage.locator('#tableLayout')).toBeVisible();
  await expectSeatsInsideWithoutOverlap(spectatorPage, 6);
  await expect(spectatorPage.locator('.player-seat.self')).toHaveCount(0);
  await expect(spectatorPage.locator('.card:not(.back)')).toHaveCount(18);
  await spectatorContext.close();
  await Promise.all(contexts.map((context) => context.close()));
});

test('three-player views stay south, expose countdown danger, and spectators remain read-only with open cards', async ({ browser, baseURL }) => {
  const contexts = [];
  for (let index = 0; index < 4; index += 1) {
    const context = await browser.newContext({ baseURL, viewport: index === 2 ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    contexts.push(context);
    await registerApi(context, '三人', index);
  }
  const created = await contexts[0].request.post('/api/rooms', { data: {} });
  const room = (await created.json()).room;
  for (const context of contexts.slice(1, 3)) await context.request.post(`/api/rooms/${room.id}/join`, { data: {} });
  await contexts[0].request.post(`/api/rooms/${room.id}/observe`, { data: { enabled: true } });
  await contexts[3].request.post(`/api/rooms/${room.id}/spectate`, { data: { enabled: true } });
  for (const context of contexts.slice(0, 3)) await context.request.post(`/api/rooms/${room.id}/ready`, { data: { ready:true } });
  await contexts[0].request.post(`/api/rooms/${room.id}/start-next`, { data: {} });

  for (const context of contexts.slice(0, 3)) {
    await context.addInitScript((roomId) => sessionStorage.setItem('zhajinhua.roomId', roomId), room.id);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('#tableLayout')).toBeVisible();
    await expectSeatsInsideWithoutOverlap(page, 3);
    await expectSouthSeat(page);
  }
  const actingPage = contexts[0].pages()[0];
  await expect(actingPage.locator('.turn-countdown')).toBeVisible();
  await actingPage.evaluate(() => {
    const originalNow = Date.now;
    const countdown = document.querySelector('.turn-countdown');
    const seconds = Number.parseInt(countdown.textContent, 10);
    Date.now = () => originalNow() + Math.max(0, seconds - 9) * 1000;
  });
  await expect(actingPage.locator('.turn-countdown')).toHaveClass(/danger/);

  await contexts[3].addInitScript((roomId) => sessionStorage.setItem('zhajinhua.roomId', roomId), room.id);
  const spectatorPage = await contexts[3].newPage();
  await spectatorPage.goto('/');
  await expect(spectatorPage.locator('#tableLayout')).toBeVisible();
  await expect(spectatorPage.locator('.card:not(.back)')).toHaveCount(9);
  await expect(spectatorPage.locator('#chatInput')).toBeDisabled();
  await expect(spectatorPage.locator('#chatModeLabel')).toHaveText('观战者只读');
  await actingPage.locator('#chatInput').fill('观战同步消息');
  await actingPage.locator('#chatSendButton').click();
  await expect(spectatorPage.locator('#chatMessages')).toContainText('观战同步消息');
  await Promise.all(contexts.map((context) => context.close()));
});

test('renders comparison feedback for light, cinematic, and disabled motion modes', async ({ browser, baseURL }) => {
  for (const mode of ['light', 'cinematic', 'disabled']) {
    const first = await browser.newContext({ baseURL });
    const second = await browser.newContext({ baseURL });
    const firstUser = await registerApi(first, `比牌${mode}`, 0);
    const secondUser = await registerApi(second, `比牌${mode}`, 1);
    await first.request.patch('/api/me/settings', { data: { motionMode: mode, effectsEnabled: false } });
    await second.request.patch('/api/me/settings', { data: { motionMode: mode, effectsEnabled: false } });
    const created = await first.request.post('/api/rooms', { data: {} });
    const room = (await created.json()).room;
    await second.request.post(`/api/rooms/${room.id}/join`, { data: {} });
    await first.request.post(`/api/rooms/${room.id}/ready`, { data: { ready:true } });
    await second.request.post(`/api/rooms/${room.id}/ready`, { data: { ready:true } });
    const started = await first.request.post(`/api/rooms/${room.id}/start-next`, { data: {} });
    const startedRoom = (await started.json()).room;
    const attacker = startedRoom.players.find((player) => player.seat === startedRoom.currentTurn);
    const attackerContext = attacker.userId === firstUser.id ? first : second;
    const target = startedRoom.players.find((player) => player.userId !== attacker.userId);
    const page = await attackerContext.newPage();
    await page.addInitScript((roomId) => sessionStorage.setItem('zhajinhua.roomId', roomId), room.id);
    await page.goto('/');
    await expect(page.locator('#tableLayout')).toBeVisible();
    await page.locator('#compareButton').click();
    await page.locator('.compare-target-button', { hasText: target.nickname }).click();
    await expect(page.locator('#compareNotice')).toContainText(/比牌获胜|比牌落败/);
    if (mode === 'disabled') {
      await expect(page.locator('body')).not.toHaveAttribute('data-compare-effect', /.+/);
      await expect(page.locator('#compareEffectOverlay')).not.toHaveClass(/active/);
    } else {
      await expect(page.locator('body')).toHaveAttribute('data-compare-effect', mode);
      await expect(page.locator('#compareEffectOverlay')).toHaveClass(/active/);
    }
    await first.close();
    await second.close();
  }
});

test('a zero-balance account must type the exact refill text before receiving beans', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  const firstUser = await registerApi(first, '补豆', 0);
  const secondUser = await registerApi(second, '补豆', 1);
  const created = await first.request.post('/api/rooms', { data: { ante: 100000 } });
  const room = (await created.json()).room;
  await second.request.post(`/api/rooms/${room.id}/join`, { data: {} });
  await first.request.post(`/api/rooms/${room.id}/ready`, { data: { ready:true } });
  await second.request.post(`/api/rooms/${room.id}/ready`, { data: { ready:true } });
  await first.request.post(`/api/rooms/${room.id}/start-next`, { data: {} });
  const firstMe = (await (await first.request.get('/api/auth/me')).json()).user;
  const secondMe = (await (await second.request.get('/api/auth/me')).json()).user;
  const zeroContext = firstMe.beans === 0 ? first : second;
  const zeroUser = firstMe.beans === 0 ? firstUser : secondUser;
  expect([firstMe.beans, secondMe.beans]).toContain(0);

  const winnerContext = firstMe.beans > 0 ? first : second;
  const rankingPage = await winnerContext.newPage();
  await rankingPage.goto('/');
  await rankingPage.locator('#leaderboardButton').click();
  for (const kind of ['wealth', 'wins', 'losses']) {
    await rankingPage.locator(`[data-kind="${kind}"]`).click();
    await expect(rankingPage.locator(`[data-kind="${kind}"]`)).toHaveClass(/active/);
    await expect(rankingPage.locator('.leader-row')).not.toHaveCount(0);
  }
  await rankingPage.locator('[data-kind="wins"]').click();
  await expect.poll(() => rankingPage.locator('.leader-row').evaluateAll((rows) => rows.some((row) => row.querySelectorAll('.title-chip').length >= 2))).toBe(true);
  await rankingPage.close();

  const page = await zeroContext.newPage();
  await page.goto('/');
  await expect(page.locator('#refillDialog')).toBeVisible();
  await page.locator('#refillConfirmation').fill('不正确');
  await page.locator('#refillForm button[type="submit"]').click();
  await expect(page.locator('#refillError')).toContainText('确认文字不正确');
  await page.locator('#refillConfirmation').fill('黄总是大帅比');
  await page.locator('#refillForm button[type="submit"]').click();
  await expect(page.locator('#refillDialog')).not.toBeVisible();
  await expect(page.locator('#accountLabel')).toContainText('100,000 豆');
  await expect(page.locator('#globalTicker')).toContainText(`${zeroUser.nickname}：黄总是大帅比！`);
  await first.close();
  await second.close();
});
