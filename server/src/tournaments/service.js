import { randomUUID } from 'node:crypto';

export const TOURNAMENT_BUY_IN_CAP = 200_000;
export const TOURNAMENT_REGISTRATION_MINUTES = 30;
export const TOURNAMENT_TIME_ZONE = 'Asia/Shanghai';
export const SPECIAL_TOURNAMENT_CHIPS = 200_000;
export const SPECIAL_TOURNAMENT_PRIZE = 500_000;

const GAME_CONFIG = {
  texas: { label:'德州扑克', capacity:9, minimumBuyIn:4000, path:'/dezhou.html', competition:'weekly', service:'texas' },
  zhajinhua: { label:'炸金花', capacity:6, minimumBuyIn:10, path:'/', competition:'weekly', service:'zhajinhua' },
  laizi_zhajinhua: { label:'癞子炸金花', capacity:6, minimumBuyIn:SPECIAL_TOURNAMENT_CHIPS, path:'/', competition:'permanent', service:'zhajinhua', variant:'laizi', virtualChips:SPECIAL_TOURNAMENT_CHIPS, championPrize:SPECIAL_TOURNAMENT_PRIZE, ante:1000 },
  ghost_texas: { label:'鬼王德州', capacity:9, minimumBuyIn:SPECIAL_TOURNAMENT_CHIPS, path:'/dezhou.html', competition:'permanent', service:'texas', variant:'ghost', virtualChips:SPECIAL_TOURNAMENT_CHIPS, championPrize:SPECIAL_TOURNAMENT_PRIZE, smallBlind:1000, bigBlind:1000 },
  wild_texas: { label:'百变德州', capacity:9, minimumBuyIn:SPECIAL_TOURNAMENT_CHIPS, path:'/dezhou.html', competition:'permanent', service:'texas', variant:'wild', virtualChips:SPECIAL_TOURNAMENT_CHIPS, championPrize:SPECIAL_TOURNAMENT_PRIZE, smallBlind:1000, bigBlind:1000 }
};

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tournamentSchedule(timestamp, registrationMinutes) {
  const now = Number(timestamp);
  const shanghai = new Date(now + 8 * 60 * 60 * 1000);
  const year = shanghai.getUTCFullYear();
  const month = shanghai.getUTCMonth();
  const date = shanghai.getUTCDate();
  const day = shanghai.getUTCDay();
  const wednesdayDate = date + (3 - day);
  const opensAtMs = Date.UTC(year, month, wednesdayDate, 4, 0, 0, 0);
  const localKeyDate = new Date(Date.UTC(year, month, wednesdayDate));
  const key = `${localKeyDate.getUTCFullYear()}-${String(localKeyDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localKeyDate.getUTCDate()).padStart(2, '0')}`;
  return {
    kind:'weekly',
    key:`weekly:${key}`,
    opensAt:new Date(opensAtMs).toISOString(),
    registrationClosesAt:new Date(opensAtMs + registrationMinutes * 60_000).toISOString()
  };
}

function permanentSchedule(timestamp) {
  const now = Number(timestamp);
  const shanghai = new Date(now + 8 * 60 * 60 * 1000);
  const year = shanghai.getUTCFullYear();
  const month = shanghai.getUTCMonth();
  const date = shanghai.getUTCDate();
  const localHour = shanghai.getUTCHours();
  // Registration stays open all day. Every entrant is assigned to the next
  // odd-hour Shanghai slot (13:00, 15:00, 17:00, ...).
  const slotHour = localHour % 2 === 1 ? localHour + 2 : localHour + 1;
  const opensAtMs = Date.UTC(year, month, date, slotHour - 8, 0, 0, 0);
  const localSlot = new Date(opensAtMs + 8 * 60 * 60 * 1000);
  const key = `${localSlot.getUTCFullYear()}-${String(localSlot.getUTCMonth() + 1).padStart(2, '0')}-${String(localSlot.getUTCDate()).padStart(2, '0')}-${String(localSlot.getUTCHours()).padStart(2, '0')}`;
  return {
    kind:'permanent',
    key:`permanent:${key}`,
    opensAt:new Date(opensAtMs).toISOString(),
    // Keep the original PostgreSQL CHECK (closes_at > opens_at) valid. The
    // permanent registration window is still open before the slot starts;
    // this one-millisecond boundary is only a persistence sentinel.
    registrationClosesAt:new Date(opensAtMs + 1).toISOString()
  };
}

