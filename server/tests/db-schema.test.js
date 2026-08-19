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
