import { randomUUID } from 'node:crypto';

export const TOURNAMENT_BUY_IN_CAP = 200_000;
export const TOURNAMENT_REGISTRATION_MINUTES = 30;
export const TOURNAMENT_TIME_ZONE = 'Asia/Shanghai';

const GAME_CONFIG = {
  texas: { label:'德州扑克', capacity:9, minimumBuyIn:400, path:'/dezhou.html' },
  zhajinhua: { label:'炸金花', capacity:6, minimumBuyIn:10, path:'/' }
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
    key,
    opensAt:new Date(opensAtMs).toISOString(),
    registrationClosesAt:new Date(opensAtMs + registrationMinutes * 60_000).toISOString()
  };
}

function safeRoomStatus(game, status) {
  return game === 'texas' ? ['waiting','settled','closed'].includes(status) : ['waiting','settled','finished'].includes(status);
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
    if (game === 'texas') return this.texasService;
    if (game === 'zhajinhua') return this.roomService;
    throw httpError(400, '不支持的锦标赛游戏');
  }

  createEdition(schedule) {
    const edition = {
      id:randomUUID(), key:schedule.key, opensAt:schedule.opensAt,
      registrationClosesAt:schedule.registrationClosesAt, status:'scheduled',
      timezone:TOURNAMENT_TIME_ZONE, tracks:new Map()
    };
    for (const game of Object.keys(GAME_CONFIG)) {
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

  editionById(editionId) {
    return [...this.editions.values()].find((edition) => edition.id === editionId) ?? null;
  }

  refreshEdition(edition, now = this.now()) {
    const opensAt = Date.parse(edition.opensAt);
    const closesAt = Date.parse(edition.registrationClosesAt);
    if (now < opensAt) edition.status = 'scheduled';
    else if (now < closesAt) edition.status = 'registration_open';
    else if (edition.status !== 'completed' && edition.status !== 'cancelled') edition.status = 'running';
    for (const track of edition.tracks.values()) {
      if (track.status === 'completed' || track.status === 'cancelled') continue;
      if (now < opensAt) track.status = 'scheduled';
      else if (now < closesAt) track.status = 'registration_open';
      else track.status = 'running';
      if (now >= closesAt) this.finishTrackIfPossible(edition, track);
    }
    const terminal = [...edition.tracks.values()].every((track) => ['completed','cancelled'].includes(track.status));
    if (terminal) edition.status = 'completed';
    return edition;
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

  view(userId, now = this.now()) {
    const joinedEdition = userId ? [...this.editions.values()].find((candidate) => (
      [...candidate.tracks.values()].some((track) => this.entryForUser(track, userId)?.status === 'active')
    )) : null;
    const edition = this.refreshEdition(joinedEdition ?? this.scheduledEdition(now), now);
    const tracks = [...edition.tracks.values()].map((track) => {
      const entry = userId ? this.entryForUser(track, userId) : null;
      const champion = track.championUserId ? this.store.users.get(track.championUserId) : null;
      return {
        id:track.id, game:track.game, label:GAME_CONFIG[track.game].label, status:track.status,
        minimumBuyIn:GAME_CONFIG[track.game].minimumBuyIn, maximumBuyIn:TOURNAMENT_BUY_IN_CAP,
        playerCount:[...track.entries.values()].filter((value) => value.status === 'active').length,
        tableCount:[...track.tables.values()].filter((table) => table.status === 'active').length, champion:champion ? { userId:champion.id, nickname:champion.nickname, prize:track.championPrize } : null,
        entry:entry ? this.serializeEntry(entry) : null
      };
    });
    return {
      id:edition.id, key:edition.key, status:edition.status, timezone:edition.timezone,
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
    const now = this.now();
    const edition = this.refreshEdition(this.scheduledEdition(now), now);
    if (edition.status === 'scheduled') throw httpError(403, `锦标赛将在 ${edition.opensAt} 开放`);
    if (edition.status !== 'registration_open') throw httpError(409, '本周锦标赛报名已经结束');
    const track = edition.tracks.get(game);
    if (!track) throw httpError(400, '不支持的锦标赛游戏');
    if (this.entryForUser(track, userId)) throw httpError(409, '你已经参加或退出过本周该项目，不能重复加入');
    const config = GAME_CONFIG[game];
    const buyIn = Math.floor(number(rawBuyIn));
    if (buyIn < config.minimumBuyIn || buyIn > TOURNAMENT_BUY_IN_CAP) {
      throw httpError(400, `带入筹码需在 ${config.minimumBuyIn}-${TOURNAMENT_BUY_IN_CAP} 之间`);
    }
    const user = this.store.users.get(userId);
    if (!user) throw httpError(404, '用户不存在');
    if (number(user.beans) < buyIn) throw httpError(400, '账户豆子不足以报名');

    const entry = {
      id:randomUUID(), userId, nickname:user.nickname, buyIn, chips:buyIn,
      status:'active', roomId:null, enteredAt:new Date(now).toISOString(), eliminatedAt:null
    };
    const tournament = { editionId:edition.id, trackId:track.id, game, entryId:entry.id, tableNumber:null, completed:false };
    const service = this.gameService(game);
    let table = this.availableTable(track);
    const previousVersion = table ? this.gameService(game).room(table.roomId).version : -1;
    const eventStart = table ? this.gameService(game).room(table.roomId).eventSeq : 0;
    let room;
    if (!table) {
      tournament.tableNumber = track.nextTableNumber++;
      room = game === 'texas'
        ? service.createTournamentRoom(userId, { buyIn, minBuyIn:400, maxBuyIn:TOURNAMENT_BUY_IN_CAP, maxPlayers:config.capacity, smallBlind:10, bigBlind:20 }, tournament)
        : service.createTournamentRoom(userId, { buyIn, ante:10 }, tournament);
      table = { id:randomUUID(), roomId:room.id, number:tournament.tableNumber, status:'active' };
      track.tables.set(table.id, table);
    } else {
      tournament.tableNumber = table.number;
      room = service.room(table.roomId);
      service.joinTournamentRoom(room.id, userId, { buyIn }, tournament);
    }
    entry.roomId = room.id;
    track.entries.set(entry.id, entry);
    this.pendingLedger.push({
      idempotencyKey:`tournament:${track.id}:buy-in:${entry.id}`, trackId:track.id, userId,
      entryType:'buy_in', amount:-buyIn, balanceAfter:number(user.beans), metadata:{ game, roomId:room.id }
    });
    return {
      edition:this.view(userId, now), entry:this.serializeEntry(entry), roomId:room.id,
      gamePath:config.path, room:service.snapshot(room.id, userId),
      mutation:{
        previousVersion, eventStart, editionId:edition.id, trackId:track.id,
        entryId:entry.id, tableId:table.id, newTable:previousVersion === -1,
        userId, buyIn, balanceAfter:number(user.beans)
      }
    };
  }

  findTrackByRoom(game, roomId) {
    for (const edition of this.editions.values()) {
      for (const track of edition.tracks.values()) {
        if (track.game === game && [...track.tables.values()].some((table) => table.roomId === roomId)) return { edition, track };
      }
    }
    return null;
  }

  playerChips(game, player) {
    return game === 'texas' ? number(player?.stack) : number(player?.tournamentChips);
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

export { GAME_CONFIG, tournamentSchedule };