function safeRoomStatus(game, status) {
  const config = GAME_CONFIG[game] ?? {};
  return config.service === 'texas' ? ['waiting','settled','closed'].includes(status) : ['waiting','settled','finished'].includes(status);
}

function activeRoomPlayer(room, userId) {
  return [...room.players.values()].find((player) => player.userId === userId && !player.left && !player.spectating);
}

export class TournamentService {
  constructor({ store, roomService, texasService, clock, registrationMinutes = TOURNAMENT_REGISTRATION_MINUTES, persistence } = {}) {
    this.store = store ?? { users:new Map() };
    this.roomService = roomService;
    this.texasService = texasService;
    this.clock = clock ?? { now:() => Date.now() };
    this.registrationMinutes = registrationMinutes;
    this.persistence = persistence;
    this.editions = new Map();
    this.pendingLedger = [];
  }

  now() { return Number(this.clock?.now?.() ?? Date.now()); }

  gameService(game) {
    if (GAME_CONFIG[game]?.service === 'texas') return this.texasService;
    if (GAME_CONFIG[game]?.service === 'zhajinhua') return this.roomService;
    throw httpError(400, '不支持的锦标赛游戏');
  }

  createEdition(schedule) {
    const edition = {
      id:randomUUID(), key:schedule.key, opensAt:schedule.opensAt,
      registrationClosesAt:schedule.registrationClosesAt, status:'scheduled', kind:schedule.kind ?? 'weekly',
      timezone:TOURNAMENT_TIME_ZONE, tracks:new Map()
    };
    for (const game of Object.keys(GAME_CONFIG).filter((key) => GAME_CONFIG[key].competition === (schedule.kind ?? 'weekly'))) {
      edition.tracks.set(game, {
        id:randomUUID(), game, status:'scheduled', championUserId:null,
        championPrize:0, entries:new Map(), tables:new Map(), nextTableNumber:1
      });
    }
    this.editions.set(edition.key, edition);
    return edition;
  }

  scheduledEdition(now = this.now()) {
    const schedule = tournamentSchedule(now, this.registrationMinutes);
    return this.editions.get(schedule.key) ?? this.createEdition(schedule);
  }

  permanentEdition(now = this.now()) {
    const schedule = permanentSchedule(now);
    return this.editions.get(schedule.key) ?? this.createEdition(schedule);
  }

  editionFor(kind = 'weekly', now = this.now()) {
    return kind === 'permanent' ? this.permanentEdition(now) : this.scheduledEdition(now);
  }

  editionById(editionId) {
    return [...this.editions.values()].find((edition) => edition.id === editionId) ?? null;
  }

  refreshEdition(edition, now = this.now()) {
    const opensAt = Date.parse(edition.opensAt);
    const closesAt = Date.parse(edition.registrationClosesAt);
    if (edition.kind === 'permanent' && now < opensAt) edition.status = 'registration_open';
    else if (now < opensAt) edition.status = 'scheduled';
    else if (now < closesAt) edition.status = 'registration_open';
    else if (edition.status !== 'completed' && edition.status !== 'cancelled') edition.status = 'running';
    for (const track of edition.tracks.values()) {
      if (track.status === 'completed' || track.status === 'cancelled') continue;
      if (edition.kind === 'permanent' && now < opensAt) track.status = 'registration_open';
      else if (now < opensAt) track.status = 'scheduled';
      else if (now < closesAt) track.status = 'registration_open';
      else track.status = 'running';
      if (now >= closesAt && edition.kind !== 'permanent') this.finishTrackIfPossible(edition, track);
    }
    const terminal = [...edition.tracks.values()].every((track) => ['completed','cancelled'].includes(track.status));
    if (terminal) edition.status = 'completed';
    return edition;
  }

