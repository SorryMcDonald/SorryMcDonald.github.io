import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

async function register(app, email, nickname) {
  const response = await app.inject({ method:'POST', url:'/api/auth/register', payload:{ email, nickname, password:'password-123' } });
  expect(response.statusCode).toBe(201);
  return { cookie:response.headers['set-cookie'], user:response.json().user };
}

describe('Zhajinhua preparation API', () => {
  it('requires ready endpoints before starting and returns preparation state', async () => {
    const app = await buildApp({ logger:false });
    const host = await register(app, 'prep-zjh-host@example.com', '炸金花准备房主');
    const guest = await register(app, 'prep-zjh-guest@example.com', '炸金花准备客人');
    const created = await app.inject({ method:'POST', url:'/api/rooms', headers:{ cookie:host.cookie }, payload:{ allowSpectators:true } });
    const room = created.json().room;
    await app.inject({ method:'POST', url:`/api/rooms/${room.id}/join`, headers:{ cookie:guest.cookie }, payload:{ seat:1 } });

    const blocked = await app.inject({ method:'POST', url:`/api/rooms/${room.id}/start-next`, headers:{ cookie:host.cookie }, payload:{} });
    expect(blocked.statusCode).toBe(409);
    const readyHost = await app.inject({ method:'POST', url:`/api/rooms/${room.id}/ready`, headers:{ cookie:host.cookie }, payload:{ ready:true } });
    expect(readyHost.statusCode).toBe(200);
    const pendingGuest = await app.inject({ method:'GET', url:`/api/rooms/${room.id}`, headers:{ cookie:guest.cookie } });
    expect(pendingGuest.statusCode).toBe(200);
    expect(pendingGuest.json().room.preparation).toMatchObject({ required:true, status:'pending', viewOnly:true });
    const readyGuest = await app.inject({ method:'POST', url:`/api/rooms/${room.id}/ready`, headers:{ cookie:guest.cookie }, payload:{ ready:true } });
    expect(readyGuest.statusCode).toBe(200);
    const started = await app.inject({ method:'POST', url:`/api/rooms/${room.id}/start-next`, headers:{ cookie:host.cookie }, payload:{} });
    expect(started.statusCode).toBe(200);
    expect(started.json().room.players.every((player) => player.inRound)).toBe(true);
    await app.close();
  });
});
