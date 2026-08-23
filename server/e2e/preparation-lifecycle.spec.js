import { expect, test } from '@playwright/test';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;

async function register(context, game) {
  sequence += 1;
  const response = await context.request.post('/api/auth/register', {
    data:{ email:`decision-${game}-${runId}-${sequence}@example.test`, nickname:`${game}决策${sequence}`, password:'password-123' }
  });
  expect(response.status()).toBe(201);
  return (await response.json()).user;
}

async function openRoom(context, roomId, { route, storageKey }) {
  await context.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), { key:storageKey, id:roomId });
  const page = await context.newPage();
  await page.goto(route);
  await expect(page.locator('#preparationDialog')).toBeVisible();
  return page;
}

test('Zhajinhua keeps seated observers read-only and lets the winner release the next round', async ({ browser, baseURL }) => {
  const contexts = await Promise.all(Array.from({ length:3 }, () => browser.newContext({ baseURL })));
  const users = [];
  for (const context of contexts) users.push(await register(context, '炸金花'));
  const created = await contexts[0].request.post('/api/rooms', { data:{} });
  const room = (await created.json()).room;
  for (const context of contexts.slice(1)) expect((await context.request.post(`/api/rooms/${room.id}/join`, { data:{} })).status()).toBe(200);
  const pages = [];
  for (const context of contexts) pages.push(await openRoom(context, room.id, { route:'/', storageKey:'zhajinhua.roomId' }));

  await pages[2].keyboard.press('Escape');
  await expect(pages[2].locator('#preparationDialog')).toBeVisible();
  await pages[2].locator('#prepSpectateButton').click();
  await expect(pages[2].locator('#preparationDialog')).toBeHidden();
  await expect(pages[2].locator('.player-seat')).toHaveCount(3);
  await expect(pages[2].locator('.player-seat.self')).toHaveCount(1);
  await expect(pages[2].locator('#chatInput')).toBeDisabled();

  await pages[0].locator('#prepReadyButton').click();
  await pages[1].locator('#prepReadyButton').click();
  await expect.poll(async() => (await (await contexts[0].request.get(`/api/rooms/${room.id}`)).json()).room.status).toBe('betting');
  const observerView = (await (await contexts[2].request.get(`/api/rooms/${room.id}`)).json()).room;
  expect(observerView).toMatchObject({ isSpectator:false, preparation:{ status:'spectate', viewOnly:true } });
  expect(observerView.players.find((player) => player.userId === users[2].id)).toMatchObject({ inRound:false, waiting:true });
  await expect(pages[2].locator('.player-seat:not(.self) .card:not(.back)')).toHaveCount(6);

  const active = (await (await contexts[0].request.get(`/api/rooms/${room.id}`)).json()).room;
  const actor = active.players.find((player) => player.seat === active.currentTurn);
  const actorIndex = users.findIndex((user) => user.id === actor.userId);
  const settledResponse = await contexts[actorIndex].request.post(`/api/rooms/${room.id}/actions`, { data:{ action:'fold', actionSeq:actor.actionSeq + 1 } });
  expect(settledResponse.status()).toBe(200);
  const settled = (await settledResponse.json()).room;
  const winnerIndex = users.findIndex((user) => user.id === settled.lastWinnerUserId);
  const loserIndex = [0,1].find((index) => index !== winnerIndex);
  await expect(pages[winnerIndex].locator('#settlementDialog')).toBeVisible();
  await expect(pages[loserIndex].locator('#settlementDialog')).toBeVisible();
  await expect(pages[2].locator('#preparationDialog')).toBeVisible();
  await pages[2].locator('#prepLeaveButton').click();
  await expect(pages[2].locator('#roomLobby')).toBeVisible();

  await pages[loserIndex].locator('#settlementNextButton').click();
  await expect(pages[loserIndex].locator('#settlementDialog')).toBeHidden();
  await pages[winnerIndex].locator('#settlementNextButton').click();
  await expect.poll(async() => (await (await contexts[winnerIndex].request.get(`/api/rooms/${room.id}`)).json()).room.status).toBe('betting');
  await expect(pages[winnerIndex].locator('#settlementDialog')).toBeHidden();
  await Promise.all(contexts.map((context) => context.close()));
});

