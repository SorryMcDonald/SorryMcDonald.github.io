import { expect, test } from '@playwright/test';

let sequence = 0;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function register(context, prefix) {
  sequence += 1;
  const response = await context.request.post('/api/auth/register', {
    data:{ email:`texas-effects-${runId}-${sequence}@example.test`, nickname:`${prefix}${sequence}`, password:'password-123' }
  });
  expect(response.status()).toBe(201);
  return (await response.json()).user;
}

async function roomView(context, roomId) {
  const response = await context.request.get(`/api/texas/rooms/${roomId}`);
  expect(response.status()).toBe(200);
  return (await response.json()).room;
}

async function openTrackedRoom(context, roomId) {
  await context.addInitScript((id) => {
    sessionStorage.setItem('texas.roomId', id);
    window.__texasEffects = [];
    window.addEventListener('texas:table-effect', (event) => window.__texasEffects.push(event.detail));
  }, roomId);
  const page = await context.newPage();
  await page.goto('/dezhou.html');
  await expect(page.locator('#tableView')).toBeVisible();
  return page;
}

async function expectEffect(page, kind) {
  await expect.poll(() => page.evaluate((value) => window.__texasEffects?.some((effect) => effect.kind === value), kind)).toBe(true);
}

async function expectCenterClearOfSelf(page) {
  const spacing = await page.evaluate(() => {
    const center = document.querySelector('.felt-center').getBoundingClientRect();
    const avatar = document.querySelector('.player-seat.self .player-avatar').getBoundingClientRect();
    return avatar.top - center.bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(4);
}

async function expectSelfCardsInsideFelt(page) {
  await expect(page.locator('.player-seat.self .hole-cards .poker-card')).toHaveCount(2);
  const overflow = await page.evaluate(() => {
    const felt = document.querySelector('#pokerTable').getBoundingClientRect();
    const cards = document.querySelector('.player-seat.self .hole-cards').getBoundingClientRect();
    return cards.bottom - felt.bottom;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

async function takeLegalAction(contextByUser, observerContext, roomId, preferred) {
  const shared = await roomView(observerContext, roomId);
  const actor = shared.players.find((player) => player.seat === shared.currentTurn);
  const actorContext = contextByUser.get(actor.userId);
  const actorView = await roomView(actorContext, roomId);
  const actions = actorView.allowedActions.actions;
  const type = preferred && actions.includes(preferred)
    ? preferred
    : actions.includes('check') ? 'check' : actions.includes('call') ? 'call' : actions.includes('all_in') ? 'all_in' : actions[0];
  const actorState = actorView.players.find((player) => player.userId === actor.userId);
  const response = await actorContext.request.post(`/api/texas/rooms/${roomId}/actions`, {
    data:{
      type,
      handId:actorView.handId,
      version:actorView.version,
      actionSeq:Number(actorState.actionSeq) + 1,
      clientActionId:`e2e-${Date.now()}-${Math.random()}`
    }
  });
  expect(response.status()).toBe(200);
  return { type, room:(await response.json()).room };
}

test('Texas navigation keeps 牌局 local and matches the Zhajinhua header controls', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await register(context, '导航');
  const page = await context.newPage();
  await page.goto('/dezhou.html');
  await expect(page.locator('#accountLabel')).toContainText('导航1');
  await expect(page.locator('.primary-nav > *')).toHaveCount(8);
  await expect(page.locator('.primary-nav > *')).toHaveText(['牌局','游戏大厅','公开房间','德州扑克','斗地主','炸金花','锦标赛','排行榜']);

  await page.locator('button[data-nav="table"]').click();
  await expect(page).toHaveURL(/\/dezhou\.html$/);
  await expect(page.locator('button[data-nav="table"]')).toHaveClass(/active/);
  await expect(page.locator('[data-nav="holdem"]')).not.toHaveClass(/active/);

  await page.locator('button[data-nav="rooms"]').click();
  await expect(page).toHaveURL(/\/dezhou\.html$/);
  await expect(page.locator('button[data-nav="rooms"]')).toHaveClass(/active/);
  await context.close();
});

test('live entry, betting, collection, checks, and showdown render as non-blocking table effects', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  const host = await register(hostContext, '动效甲');
  const guest = await register(guestContext, '动效乙');
  const created = await hostContext.request.post('/api/texas/rooms', { data:{ smallBlind:10, bigBlind:20, buyIn:1000, maxPlayers:6 } });
  const room = (await created.json()).room;
  const hostPage = await openTrackedRoom(hostContext, room.id);

  await expect(hostPage.locator('.player-seat.self')).toHaveCount(1);
  await expect(hostPage.locator('.player-seat.self .player-name')).toContainText('（你）');
  await expectCenterClearOfSelf(hostPage);
  await hostPage.setViewportSize({ width:390, height:844 });
  await expectCenterClearOfSelf(hostPage);
  await hostPage.setViewportSize({ width:1280, height:900 });

  await guestContext.request.post(`/api/texas/rooms/${room.id}/join`, { data:{ buyIn:1000 } });
  await expectEffect(hostPage, 'seat-entry');
  await expect(hostPage.locator('.empty-seat')).toHaveCount(4);

  await hostContext.request.post(`/api/texas/rooms/${room.id}/start`, { data:{} });
  await hostPage.setViewportSize({ width:390, height:844 });
  await expectCenterClearOfSelf(hostPage);
  await expectSelfCardsInsideFelt(hostPage);
  await hostPage.setViewportSize({ width:1280, height:900 });
  const contextByUser = new Map([[host.id, hostContext], [guest.id, guestContext]]);
  const first = await takeLegalAction(contextByUser, hostContext, room.id, 'call');
  expect(first.type).toBe('call');
  await expectEffect(hostPage, 'bet');
  await takeLegalAction(contextByUser, hostContext, room.id, 'check');
  await expectEffect(hostPage, 'check');
  await expectEffect(hostPage, 'collect-pot');
  await expect(hostPage.locator('#communityCards .poker-card:not(.empty)')).toHaveCount(3);

  for (let index = 0; index < 8; index += 1) {
    const current = await roomView(hostContext, room.id);
    if (current.status === 'settled') break;
    await takeLegalAction(contextByUser, hostContext, room.id, 'check');
  }
  await expectEffect(hostPage, 'settlement');
  await expect(hostPage.locator('#communityCards .poker-card:not(.empty)')).toHaveCount(5);
  await expect(hostPage.locator('.winner-seat')).not.toHaveCount(0);
  await expect(hostPage.locator('.net-result.loss')).not.toHaveCount(0);
  await expect(hostPage.locator('#settlementStrip')).toContainText(/\+/);
  await hostContext.close();
  await guestContext.close();
});

test('fold stays concealed, does not block the next actor, does not replay, and uncontested winners stay hidden', async ({ browser, baseURL }) => {
  const contexts = [];
  const users = [];
  for (const prefix of ['弃牌甲','弃牌乙','弃牌丙']) {
    const context = await browser.newContext({ baseURL });
    contexts.push(context);
    users.push(await register(context, prefix));
  }
  const created = await contexts[0].request.post('/api/texas/rooms', { data:{ smallBlind:10, bigBlind:20, buyIn:1000, maxPlayers:6 } });
  const room = (await created.json()).room;
  await contexts[1].request.post(`/api/texas/rooms/${room.id}/join`, { data:{ buyIn:1000 } });
  await contexts[2].request.post(`/api/texas/rooms/${room.id}/join`, { data:{ buyIn:1000 } });
  await contexts[0].request.post(`/api/texas/rooms/${room.id}/start`, { data:{} });
  const pages = [];
  for (const context of contexts) pages.push(await openTrackedRoom(context, room.id));
  const contextByUser = new Map(users.map((user,index) => [user.id,contexts[index]]));
  const pageByUser = new Map(users.map((user,index) => [user.id,pages[index]]));

  const beforeFold = await roomView(contexts[0], room.id);
  const actor = beforeFold.players.find((player) => player.seat === beforeFold.currentTurn);
  await pageByUser.get(actor.userId).locator('#foldButton').click();
  const afterFold = await expect.poll(async() => {
    const value = await roomView(contexts[0], room.id);
    return value.players.find((player) => player.userId === actor.userId)?.folded ? value : null;
  }).not.toBeNull();
  const current = await roomView(contexts[0], room.id);
  const next = current.players.find((player) => player.seat === current.currentTurn);
  const nextPage = pageByUser.get(next.userId);
  await expect(nextPage.locator('#foldButton')).toBeEnabled();
  await expect(nextPage.locator('.fold-flight')).toBeVisible();
  await expect(nextPage.locator('.fold-flight-card')).toHaveCount(2);
  await expect(nextPage.locator('.fold-flight .poker-card:not(.back)')).toHaveCount(0);

  await nextPage.reload();
  await expect(nextPage.locator('#tableView')).toBeVisible();
  await expect(nextPage.locator('.fold-flight')).toHaveCount(0);
  expect(await nextPage.evaluate(() => window.__texasEffects.some((effect) => effect.kind === 'fold'))).toBe(false);

  await nextPage.locator('#foldButton').click();
  const observerPage = pages.find((page) => page !== nextPage);
  await expectEffect(observerPage, 'uncontested');
  await expect(observerPage.locator('#settlementStrip')).toContainText('无人跟注');
  const settled = await roomView(contexts[0], room.id);
  const winner = settled.players.find((player) => !player.folded);
  const foldedViewer = users.find((user) => user.id !== winner.userId);
  const foldedPage = pageByUser.get(foldedViewer.id);
  await expect(foldedPage.locator(`.player-seat[data-user-id="${winner.userId}"] .poker-card.back`)).toHaveCount(2);
  await expect(foldedPage.locator(`.player-seat[data-user-id="${winner.userId}"] .winning-card`)).toHaveCount(0);

  await Promise.all(contexts.map((context) => context.close()));
});
