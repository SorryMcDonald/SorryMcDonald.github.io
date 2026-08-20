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

  it('allows the persisted disabled comparison-effect mode for new and existing databases', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const migration = await readFile(resolve(process.cwd(), 'sql/004_animation_mode_disabled.sql'), 'utf8');
    expect(schema).toMatch(/animation_mode\s+IN\s*\('light',\s*'cinematic',\s*'disabled'\)/i);
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS users_animation_mode_check/i);
    expect(migration).toMatch(/ADD CONSTRAINT users_animation_mode_check[\s\S]*'disabled'/i);
  });
});

describe('Texas PostgreSQL schema contract', () => {
  it('defines versioned rooms, private cards, pots, idempotency and an immutable wallet ledger', async () => {
    const schema = await readFile(resolve(process.cwd(), 'sql/005_texas_schema.sql'), 'utf8');
    const indexes = await readFile(resolve(process.cwd(), 'sql/006_texas_indexes.sql'), 'utf8');
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

  it('ships fail-closed post-migration assertions for production promotion', async () => {
    const assertions = await readFile(resolve(process.cwd(), 'deploy/verify-schema.sql'), 'utf8');
    expect(assertions).toMatch(/users_animation_mode_check/i);
    for (const table of [
      'texas_rooms', 'texas_room_players', 'texas_hands', 'texas_hand_players',
      'texas_hole_cards', 'texas_actions', 'texas_pots', 'texas_wallet_ledger',
      'texas_client_actions'
    ]) expect(assertions).toContain(table);
    for (const trigger of [
      'trg_texas_rooms_updated_at', 'trg_texas_room_players_updated_at',
      'trg_texas_actions_notify', 'trg_texas_wallet_ledger_immutable'
    ]) expect(assertions).toContain(trigger);
    expect(assertions).toMatch(/RAISE EXCEPTION/i);
  });
});

describe('Tournament PostgreSQL schema contract', () => {
  it('defines weekly editions, game tracks, tables, entries and immutable wallet history', async () => {
    const schema = await readFile(resolve(process.cwd(), 'sql/007_tournaments.sql'), 'utf8');
    for (const table of ['tournament_editions','tournament_tracks','tournament_tables','tournament_entries','tournament_wallet_ledger']) {
      expect(schema).toMatch(new RegExp(`create table if not exists ${table}`, 'i'));
    }
    expect(schema).toMatch(/buy_in\s*>\s*0\s+AND\s+buy_in\s*<=\s*200000/i);
    expect(schema).toMatch(/UNIQUE\s*\(track_id,\s*user_id\)/i);
    expect(schema).toMatch(/TOURNAMENT_WALLET_LEDGER_IMMUTABLE/i);
    expect(schema).toMatch(/tournament_buy_in/);
    expect(schema).toMatch(/tournament_prize/);
  });
});
