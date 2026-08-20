import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

async function register(app, email, nickname) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, nickname, password: 'password-123' } });
  return { id: response.json().user.id, cookie: response.headers['set-cookie'] };
}

describe('room economy and round state', () => {
  it('lets the final actionable player act before settlement and requires a manual next round', async () => {
    const app = await buildApp({ logger: false });
    try {
      app.rooms.randomInteger = () => 0;
      const first = await register(app, 'a@example.com', '甲');
      const second = await register(app, 'b@example.com', '乙');
      const third = await register(app, 'c@example.com', '丙');
      const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: { ante: 10 } });
      const roomId = created.json().room.id;
      await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: { cookie: second.cookie }, payload: { seat: 1 } });
      await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: { cookie: third.cookie }, payload: { seat: 2 } });
      app.auth.store.users.get(first.id).beans = 20;
      app.auth.store.users.get(second.id).beans = 10;
      app.auth.store.users.get(third.id).beans = 10;
      const started = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start-next`, headers: { cookie: first.cookie } });
      expect(started.statusCode).toBe(200);
      expect(started.json().room.status).toBe('betting');
      expect(started.json().room.currentTurn).toBe(0);
      const action = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/actions`, headers: { cookie: first.cookie }, payload: { action: 'all_in', actionSeq: 1 } });
      expect(action.statusCode).toBe(200);
      expect(action.json().room.status).toBe('settled');
      const settled = action.json().room;
      const dealer = [first, second, third].find((candidate) => candidate.id === settled.dealerUserId);
      const loser = [first, second, third].find((candidate) => app.auth.store.users.get(candidate.id)?.beans === 0);
      expect(loser).toBeDefined();
      const refill = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie: loser.cookie }, payload: { confirmationText: '黄总大帅逼' } });
      expect(refill.statusCode).toBe(200);
      expect(refill.json()).toMatchObject({ refillAmount: 1000, user: { id: loser.id, beans: 1000 } });
      const next = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start-next`, headers: { cookie: dealer.cookie }, payload: {} });
      expect(next.statusCode).toBe(200);
      expect(next.json().room.status).toBe('betting');
    } finally {
      await app.close();
    }
  });
});
