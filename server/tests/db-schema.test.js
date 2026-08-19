import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const schemaPath = resolve(process.cwd(), 'sql/001_schema.sql');

describe('PostgreSQL schema contract', () => {
  it('defines the account, room, round, ledger, banner, and migration tables', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    for (const table of [
      'users', 'sessions', 'rooms', 'room_players', 'room_spectators',
      'rounds', 'round_players', 'account_ledger', 'global_banners', 'legacy_migrations'
    ]) {
      expect(sql).toMatch(new RegExp(`create table if not exists ${table}`));
    }
    expect(sql).toMatch(/lower\(email\)/i);
    expect(sql).toMatch(/unique\s*\(idempotency_key\)/i);
  });

  it('defines the room-seat safety and event notification contracts', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    expect(sql).toMatch(/unique index.*active.*room_players/i);
    expect(sql).toMatch(/pg_notify\(['"]zhajinhua_events['"]/i);
  });
});

describe('Texas PostgreSQL schema contract', () => {
  it('defines versioned rooms, private cards, pots, idempotency and an immutable wallet ledger', async () => {
    const schema = await readFile(resolve(process.cwd(), 'sql/004_texas_schema.sql'), 'utf8');
    const indexes = await readFile(resolve(process.cwd(), 'sql/005_texas_indexes.sql'), 'utf8');
    expect(schema).toMatch(/create table if not exists texas_rooms/i);
    expect(schema).toMatch(/version BIGINT/i);
    expect(schema).toMatch(/create table if not exists texas_hole_cards/i);
    expect(schema).toMatch(/create table if not exists texas_pots/i);
    expect(schema).toMatch(/idempotency_key TEXT NOT NULL UNIQUE/i);
    expect(schema).toMatch(/texas_client_actions/i);
    expect(schema).toMatch(/TEXAS_WALLET_LEDGER_IMMUTABLE/i);
    expect(indexes).toMatch(/texas_room_players_user_active_unique/i);
    expect(indexes).toMatch(/texas_room_players_room_seat_active_unique/i);
    expect(schema).not.toMatch(/UNIQUE\s*\(room_id,\s*seat\)/i);
  });
});
