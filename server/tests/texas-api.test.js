import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

async function register(app,email,nickname) {
  const response=await app.inject({ method:'POST',url:'/api/auth/register',payload:{ email,nickname,password:'password-123' } });
  return { cookie:response.headers['set-cookie'],user:response.json().user };
}

describe('Texas API contract',() => {
  it('serializes chat mutations and lets spectators read but not write', async () => {
    const app=await buildApp({ logger:false });
    const host=await register(app,'texas-chat-host@example.com','德州聊天房主');
    const observer=await register(app,'texas-chat-observer@example.com','德州聊天观战');
    const created=await app.inject({ method:'POST',url:'/api/texas/rooms',headers:{ cookie:host.cookie },payload:{ allowSpectators:true } });
    const room=created.json().room;
    expect((await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/spectate`,headers:{ cookie:observer.cookie },payload:{ enabled:true } })).statusCode).toBe(200);
    const denied=await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/messages`,headers:{ cookie:observer.cookie },payload:{ text:'观战者发言' } });
    expect(denied.statusCode).toBe(403);
    const accepted=await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/messages`,headers:{ cookie:host.cookie },payload:{ text:'  正常发言  ' } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().message.text).toBe('正常发言');
    const view=await app.inject({ method:'GET',url:`/api/texas/rooms/${room.id}`,headers:{ cookie:observer.cookie } });
    expect(view.json().room.messages).toEqual([expect.objectContaining({ text:'正常发言' })]);
    await app.close();
  });

  it('broadcasts Texas chat through the lifecycle event log and sync path', async () => {
    const app=await buildApp({ logger:false,attachGateway:true });
    const host=await register(app,'texas-chat-ws-host@example.com','德州聊天广播');
    const room=(await app.inject({ method:'POST',url:'/api/texas/rooms',headers:{ cookie:host.cookie },payload:{} })).json().room;
    const socket={ readyState:1,sent:[],send(value){ this.sent.push(JSON.parse(value)); },on(){} };
    app.gateway.addRoomSocket(room.id,socket,{ userId:host.user.id,game:'texas' });

    await app.gateway.handleMessage(socket,room.id,host.user.id,JSON.stringify({ type:'chat',text:'实时聊天' }),app.texas,'texas');

    expect(socket.sent.some((message) => message.game==='texas' && message.event?.eventType==='texas_chat_message'))
      .toBe(true);
    const current=app.texas.room(room.id);
    expect(current.events.at(-1)).toMatchObject({ eventType:'texas_chat_message',payload:{ message:{ text:'实时聊天' } } });
    const sync={ readyState:1,sent:[],send(value){ this.sent.push(JSON.parse(value)); } };
    await app.gateway.handleMessage(sync,room.id,host.user.id,JSON.stringify({ type:'sync',after:0 }),app.texas,'texas');
    expect(sync.sent.some((message) => message.event?.eventType==='texas_chat_message')).toBe(true);
    await app.close();
  });

  it('shares one mutation queue between both game lifecycles', async () => {
    const app=await buildApp({ logger:false,attachGateway:true });
    expect(app.texasLifecycle).toBeDefined();
    expect(app.texasLifecycle.mutationQueue).toBe(app.lifecycle.mutationQueue);
    await app.close();
  });

  it('schedules the Texas turn deadline after a versioned HTTP hand start', async () => {
    const app=await buildApp({ logger:false,attachGateway:true });
    const host=await register(app,'texas-timer-host@example.com','德州计时房主');
    const guest=await register(app,'texas-timer-guest@example.com','德州计时客人');
    const room=(await app.inject({ method:'POST',url:'/api/texas/rooms',headers:{ cookie:host.cookie },payload:{} })).json().room;
    await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/join`,headers:{ cookie:guest.cookie },payload:{} });
    expect((await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/start`,headers:{ cookie:host.cookie },payload:{} })).statusCode).toBe(200);
    expect(app.texasLifecycle.turnTimers.has(room.id)).toBe(false);
    await app.close();
  });

  it('keeps a committed HTTP mutation when a room broadcast fails', async () => {
    const app=await buildApp({ logger:false,attachGateway:true });
    const host=await register(app,'texas-postcommit-host@example.com','提交后房主');
    const guest=await register(app,'texas-postcommit-guest@example.com','提交后客人');
    const room=(await app.inject({ method:'POST',url:'/api/texas/rooms',headers:{ cookie:host.cookie },payload:{} })).json().room;
    await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/join`,headers:{ cookie:guest.cookie },payload:{} });
    app.gateway.broadcastRoom=() => { throw new Error('socket closed during broadcast'); };

    const response=await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/start`,headers:{ cookie:host.cookie },payload:{} });

    expect(response.statusCode).toBe(200);
    expect(app.texas.room(room.id).status).not.toBe('waiting');
    await app.close();
  });

  it('creates and joins rooms without exposing another player hole cards',async() => {
    const app=await buildApp({ logger:false,attachGateway:true });
    const host=await register(app,'texas-host@example.com','德州房主');
    const guest=await register(app,'texas-guest@example.com','德州客人');
    const created=await app.inject({ method:'POST',url:'/api/texas/rooms',headers:{ cookie:host.cookie },payload:{ buyIn:10000,allowSpectators:true } });
    expect(created.statusCode).toBe(200);
    const room=created.json().room;
    const joined=await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/join`,headers:{ cookie:guest.cookie },payload:{ buyIn:10000 } });
    expect(joined.statusCode).toBe(200);
    const started=await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/start`,headers:{ cookie:host.cookie },payload:{} });
    expect(started.statusCode).toBe(200);
    const hostView=started.json().room;
    const hostPlayer=hostView.players.find((player) => player.userId===host.user.id);
    const guestPlayer=hostView.players.find((player) => player.userId===guest.user.id);
    expect(hostPlayer.holeCards).toHaveLength(2);
    expect(guestPlayer).not.toHaveProperty('holeCards');
    expect(hostView.allowedActions.actions.length).toBeGreaterThan(0);
    await app.close();
  });

  it('accepts one versioned action and rejects a stale action',async() => {
    const app=await buildApp({ logger:false });
    const first=await register(app,'texas-action-a@example.com','行动甲');
    const second=await register(app,'texas-action-b@example.com','行动乙');
    const room=(await app.inject({ method:'POST',url:'/api/texas/rooms',headers:{ cookie:first.cookie },payload:{} })).json().room;
    await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/join`,headers:{ cookie:second.cookie },payload:{} });
    const state=(await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/start`,headers:{ cookie:first.cookie },payload:{} })).json().room;
    const actor=state.players.find((player) => player.seat===state.currentTurn);
    const cookie=actor.userId===first.user.id?first.cookie:second.cookie;
    const response=await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/actions`,headers:{ cookie },payload:{
      type:state.allowedActions.actions.includes('call')?'call':'check',handId:state.handId,version:state.version,
      actionSeq:actor.actionSeq+1,clientActionId:'api-action-0001'
    } });
    expect(response.statusCode).toBe(200);
    const next=response.json().room;
    const nextActor=next.players.find((player) => player.seat===next.currentTurn);
    const nextCookie=nextActor.userId===first.user.id?first.cookie:second.cookie;
    const stale=await app.inject({ method:'POST',url:`/api/texas/rooms/${room.id}/actions`,headers:{ cookie:nextCookie },payload:{
      type:'check',handId:next.handId,version:state.version,actionSeq:nextActor.actionSeq+1,clientActionId:'api-action-stale'
    } });
    expect(stale.statusCode).toBe(409);
    await app.close();
  });

  it('keeps Texas WebSocket subscriptions separate from Zhajinhua rooms',async() => {
    const app=await buildApp({ logger:false,attachGateway:true });
    const host=await register(app,'texas-ws@example.com','德州订阅者');
    const room=(await app.inject({ method:'POST',url:'/api/texas/rooms',headers:{ cookie:host.cookie },payload:{} })).json().room;
    const socket={ readyState:1,sent:[],send(value){this.sent.push(JSON.parse(value));},on(){} };
    app.gateway.addRoomSocket(room.id,socket,{ userId:host.user.id,game:'texas' });
    app.gateway.broadcastRoom(room.id,{ eventType:'texas_player_action',payload:{} },'texas');
    app.gateway.broadcastRoom(room.id,{ eventType:'player_action',payload:{} },'zhajinhua');
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ game:'texas',event:{ eventType:'texas_player_action' } });
    const sync={ readyState:1,sent:[],send(value){this.sent.push(JSON.parse(value));} };
    app.gateway.handleMessage(sync,room.id,host.user.id,JSON.stringify({ type:'sync',after:0 }),app.texas,'texas');
    expect(sync.sent.every((message) => message.game === 'texas')).toBe(true);
    await app.close();
  });
});
