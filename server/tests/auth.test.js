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
    const duplicate = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'USER@example.com', nickname: '玩家乙', password: 'password-123' } });
    expect(duplicate.statusCode).toBe(409);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });
});
