function rows(result) { return result?.rows ?? []; }

async function transaction(db, callback) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release?.();
  }
}

export function createTournamentPersistence({ db, service }) {
  return {
    async hydrate() {
      const editions = rows(await db.query('SELECT * FROM tournament_editions ORDER BY opens_at'));
      const tracks = rows(await db.query('SELECT * FROM tournament_tracks'));
      const entries = rows(await db.query('SELECT * FROM tournament_entries'));
      const tables = rows(await db.query('SELECT * FROM tournament_tables'));
      for (const row of editions) {
        service.editions.set(row.edition_key, {
          id:row.id, key:row.edition_key, opensAt:new Date(row.opens_at).toISOString(),
          registrationClosesAt:new Date(row.registration_closes_at).toISOString(),
          status:row.status, timezone:row.timezone,
          kind:row.competition_kind ?? (String(row.edition_key).startsWith('permanent:') ? 'permanent' : 'weekly'),
          tracks:new Map()
        });
      }
      for (const row of tracks) {
        const edition=[...service.editions.values()].find((value) => value.id === row.edition_id);
        if (!edition) continue;
        edition.tracks.set(row.game, {
          id:row.id, game:row.game, status:row.status, championUserId:row.champion_user_id,
          championPrize:Number(row.champion_prize), nextTableNumber:Number(row.next_table_number),
          entries:new Map(), tables:new Map()
        });
      }
      for (const row of entries) {
        const track=[...service.editions.values()].flatMap((edition) => [...edition.tracks.values()]).find((value) => value.id === row.track_id);
        if (!track) continue;
        track.entries.set(row.id, {
          id:row.id, userId:row.user_id, nickname:row.nickname, buyIn:Number(row.buy_in), chips:Number(row.chips),
          status:row.status, roomId:row.game_room_id, enteredAt:new Date(row.entered_at).toISOString(),
          eliminatedAt:row.eliminated_at ? new Date(row.eliminated_at).toISOString() : null
        });
      }
      for (const row of tables) {
        const track=[...service.editions.values()].flatMap((edition) => [...edition.tracks.values()]).find((value) => value.id === row.track_id);
        if (track) track.tables.set(row.id, { id:row.id, roomId:row.game_room_id, number:Number(row.table_number), status:row.status });
      }
    },

    async flushEdition(editionId) {
      const edition=service.editionById(editionId);
      if (!edition) return;
      const trackIds = new Set([...edition.tracks.values()].map((track) => track.id));
      const ledger=service.pendingLedger.filter((entry) => trackIds.has(entry.trackId));
      await transaction(db, async (client) => {
        await client.query(`INSERT INTO tournament_editions
          (id,edition_key,opens_at,registration_closes_at,status,timezone,competition_kind)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (id) DO UPDATE SET status=excluded.status,
            registration_closes_at=excluded.registration_closes_at,
            competition_kind=excluded.competition_kind`,
          [edition.id,edition.key,edition.opensAt,edition.registrationClosesAt,edition.status,edition.timezone,edition.kind ?? 'weekly']);
        for (const track of edition.tracks.values()) {
          await client.query(`INSERT INTO tournament_tracks
            (id,edition_id,game,status,champion_user_id,champion_prize,next_table_number)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (id) DO UPDATE SET status=excluded.status,champion_user_id=excluded.champion_user_id,
              champion_prize=excluded.champion_prize,next_table_number=excluded.next_table_number`,
            [track.id,edition.id,track.game,track.status,track.championUserId,track.championPrize,track.nextTableNumber]);
          for (const table of track.tables.values()) {
            await client.query(`INSERT INTO tournament_tables (id,track_id,table_number,game_room_id,status)
              VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET game_room_id=excluded.game_room_id,status=excluded.status`,
              [table.id,track.id,table.number,table.roomId,table.status]);
          }
          for (const entry of track.entries.values()) {
            await client.query(`INSERT INTO tournament_entries
              (id,track_id,user_id,nickname,buy_in,chips,status,game_room_id,entered_at,eliminated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
              ON CONFLICT (id) DO UPDATE SET chips=excluded.chips,status=excluded.status,
                game_room_id=excluded.game_room_id,eliminated_at=excluded.eliminated_at`,
              [entry.id,track.id,entry.userId,entry.nickname,entry.buyIn,entry.chips,entry.status,entry.roomId,entry.enteredAt,entry.eliminatedAt]);
          }
        }
        for (const item of ledger) {
          if (item.amount === 0) continue;
          await client.query(`INSERT INTO tournament_wallet_ledger
            (idempotency_key,track_id,user_id,entry_type,amount,balance_after,metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING`,
            [item.idempotencyKey,item.trackId,item.userId,item.entryType,item.amount,item.balanceAfter,item.metadata ?? {}]);
        }
      });
      const flushed = new Set(ledger);
      service.pendingLedger = service.pendingLedger.filter((entry) => !flushed.has(entry));
    },

    async rollbackRegistration(mutation) {
      await transaction(db, async (client) => {
        await client.query('DELETE FROM tournament_entries WHERE id=$1', [mutation.entryId]);
        if (mutation.newTable) await client.query('DELETE FROM tournament_tables WHERE id=$1', [mutation.tableId]);
        await client.query(`INSERT INTO tournament_wallet_ledger
          (idempotency_key,track_id,user_id,entry_type,amount,balance_after,metadata)
          VALUES ($1,$2,$3,'refund',$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`, [
          `tournament:${mutation.trackId}:rollback:${mutation.entryId}`,
          mutation.trackId,mutation.userId,mutation.buyIn,mutation.balanceAfter + mutation.buyIn,
          { reason:'room_persistence_failed', entryId:mutation.entryId }
        ]);
      });
    }
  };
}
