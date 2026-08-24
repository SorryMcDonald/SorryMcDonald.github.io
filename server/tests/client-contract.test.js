import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('browser client contract', () => {
  it('contains the approved safety, navigation, observer, and settings controls', async () => {
    const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
    const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    expect(html).toContain('本游戏仅虚拟娱乐，禁止任何形式现金赌博，禁止线下结算，违者责任自负');
    expect(html).toContain('leaderboardButton'); expect(html).toContain('observeButton'); expect(html).toContain('musicToggle'); expect(html).toContain('motionSelect');
    expect(html + js).not.toMatch(/supabase|SUPABASE_URL|SUPABASE_ANON_KEY/i); expect(js).toContain('textContent'); expect(js).toContain('/api/leaderboards');
    expect(html).toMatch(/class="tab-button active"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="leaderboardList"/);
    expect(html).toMatch(/id="leaderboardList"[^>]*role="tabpanel"/);
    expect(js).toContain("setAttribute('aria-selected'");
    expect(js).toMatch(/async function loadLeaderboard[\s\S]*?try[\s\S]*?catch/);
    expect(html).toMatch(/<a[^>]+href="\/dezhou\.html"[^>]*>德州扑克<\/a>/);
  });

  it('exposes Doudizhu as an open cross-game destination', async () => {
    const [zhajinhuaHtml, texasHtml, zhajinhuaJs] = await Promise.all([
      readFile(new URL('../../public/index.html', import.meta.url), 'utf8'),
      readFile(new URL('../../public/dezhou.html', import.meta.url), 'utf8'),
      readFile(new URL('../../public/app.js', import.meta.url), 'utf8')
    ]);

    for (const html of [zhajinhuaHtml, texasHtml]) {
      expect(html).toMatch(/<a class="nav-link" data-nav="landlord" href="\/doudizhu\.html">斗地主<\/a>/);
      expect(html).not.toMatch(/nav-link-muted[^>]*data-nav="landlord"/);
    }
    expect(zhajinhuaJs).toContain("document.querySelectorAll('button[data-nav]')");
    expect(zhajinhuaJs).not.toContain("document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener");
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

    expect(js).toMatch(/12:\s*'Q'/);
    expect(js).toMatch(/C:\s*'♣'/);
    expect(js).toMatch(/H:\s*'♥'/);
    expect(js).not.toContain('`${card.rank}${card.suit}`');
    expect(css).toContain('.card.red');
    expect(css).toContain('.card-rank');
    expect(css).toContain('.card-suit');
    expect(js).toMatch(/topIndex\.className\s*=\s*'card-index card-index-top'/);
    expect(js).toMatch(/bottomIndex\.className\s*=\s*'card-index card-index-bottom'/);
    expect(js).toMatch(/pip\.className\s*=\s*'card-pip'/);
    expect(css).toContain('aspect-ratio:5/7');
    expect(css).toMatch(/\.cards\{[^}]*align-items:center/);
    expect(css).toMatch(/\.card-index-bottom\{[^}]*rotate\(180deg\)/);
  });

  it('contains the approved south-seat actions, dialogs, chat, refill, and effect modes', async () => {
    const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
    const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../public/styles.css', import.meta.url), 'utf8');

    for (const id of ['raiseDialog', 'compareDialog', 'refillDialog', 'chatForm', 'turnCountdown', 'revealButton']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('<option value="disabled">关闭</option>');
    expect(html).toContain('data-kind="wealth"');
    expect(js).toContain('function projectSeats');
    expect(js).toContain("['黄总大帅逼', 1_000]");
    expect(js).toContain("['我是菜逼', 10_000]");
    expect(js).toContain('body: { confirmationText }');
    expect(js).toContain("renderGlobalBanner({ type: 'global_banner', banner })");
    expect(js).toContain("type:'chat'");
    expect(js).toContain('playCompareEffect');
    expect(js).not.toMatch(/players\.find\([^\n]+userId!==state\.user\.id/);
    expect(css).toContain('.player-seat.self');
    expect(css).toContain('.turn-countdown.danger');
    expect(css).toContain('body[data-compare-effect="cinematic"]');
  });
});