  // Called by the server lifecycle controller so a tournament continues to
  // advance even when nobody happens to request the lobby endpoint.
  tick(now = this.now()) {
    const current = [this.editionFor('weekly', now), this.editionFor('permanent', now)];
    const editions = [...new Map([
      ...this.editions.values(),
      ...current
    ].filter((edition) => !['completed','cancelled'].includes(edition.status))
      .map((edition) => [edition.id, edition])).values()];
    const rooms = [];
    for (const edition of editions) {
      this.refreshEdition(edition, now);
      for (const track of edition.tracks.values()) {
        for (const table of track.tables.values()) {
          if (table.status !== 'active') continue;
          const config = GAME_CONFIG[track.game];
          let room;
          try {
            room = this.gameService(track.game).room(table.roomId);
          } catch {
            rooms.push({
              game:track.game, service:config.service, roomId:table.roomId,
              editionId:edition.id, startable:false
            });
            continue;
          }
          const playerCount = [...track.entries.values()].filter((entry) => (
            entry.status === 'active' && entry.roomId === room.id
            && activeRoomPlayer(room, entry.userId)
          )).length;
          const neverStarted = config.service === 'texas'
            ? room.status === 'waiting' && Number(room.handNumber ?? 0) === 0
            : room.status === 'waiting' && Number(room.roundNumber ?? 0) === 0;
          rooms.push({
            game:track.game,
            service:config.service,
            roomId:room.id,
            editionId:edition.id,
            startable:edition.kind === 'permanent'
              && now >= Date.parse(edition.opensAt)
              && playerCount >= 2
              && neverStarted
          });
        }
      }
    }
    return { editions, rooms };
  }

  assertRoomStartAllowed(game, roomId, now = this.now()) {
    const found = this.findTrackByRoom(game, roomId);
    if (!found || found.edition.kind !== 'permanent') return;
    if (now < Date.parse(found.edition.opensAt)) {
      throw httpError(403, `比赛将在 ${found.edition.opensAt} 开始`);
    }
  }

  entryForUser(track, userId) {
    return [...track.entries.values()].find((entry) => entry.userId === userId) ?? null;
  }

  serializeEntry(entry) {
    return {
      id:entry.id, userId:entry.userId, nickname:entry.nickname, buyIn:entry.buyIn,
      chips:entry.chips, status:entry.status, roomId:entry.roomId,
      enteredAt:entry.enteredAt, eliminatedAt:entry.eliminatedAt ?? null
    };
  }

  view(userId, now = this.now(), kind = 'weekly') {
    const joinedEdition = userId ? [...this.editions.values()].find((candidate) => (
      (candidate.kind ?? 'weekly') === kind &&
      [...candidate.tracks.values()].some((track) => this.entryForUser(track, userId)?.status === 'active')
    )) : null;
    const edition = this.refreshEdition(joinedEdition ?? this.editionFor(kind, now), now);
    const tracks = [...edition.tracks.values()].map((track) => {
      const entry = userId ? this.entryForUser(track, userId) : null;
      const champion = track.championUserId ? this.store.users.get(track.championUserId) : null;
      return {
        id:track.id, game:track.game, gamePath:GAME_CONFIG[track.game].path,
        label:GAME_CONFIG[track.game].label, status:track.status,
        variant:GAME_CONFIG[track.game].variant ?? null, virtualChips:GAME_CONFIG[track.game].virtualChips ?? null,
        minimumBuyIn:GAME_CONFIG[track.game].minimumBuyIn, maximumBuyIn:TOURNAMENT_BUY_IN_CAP,
        playerCount:[...track.entries.values()].filter((value) => value.status === 'active').length,
        tableCount:[...track.tables.values()].filter((table) => table.status === 'active').length, champion:champion ? { userId:champion.id, nickname:champion.nickname, prize:track.championPrize } : null,
        entry:entry ? this.serializeEntry(entry) : null
      };
    });
    return {
      id:edition.id, key:edition.key, kind:edition.kind ?? kind, status:edition.status, timezone:edition.timezone,
      opensAt:edition.opensAt, registrationClosesAt:edition.registrationClosesAt,
      serverTime:new Date(now).toISOString(), tracks
    };
  }

  availableTable(track) {
    const config = GAME_CONFIG[track.game];
    return [...track.tables.values()].find((table) => {
      if (table.status !== 'active') return false;
      const count = [...track.entries.values()].filter((entry) => entry.status === 'active' && entry.roomId === table.roomId).length;
      return count < config.capacity;
    }) ?? null;
  }

