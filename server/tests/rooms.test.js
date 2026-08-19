import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

async function register(app, email, nickname) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, nickname, password: 'password-123' }
  });
  return { cookie: response.headers['set-cookie'], user: response.json().user };
}

describe('room directory and departure', () => {
  it('lists active rooms without private cards and lets a player leave then join another room', async () => {
    const app = await buildApp({ logger: false });
    const first = await register(app, 'rooms-a@example.com', '房主甲');
    const second = await register(app, 'rooms-b@example.com', '房主乙');
    const visitor = await register(app, 'rooms-c@example.com', '访客丙');

    const firstRoom = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: {} })).json().room;
    const secondRoom = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: second.cookie }, payload: {} })).json().room;

    const directory = await app.inject({ method: 'GET', url: '/api/rooms', headers: { cookie: visitor.cookie } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: firstRoom.code, hostNickname: '房主甲', playerCount: 1, maxPlayers: 8, status: 'waiting' }),
      expect.objectContaining({ code: secondRoom.code, hostNickname: '房主乙', playerCount: 1, maxPlayers: 8, status: 'waiting' })
    ]));
    expect(JSON.stringify(directory.json())).not.toMatch(/cards|handType/i);

    const joinedFirst = await app.inject({ method: 'POST', url: `/api/rooms/${firstRoom.id}/join`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(joinedFirst.statusCode).toBe(200);
    const leftFirst = await app.inject({ method: 'POST', url: `/api/rooms/${firstRoom.id}/leave`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(leftFirst.statusCode).toBe(200);
    const joinedSecond = await app.inject({ method: 'POST', url: `/api/rooms/${secondRoom.id}/join`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(joinedSecond.statusCode).toBe(200);

    await app.close();
  });

  it('settles the round when the current player leaves and keeps their contribution in the pot', async () => {
    const app = await buildApp({ logger: false });
    const first = await register(app, 'leave-a@example.com', '离桌甲');
    const second = await register(app, 'leave-b@example.com', '留桌乙');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: {} })).json().room;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: second.cookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: first.cookie }, payload: {} });

    const left = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: { cookie: first.cookie }, payload: {} });
    expect(left.statusCode).toBe(200);
    const snapshot = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: { cookie: second.cookie } });
    expect(snapshot.json().room.status).toBe('settled');

    const secondMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie } });
    expect(secondMe.json().user.beans).toBe(100010);
    await app.close();
  });
});
