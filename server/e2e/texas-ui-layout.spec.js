import { expect, test } from '@playwright/test';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function register(context, prefix) {
  const response = await context.request.post('/api/auth/register', {
    data: { email: `layout-${prefix}-${runId}@example.test`, nickname: `布局${prefix}`, password: 'password-123' }
  });
  expect(response.status()).toBe(201);
  return (await response.json()).user;
}

test('keeps the desktop table dominant and mobile controls inside the viewport', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const guestContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const host = await register(hostContext, 'host');
  await register(guestContext, 'guest');
  const created = await hostContext.request.post('/api/texas/rooms', { data: { smallBlind: 10, bigBlind: 20, buyIn: 1000, maxPlayers: 6 } });
  expect(created.status()).toBe(200);
  const room = (await created.json()).room;
  expect((await guestContext.request.post(`/api/texas/rooms/${room.id}/join`, { data: { buyIn: 1000 } })).status()).toBe(200);
  expect((await hostContext.request.post(`/api/texas/rooms/${room.id}/ready`, { data: { ready:true } })).status()).toBe(200);
  expect((await guestContext.request.post(`/api/texas/rooms/${room.id}/ready`, { data: { ready:true } })).status()).toBe(200);
  expect((await hostContext.request.post(`/api/texas/rooms/${room.id}/start`, { data: {} })).status()).toBe(200);

  await hostContext.addInitScript((id) => sessionStorage.setItem('texas.roomId', id), room.id);
  const desktop = await hostContext.newPage();
  await desktop.goto('/dezhou.html');
  await expect(desktop.locator('#tableView')).toBeVisible();
  const desktopLayout = await desktop.evaluate(() => {
    const tableLayout = document.querySelector('#tableView').getBoundingClientRect();
    const felt = document.querySelector('#pokerTable').getBoundingClientRect();
    const action = document.querySelector('#actionBar').getBoundingClientRect();
    const selfCards = document.querySelector('.player-seat.self .hole-cards').getBoundingClientRect();
    const round = document.querySelector('.round-panel').getBoundingClientRect();
    const chat = document.querySelector('.chat-panel').getBoundingClientRect();
    const chatForm = document.querySelector('#chatForm').getBoundingClientRect();
    const facts = document.querySelector('.table-facts').getBoundingClientRect();
    return {
      tableRatio: felt.width / tableLayout.width,
      roundLeftOfFelt: round.right <= felt.left + 2,
      chatRightOfFelt: chat.left >= felt.right - 2,
      actionInsideFelt: action.top >= felt.top && action.bottom <= felt.bottom + 2,
      actionCenterDelta: Math.abs((action.left + action.width / 2) - (felt.left + felt.width / 2)),
      selfCardsAboveAction: selfCards.bottom <= action.top + 2,
      chatFormInsidePanel: chatForm.bottom <= chat.bottom + 2,
      factsAfterSupport: facts.top >= chat.bottom - 2
    };
  });
  expect(desktopLayout.tableRatio).toBeGreaterThanOrEqual(0.58);
  expect(desktopLayout.roundLeftOfFelt).toBe(true);
  expect(desktopLayout.chatRightOfFelt).toBe(true);
  expect(desktopLayout.actionInsideFelt).toBe(true);
  expect(desktopLayout.actionCenterDelta).toBeLessThanOrEqual(4);
  expect(desktopLayout.selfCardsAboveAction).toBe(true);
  expect(desktopLayout.chatFormInsidePanel).toBe(true);
  expect(desktopLayout.factsAfterSupport).toBe(true);

  await desktop.setViewportSize({ width: 1912, height: 918 });
  const wideDesktop = await desktop.evaluate(() => ({
    feltWidth: document.querySelector('#pokerTable').getBoundingClientRect().width,
    actionBottom: document.querySelector('#actionBar').getBoundingClientRect().bottom,
    scrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(wideDesktop.feltWidth).toBeGreaterThanOrEqual(900);
  expect(wideDesktop.actionBottom).toBeLessThanOrEqual(918);
  expect(wideDesktop.scrollWidth).toBeLessThanOrEqual(wideDesktop.viewport);

  await guestContext.addInitScript((id) => sessionStorage.setItem('texas.roomId', id), room.id);
  const mobile = await guestContext.newPage();
  await mobile.goto('/dezhou.html');
  await expect(mobile.locator('#tableView')).toBeVisible();
  const mobileLayout = await mobile.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const table = document.querySelector('#pokerTable').getBoundingClientRect();
    const action = document.querySelector('#actionBar').getBoundingClientRect();
    return { viewport, scrollWidth: document.documentElement.scrollWidth, tableRight: table.right, actionRight: action.right };
  });
  expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.viewport);
  expect(mobileLayout.tableRight).toBeLessThanOrEqual(mobileLayout.viewport);
  expect(mobileLayout.actionRight).toBeLessThanOrEqual(mobileLayout.viewport);

  await hostContext.close();
  await guestContext.close();
});