  enter(game, userId, rawBuyIn) {
    const config = GAME_CONFIG[game];
    if (!config) throw httpError(400, '不支持的锦标赛游戏');
    const now = this.now();
    const edition = this.refreshEdition(this.editionFor(config.competition, now), now);
    if (edition.status === 'scheduled') throw httpError(403, `比赛将在 ${edition.opensAt} 开放`);
    if (edition.status !== 'registration_open') throw httpError(409, config.competition === 'permanent' ? '本场比赛报名已经结束，请报名下一场' : '本周锦标赛报名已经结束');
    const track = edition.tracks.get(game);
    if (!track) throw httpError(400, '不支持的锦标赛游戏');
    if (this.entryForUser(track, userId)) throw httpError(409, '你已经参加或退出过本周该项目，不能重复加入');
    const virtual = Boolean(config.virtualChips);
    const buyIn = virtual ? config.virtualChips : Math.floor(number(rawBuyIn));
    if (buyIn < config.minimumBuyIn || buyIn > TOURNAMENT_BUY_IN_CAP) {
      throw httpError(400, `带入筹码需在 ${config.minimumBuyIn}-${TOURNAMENT_BUY_IN_CAP} 之间`);
    }
    const user = this.store.users.get(userId);
    if (!user) throw httpError(404, '用户不存在');
    if (!virtual && number(user.beans) < buyIn) throw httpError(400, '账户豆子不足以报名');

    const entry = {
      id:randomUUID(), userId, nickname:user.nickname, buyIn, chips:buyIn,
      status:'active', roomId:null, enteredAt:new Date(now).toISOString(), eliminatedAt:null
    };
    const tournament = { editionId:edition.id, trackId:track.id, game, variant:config.variant ?? null, entryId:entry.id, tableNumber:null, completed:false, virtualChips:virtual, championPrize:config.championPrize ?? null };
    const service = this.gameService(game);
    let table = this.availableTable(track);
    const previousVersion = table ? this.gameService(game).room(table.roomId).version : -1;
    const eventStart = table ? this.gameService(game).room(table.roomId).eventSeq : 0;
    let room;
    if (!table) {
      tournament.tableNumber = track.nextTableNumber++;
      room = config.service === 'texas'
        ? service.createTournamentRoom(userId, { buyIn, minBuyIn:config.minimumBuyIn, maxBuyIn:TOURNAMENT_BUY_IN_CAP, maxPlayers:config.capacity, smallBlind:config.smallBlind ?? 100, bigBlind:config.bigBlind ?? 200, variant:config.variant }, { ...tournament, virtualChips:virtual, championPrize:config.championPrize ?? null, minRaise:config.bigBlind ?? 200 })
        : service.createTournamentRoom(userId, { buyIn, ante:config.ante ?? 10, variant:config.variant }, { ...tournament, virtualChips:virtual, championPrize:config.championPrize ?? null, minRaise:config.ante ?? 10 });
      table = { id:randomUUID(), roomId:room.id, number:tournament.tableNumber, status:'active' };
      track.tables.set(table.id, table);
    } else {
      tournament.tableNumber = table.number;
      room = service.room(table.roomId);
      service.joinTournamentRoom(room.id, userId, { buyIn }, { ...tournament, virtualChips:virtual, championPrize:config.championPrize ?? null });
    }
    entry.roomId = room.id;
    track.entries.set(entry.id, entry);
    if (!virtual) this.pendingLedger.push({
      idempotencyKey:`tournament:${track.id}:buy-in:${entry.id}`, trackId:track.id, userId,
      entryType:'buy_in', amount:-buyIn, balanceAfter:number(user.beans), metadata:{ game, roomId:room.id }
    });
    return {
      edition:this.view(userId, now, config.competition), entry:this.serializeEntry(entry), roomId:room.id,
      gamePath:config.path, room:service.snapshot(room.id, userId),
      mutation:{
        previousVersion, eventStart, editionId:edition.id, trackId:track.id,
        entryId:entry.id, tableId:table.id, newTable:previousVersion === -1,
        userId, buyIn, balanceAfter:number(user.beans), virtualChips:virtual
      }
    };
  }

  findTrackByRoom(game, roomId) {
    for (const edition of this.editions.values()) {
      for (const track of edition.tracks.values()) {
        const sameService = GAME_CONFIG[track.game]?.service === (GAME_CONFIG[game]?.service ?? game);
        if (sameService && [...track.tables.values()].some((table) => table.roomId === roomId)) return { edition, track };
      }
    }
    return null;
  }

