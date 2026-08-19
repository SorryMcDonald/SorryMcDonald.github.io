import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('browser client contract', () => {
  it('contains the approved safety, navigation, observer, and settings controls', async () => {
    const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
    const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    expect(html).toContain('本游戏仅虚拟娱乐，禁止任何形式现金赌博，禁止线下结算，违者责任自负');
    expect(html).toContain('leaderboardButton'); expect(html).toContain('observeButton'); expect(html).toContain('musicToggle'); expect(html).toContain('motionSelect');
    expect(html + js).not.toMatch(/supabase|SUPABASE_URL|SUPABASE_ANON_KEY/i); expect(js).toContain('textContent'); expect(js).toContain('/api/leaderboards');
  });

  it('separates the room lobby from the active table and supports leaving and room discovery', async () => {
    const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
    const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../public/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('id="roomLobby"');
    expect(html).toContain('id="roomList"');
    expect(html).toContain('id="refreshRoomsButton"');
    expect(html).toContain('id="leaveRoomButton"');
    expect(html).toContain('id="tableLayout" hidden');
    expect(js).toContain("api('/api/rooms')");
    expect(js).toContain("/leave`");
    expect(js).toContain('function renderLobby');
    expect(js).toContain('function disconnectRoomWs');
    expect(js).toContain('if(!state.room||state.room.id!==roomId)return');
    expect(js).toMatch(/async function leaveCurrentRoom\(\)\{[^}]*disconnectRoomWs\(\);[^}]*await api/);
    expect(css).toContain('.room-lobby');
    expect(css).toContain('.room-list');
  });

  it('renders poker ranks and suits instead of raw server card codes', async () => {
    const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../public/styles.css', import.meta.url), 'utf8');

    expect(js).toContain("12:'Q'");
    expect(js).toContain("C:'♣'");
    expect(js).toContain("H:'♥'");
    expect(js).not.toContain('`${card.rank}${card.suit}`');
    expect(css).toContain('.card.red');
    expect(css).toContain('.card-rank');
    expect(css).toContain('.card-suit');
    expect(js).toContain("topIndex.className='card-index card-index-top'");
    expect(js).toContain("bottomIndex.className='card-index card-index-bottom'");
    expect(js).toContain("pip.className='card-pip'");
    expect(css).toContain('aspect-ratio:5/7');
    expect(css).toMatch(/\.cards\{[^}]*align-items:center/);
    expect(css).toMatch(/\.card-index-bottom\{[^}]*rotate\(180deg\)/);
  });
});