test('keeps the Zhajinhua activity and chat rails beside a large responsive table', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext({ baseURL, viewport:{ width:1280, height:900 } });
  const guestContext = await browser.newContext({ baseURL, viewport:{ width:390, height:844 } });
  await register(hostContext, 'zjh-host');
  await register(guestContext, 'zjh-guest');
  const created = await hostContext.request.post('/api/rooms', { data:{} });
  const room = (await created.json()).room;
  expect((await guestContext.request.post(`/api/rooms/${room.id}/join`, { data:{} })).status()).toBe(200);
  expect((await hostContext.request.post(`/api/rooms/${room.id}/ready`, { data:{ ready:true } })).status()).toBe(200);
  expect((await guestContext.request.post(`/api/rooms/${room.id}/ready`, { data:{ ready:true } })).status()).toBe(200);
  expect((await hostContext.request.post(`/api/rooms/${room.id}/start-next`, { data:{} })).status()).toBe(200);

  await hostContext.addInitScript((id) => sessionStorage.setItem('zhajinhua.roomId', id), room.id);
  const desktop = await hostContext.newPage();
  await desktop.goto('/');
  await expect(desktop.locator('#tableLayout')).toBeVisible();
  const layout = await desktop.evaluate(() => {
    const stage = document.querySelector('#tableLayout').getBoundingClientRect();
    const felt = document.querySelector('#felt').getBoundingClientRect();
    const round = document.querySelector('.round-panel').getBoundingClientRect();
    const chat = document.querySelector('.chat-panel').getBoundingClientRect();
    const chatForm = document.querySelector('#chatForm').getBoundingClientRect();
    const action = document.querySelector('#actionPanel').getBoundingClientRect();
    const selfCards = document.querySelector('.player-seat.self .cards').getBoundingClientRect();
    return {
      tableRatio:felt.width / stage.width,
      feltVerticalShift:felt.top - (stage.top + (stage.height - felt.height) / 2),
      roundLeftOfFelt:round.right <= felt.left + 2,
      chatRightOfFelt:chat.left >= felt.right - 2,
      actionInsideStage:action.top >= felt.top && action.bottom <= stage.bottom + 2,
      actionCenterDelta:Math.abs((action.left + action.width / 2) - (felt.left + felt.width / 2)),
      selfCardsAboveAction:selfCards.bottom <= action.top + 2,
      chatFormInsidePanel:chatForm.bottom <= chat.bottom + 2,
      chatFormBottom:chatForm.bottom,
      scrollWidth:document.documentElement.scrollWidth,
      viewport:document.documentElement.clientWidth
    };
  });
  expect(layout.tableRatio).toBeGreaterThanOrEqual(0.58);
  expect(layout.feltVerticalShift).toBeLessThanOrEqual(-39);
  expect(layout.roundLeftOfFelt).toBe(true);
  expect(layout.chatRightOfFelt).toBe(true);
  expect(layout.actionInsideStage).toBe(true);
  expect(layout.actionCenterDelta).toBeLessThanOrEqual(4);
  expect(layout.selfCardsAboveAction).toBe(true);
  expect(layout.chatFormInsidePanel).toBe(true);
  expect(layout.chatFormBottom).toBeLessThanOrEqual(900);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);

  await desktop.setViewportSize({ width:1912, height:918 });
  const wide = await desktop.evaluate(() => ({
    feltWidth:document.querySelector('#felt').getBoundingClientRect().width,
    actionBottom:document.querySelector('#actionPanel').getBoundingClientRect().bottom,
    scrollWidth:document.documentElement.scrollWidth,
    viewport:document.documentElement.clientWidth
  }));
  expect(wide.feltWidth).toBeGreaterThanOrEqual(900);
  expect(wide.actionBottom).toBeLessThanOrEqual(918);
  expect(wide.scrollWidth).toBeLessThanOrEqual(wide.viewport);

  await guestContext.addInitScript((id) => sessionStorage.setItem('zhajinhua.roomId', id), room.id);
  const mobile = await guestContext.newPage();
  await mobile.goto('/');
  await expect(mobile.locator('#tableLayout')).toBeVisible();
  const narrow = await mobile.evaluate(() => {
    const felt = document.querySelector('#felt').getBoundingClientRect();
    const action = document.querySelector('#actionPanel').getBoundingClientRect();
    return {
      viewport:document.documentElement.clientWidth,
      scrollWidth:document.documentElement.scrollWidth,
      feltRight:felt.right,
      actionRight:action.right
    };
  });
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.viewport);
  expect(narrow.feltRight).toBeLessThanOrEqual(narrow.viewport);
  expect(narrow.actionRight).toBeLessThanOrEqual(narrow.viewport);

  await hostContext.close();
  await guestContext.close();
});
