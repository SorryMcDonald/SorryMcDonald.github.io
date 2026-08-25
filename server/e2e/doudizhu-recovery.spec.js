import { expect, test } from '@playwright/test';

let sequence = 0;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function register(context, prefix) {
  sequence += 1;
  const response = await context.request.post('/api/auth/register', {
    data: {
      email: `doudizhu-recovery-${runId}-${sequence}@example.test`,
      nickname: `${prefix}${sequence}`,
      password: 'password-123'
    }
  });
  expect(response.status()).toBe(201);
}

test('restores the active Doudizhu room after a page reload and removes it on leave', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await register(context, '恢复牌桌');
  const page = await context.newPage();
  await page.goto('/doudizhu.html');

  await page.locator('#createButton').click();
  await expect(page.locator('#roomView')).toBeVisible();
  const roomCode = (await page.locator('#roomCode').textContent()).trim();
  expect(roomCode).toMatch(/^\d{6}$/);

  await page.reload();
  await expect(page.locator('#roomView')).toBeVisible();
  await expect(page.locator('#roomCode')).toHaveText(roomCode);

  await page.locator('#leaveButton').click();
  await expect(page.locator('#lobbyView')).toBeVisible();
  await expect(page.locator('#roomView')).toBeHidden();
  const directory = await context.request.get('/api/doudizhu/rooms');
  expect(directory.status()).toBe(200);
  expect((await directory.json()).currentRoom).toBeNull();
  await context.close();
});

test('shows the specific 4xx conflict message and masks server failures', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await register(context, '冲突提示');
  const page = await context.newPage();
  await page.goto('/doudizhu.html');

  await page.route('**/api/doudizhu/rooms', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Conflict', message: '账号已在其他斗地主房间' }) });
  });
  await page.locator('#createButton').click();
  await expect(page.locator('#lobbyError')).toHaveText('账号已在其他斗地主房间');

  await page.unroute('**/api/doudizhu/rooms');
  await page.route('**/api/doudizhu/rooms', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'database password leaked' }) });
  });
  await page.locator('#createButton').click();
  await expect(page.locator('#lobbyError')).toHaveText('服务器暂时不可用，请稍后重试');
  await context.close();
});
