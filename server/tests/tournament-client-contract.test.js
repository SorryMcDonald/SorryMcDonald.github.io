import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('tournament browser contract', () => {
  it('ships the top navigation entry and a manual-refresh tournament view', async () => {
    const [zjh, texas, page, client] = await Promise.all([
      readFile(resolve(process.cwd(), '../public/index.html'), 'utf8'),
      readFile(resolve(process.cwd(), '../public/dezhou.html'), 'utf8'),
      readFile(resolve(process.cwd(), '../public/tournament.html'), 'utf8'),
      readFile(resolve(process.cwd(), '../public/tournament.js'), 'utf8')
    ]);
    expect(zjh).toMatch(/href="\/tournament\.html"[^>]*>锦标赛/);
    expect(texas).toMatch(/href="\/tournament\.html"[^>]*>锦标赛/);
    expect(page).toContain('id="refreshButton"');
    expect(page).toContain('每周三');
    expect(client).toContain("/api/tournaments/current");
    expect(client).toContain("/api/tournaments/${game}/enter");
    expect(client).toContain('sessionStorage.setItem');
    expect(client).not.toContain('setInterval(loadTournament');
  });
});
