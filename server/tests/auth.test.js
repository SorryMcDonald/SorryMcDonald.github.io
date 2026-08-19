import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

describe('email authentication', () => {
  it('registers, logs in, protects the session, and logs out', async () => {
    const app = await buildApp({ logger: false });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'user@example.com', nickname: '玩家甲', password: 'password-123' } });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().user.beans).toBe(100000);
    const cookie = registration.headers['set-cookie'];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.titles).toEqual([]);
    const duplicate = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'USER@example.com', nickname: '玩家乙', password: 'password-123' } });
    expect(duplicate.statusCode).toBe(409);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it('returns all server-derived titles in the account response', async () => {
    const app = await buildApp({ logger: false });
    const first = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'titles-a@example.com', nickname: '称号甲', password: 'password-123' } });
    const second = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'titles-b@example.com', nickname: '称号乙', password: 'password-123' } });
    const user = app.auth.store.users.get(first.json().user.id);
    user.beans = 200000;
    user.wins = 5;
    app.auth.store.users.get(second.json().user.id).beans = 1000;

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.headers['set-cookie'] } });
    expect(me.json().user.titles).toEqual(expect.arrayContaining(['大富翁', '赌神']));
    await app.close();
  });

  it('persists the disabled comparison-effect mode', async () => {
    const app = await buildApp({ logger: false });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'motion@example.com', nickname: '动效玩家', password: 'password-123' } });
    const response = await app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { cookie: registration.headers['set-cookie'] }, payload: { motionMode: 'disabled' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.motionMode).toBe('disabled');
    await app.close();
  });
});