  playerChips(game, player) {
    return GAME_CONFIG[game]?.service === 'texas' ? number(player?.stack) : number(player?.tournamentChips);
  }

  reconcileRoom(game, roomId) {
    const found = this.findTrackByRoom(game, roomId);
    if (!found) return { affectedRoomIds:[], completed:false };
    const { edition, track } = found;
    const service = this.gameService(game);
    const room = service.room(roomId);
    const now = this.now();
    let roomChanged = false;
    for (const entry of track.entries.values()) {
      if (entry.roomId !== room.id || entry.status !== 'active') continue;
      const player = [...room.players.values()].find((candidate) => candidate.userId === entry.userId);
      const chips = this.playerChips(game, player);
      entry.chips = chips;
      if (player?.tournamentExited) {
        entry.status = 'left';
        entry.eliminatedAt = new Date(now).toISOString();
      } else if (chips <= 0 && safeRoomStatus(game, room.status)) {
        entry.status = 'eliminated';
        entry.eliminatedAt = new Date(now).toISOString();
        if (player) roomChanged = service.eliminateTournamentPlayer(room.id, entry.userId) || roomChanged;
      }
    }
    this.refreshEdition(edition, now);
    const affectedRoomIds = this.rebalance(edition, track);
    const completed = this.finishTrackIfPossible(edition, track);
    return { affectedRoomIds:[...new Set([...(roomChanged || completed ? [roomId] : []), ...affectedRoomIds])], completed };
  }

  rebalance(edition, track) {
    const active = [...track.entries.values()].filter((entry) => entry.status === 'active' && entry.chips > 0);
    const liveTables = [...track.tables.values()].filter((table) => table.status === 'active');
    if (active.length < 2 || liveTables.length < 2) return [];
    const service = this.gameService(track.game);
    const rooms = liveTables.map((table) => ({ table, room:service.room(table.roomId) }));
    if (!rooms.every(({ room }) => safeRoomStatus(track.game, room.status))) return [];
    const needed = Math.ceil(active.length / GAME_CONFIG[track.game].capacity);
    const keep = rooms.slice(0, needed);
    const affected = [];
    for (const source of rooms.slice(needed)) {
      const moving = active.filter((entry) => entry.roomId === source.room.id);
      for (const entry of moving) {
        const target = keep.find(({ room }) => active.filter((candidate) => candidate.roomId === room.id).length < GAME_CONFIG[track.game].capacity);
        if (!target) break;
        const chips = service.extractTournamentPlayer(source.room.id, entry.userId, { toRoomId:target.room.id });
        const tournament = { editionId:edition.id, trackId:track.id, game:track.game, entryId:entry.id, tableNumber:target.table.number, completed:false };
        service.joinTournamentRoom(target.room.id, entry.userId, { buyIn:chips, moving:true }, tournament);
        entry.roomId = target.room.id;
        entry.chips = chips;
        affected.push(source.room.id, target.room.id);
      }
      source.table.status = 'merged';
    }
    return affected;
  }

  finishTrackIfPossible(edition, track) {
    if (track.status === 'completed' || this.now() < Date.parse(edition.registrationClosesAt)) return false;
    const active = [...track.entries.values()].filter((entry) => entry.status === 'active' && entry.chips > 0);
    if (active.length > 1) return false;
    if (active.length === 0) {
      track.status = 'cancelled';
      return true;
    }
    const winner = active[0];
    const service = this.gameService(track.game);
    // Do not award a champion while the last table is still in a hand. The
    // next action/timeout will reconcile it again after the hand settles.
    let winnerRoom;
    try { winnerRoom = service.room(winner.roomId); } catch { return false; }
    if (!safeRoomStatus(track.game, winnerRoom.status)) return false;
    const prize = service.awardTournamentChampion(winner.roomId, winner.userId);
    winner.status = 'champion';
    winner.chips = 0;
    track.championUserId = winner.userId;
    track.championPrize = prize;
    track.status = 'completed';
    this.pendingLedger.push({
      idempotencyKey:`tournament:${track.id}:prize:${winner.userId}`, trackId:track.id,
      userId:winner.userId, entryType:'prize', amount:prize,
      balanceAfter:number(this.store.users.get(winner.userId)?.beans), metadata:{ game:track.game, roomId:winner.roomId }
    });
    return true;
  }
}

export { GAME_CONFIG, permanentSchedule, tournamentSchedule };