test('Texas keeps seated observers read-only and lets the winner release the next hand', async ({ browser, baseURL }) => {
  const contexts = await Promise.all(Array.from({ length:3 }, () => browser.newContext({ baseURL })));
  const users = [];
  for (const context of contexts) users.push(await register(context, '德州'));
  const created = await contexts[0].request.post('/api/texas/rooms', { data:{ buyIn:1000, maxPlayers:6 } });
  const room = (await created.json()).room;
  for (const context of contexts.slice(1)) expect((await context.request.post(`/api/texas/rooms/${room.id}/join`, { data:{ buyIn:1000 } })).status()).toBe(200);
  const pages = [];
  for (const context of contexts) pages.push(await openRoom(context, room.id, { route:'/dezhou.html', storageKey:'texas.roomId' }));

  await pages[2].keyboard.press('Escape');
  await expect(pages[2].locator('#preparationDialog')).toBeVisible();
  await pages[2].locator('#prepSpectateButton').click();
  await expect(pages[2].locator('#preparationDialog')).toBeHidden();
  await expect(pages[2].locator('.player-seat')).toHaveCount(3);
  await expect(pages[2].locator('.player-seat.self')).toHaveCount(1);
  await expect(pages[2].locator('#chatInput')).toBeDisabled();

  await pages[0].locator('#prepReadyButton').click();
  await pages[1].locator('#prepReadyButton').click();
  await expect.poll(async() => (await (await contexts[0].request.get(`/api/texas/rooms/${room.id}`)).json()).room.status).toBe('preflop');
  const observerView = (await (await contexts[2].request.get(`/api/texas/rooms/${room.id}`)).json()).room;
  expect(observerView).toMatchObject({ isSpectator:false, preparation:{ status:'spectate', viewOnly:true } });
  expect(observerView.players.find((player) => player.userId === users[2].id)).toMatchObject({ inHand:false, waiting:true });
  await expect(pages[2].locator('.player-seat:not(.self) .hole-cards .poker-card:not(.back)')).toHaveCount(4);

  const active = (await (await contexts[0].request.get(`/api/texas/rooms/${room.id}`)).json()).room;
  const actor = active.players.find((player) => player.seat === active.currentTurn);
  const actorIndex = users.findIndex((user) => user.id === actor.userId);
  const actorView = (await (await contexts[actorIndex].request.get(`/api/texas/rooms/${room.id}`)).json()).room;
  const actorState = actorView.players.find((player) => player.userId === actor.userId);
  const settledResponse = await contexts[actorIndex].request.post(`/api/texas/rooms/${room.id}/actions`, {
    data:{ type:'fold', handId:actorView.handId, version:actorView.version, actionSeq:actorState.actionSeq + 1, clientActionId:`decision-${runId}` }
  });
  expect(settledResponse.status()).toBe(200);
  const settled = (await settledResponse.json()).room;
  const winnerIndex = users.findIndex((user) => user.id === settled.lastWinnerUserId);
  const loserIndex = [0,1].find((index) => index !== winnerIndex);
  await expect(pages[winnerIndex].locator('#settlementDialog')).toBeVisible();
  await expect(pages[loserIndex].locator('#settlementDialog')).toBeVisible();
  await expect(pages[winnerIndex].locator('#settlementResults > div')).toHaveCount(2);
  await expect(pages[2].locator('#preparationDialog')).toBeVisible();
  await pages[2].locator('#prepLeaveButton').click();
  await expect(pages[2].locator('#lobbyView')).toBeVisible();

  await pages[loserIndex].locator('#settlementNextButton').click();
  await expect(pages[loserIndex].locator('#settlementDialog')).toBeHidden();
  await pages[winnerIndex].locator('#settlementNextButton').click();
  await expect.poll(async() => (await (await contexts[winnerIndex].request.get(`/api/texas/rooms/${room.id}`)).json()).room.status).toBe('preflop');
  await expect(pages[winnerIndex].locator('#settlementDialog')).toBeHidden();
  await Promise.all(contexts.map((context) => context.close()));
});
