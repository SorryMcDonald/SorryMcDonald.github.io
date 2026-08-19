import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

async function register(app, email, nickname) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, nickname, password: 'password-123' } });
  return { id: response.json().user.id, cookie: response.headers['set-cookie'] };
}

describe('room economy and round state', () => {
  it('continues after one all-in and requires a manual next round', async () => {
    const app = await buildApp({ logger: false });
    const first = await register(app, 'a@example.com', '甲');
    const second = await register(app, 'b@example.com', '乙');
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: { ante: 10 } });
    const roomId = created.json().room.id;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: { cookie: second.cookie }, payload: { seat: 1 } });
    const started = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start-next`, headers: { cookie: first.cookie } });
    expect(started.statusCode).toBe(200);
    const allIn = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/actions`, headers: { cookie: first.cookie }, payload: { action: 'all_in', actionSeq: 1 } });
    expect(allIn.statusCode).toBe(200);
    expect(allIn.json().room.status).toBe('betting');
    const secondAllIn = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/actions`, headers: { cookie: second.cookie }, payload: { action: 'all_in', actionSeq: 1 } });
    expect(secondAllIn.statusCode).toBe(200);
    expect(secondAllIn.json().room.status).toBe('settled');
    const settled = secondAllIn.json().room;
    const dealer = settled.dealerUserId === first.id ? first : second;
    const loser = settled.dealerUserId === first.id ? second : first;
    await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie: loser.cookie } });
    const next = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start-next`, headers: { cookie: dealer.cookie }, payload: {} });
    expect(next.statusCode).toBe(200);
    expect(next.json().room.status).toBe('betting');
    await app.close();
  });
});
