import { describe, expect, it } from 'vitest';
import { TournamentService } from '../src/tournaments/service.js';
import { createTournamentPersistence } from '../src/tournaments/persistence.js';

describe('tournament persistence', () => {
  it('writes edition state, tracks, tables, entries and audit ledger in one transaction', async () => {
    const calls = [];
    const db = { async query(sql, values = []) { calls.push({ sql, values }); return { rows:[] }; } };
    const service = new TournamentService({ clock:{ now:() => Date.parse('2026-08-19T04:05:00Z') } });
    const edition = service.scheduledEdition();
    edition.status = 'registration_open';
    const track = edition.tracks.get('texas');
    track.status = 'registration_open';
    track.tables.set('table-id', { id:'table-id', roomId:'00000000-0000-4000-8000-000000000001', number:1, status:'active' });
    track.entries.set('entry-id', {
      id:'entry-id', userId:'00000000-0000-4000-8000-000000000002', nickname:'持久化玩家',
      buyIn:1000, chips:1000, status:'active', roomId:'00000000-0000-4000-8000-000000000001',
      enteredAt:'2026-08-19T04:05:00.000Z', eliminatedAt:null
    });
    service.pendingLedger.push({
      idempotencyKey:'tournament:test:buy-in', trackId:track.id,
      userId:'00000000-0000-4000-8000-000000000002', entryType:'buy_in', amount:-1000,
      balanceAfter:99000, metadata:{ game:'texas' }
    });

    await createTournamentPersistence({ db, service }).flushEdition(edition.id);

    expect(calls[0].sql).toBe('BEGIN');
    expect(calls.at(-1).sql).toBe('COMMIT');
    for (const table of ['tournament_editions','tournament_tracks','tournament_tables','tournament_entries','tournament_wallet_ledger']) {
      expect(calls.some((call) => call.sql.includes(`INSERT INTO ${table}`))).toBe(true);
    }
    expect(service.pendingLedger).toHaveLength(0);
  });

  it('removes a failed registration and records an offsetting refund', async () => {
    const calls = [];
    const db = { async query(sql, values = []) { calls.push({ sql, values }); return { rows:[] }; } };
    const service = new TournamentService();
    const persistence = createTournamentPersistence({ db, service });
    await persistence.rollbackRegistration({
      entryId:'entry-id', tableId:'table-id', newTable:true, trackId:'track-id',
      userId:'user-id', buyIn:1000, balanceAfter:99000
    });
    expect(calls.some((call) => call.sql.includes('DELETE FROM tournament_entries'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('DELETE FROM tournament_tables'))).toBe(true);
    expect(calls.some((call) => call.sql.includes("'refund'"))).toBe(true);
    expect(calls.at(-1).sql).toBe('COMMIT');
  });
});
