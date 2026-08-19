import { deserializeRoom, serializeRoom } from './persistence.js';
import { TexasService } from './service.js';

function copyUsers(store) { return new Map([...store.users].map(([id,user]) => [id,{ ...user }])); }
function restoreUsers(store, before) { for (const [id,user] of before) store.users.set(id,user); }

export function registerTexasRoutes(app, options = {}) {
  const service=options.service ?? new TexasService({ store:options.store ?? app.auth?.store });
  const persistence=options.persistence;
  let commandTail=Promise.resolve();
  const enqueue=(command) => {
    const result=commandTail.catch(() => {}).then(command);
    commandTail=result.catch(() => {});
    return result;
  };
  const requireUser=async(request,reply) => { if (!request.user) return reply.code(401).send({ error:'需要登录' }); };
  app.decorate('texas',service);

  async function mutate(roomId, command) {
    return enqueue(async() => {
      const room=service.room(roomId);
      const beforeRoom=serializeRoom(room);
      const beforeUsers=copyUsers(service.store);
      const previousVersion=room.version;
      const eventStart=room.eventSeq;
      try {
        command(room);
        await persistence?.flushRoom(room.id,previousVersion,eventStart);
        const events=room.events.filter((event) => event.id > eventStart);
        for (const event of events) app.gateway?.broadcastRoom(room.id,event,'texas');
        return room;
      } catch (error) {
        service.rooms.set(room.id,deserializeRoom(beforeRoom));
        restoreUsers(service.store,beforeUsers);
        throw error;
      }
    });
  }

  app.get('/api/texas/rooms',{ preHandler:requireUser },async() => ({ rooms:service.listRooms() }));
  app.post('/api/texas/rooms',{ preHandler:requireUser },async(request) => enqueue(async() => {
    const beforeUsers=copyUsers(service.store);
    let room;
    try {
      room=service.createRoom(request.user.id,request.body ?? {});
      await persistence?.flushRoom(room.id,-1,0);
      return { room:service.snapshot(room.id,request.user.id) };
    } catch(error) {
      if (room) service.rooms.delete(room.id);
      restoreUsers(service.store,beforeUsers);
      throw error;
    }
  }));
  app.get('/api/texas/rooms/:roomId',{ preHandler:requireUser },async(request) => ({ room:service.snapshot(request.params.roomId,request.user.id) }));
  app.post('/api/texas/rooms/:roomId/join',{ preHandler:requireUser },async(request) => {
    const room=await mutate(request.params.roomId,() => service.joinRoom(request.params.roomId,request.user.id,request.body ?? {}));
    return { room:service.snapshot(room.id,request.user.id) };
  });
  app.post('/api/texas/rooms/:roomId/start',{ preHandler:requireUser },async(request) => {
    const room=await mutate(request.params.roomId,() => service.startHand(request.params.roomId,request.user.id));
    return { room:service.snapshot(room.id,request.user.id) };
  });
  app.post('/api/texas/rooms/:roomId/actions',{ preHandler:requireUser },async(request) => {
    const room=await mutate(request.params.roomId,() => service.action(request.params.roomId,request.user.id,request.body ?? {}));
    return { room:service.snapshot(room.id,request.user.id) };
  });
  app.post('/api/texas/rooms/:roomId/rebuy',{ preHandler:requireUser },async(request) => {
    const room=await mutate(request.params.roomId,() => service.rebuy(request.params.roomId,request.user.id,request.body?.amount));
    return { room:service.snapshot(room.id,request.user.id) };
  });
  app.post('/api/texas/rooms/:roomId/leave',{ preHandler:requireUser },async(request) => {
    await mutate(request.params.roomId,() => service.leaveRoom(request.params.roomId,request.user.id));
    return { ok:true };
  });
  app.post('/api/texas/rooms/:roomId/spectate',{ preHandler:requireUser },async(request) => {
    const enabled=request.body?.enabled ?? true;
    const room=await mutate(request.params.roomId,() => service.setSpectating(request.params.roomId,request.user.id,enabled));
    return enabled ? { room:service.snapshot(room.id,request.user.id) } : { ok:true };
  });
  app.post('/api/texas/rooms/:roomId/settings',{ preHandler:requireUser },async(request) => {
    const room=await mutate(request.params.roomId,() => service.updateSettings(request.params.roomId,request.user.id,request.body ?? {}));
    return { room:service.snapshot(room.id,request.user.id) };
  });
  return service;
}
