import { describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';

function navLabels(html) {
  const nav = html.match(/<nav class="primary-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
  return [...nav.matchAll(/<(?:a|button)[^>]*>([^<]+)<\/(?:a|button)>/g)].map((match) => match[1].trim());
}

describe('Texas browser client contract',() => {
  it('uses only the local Texas API and server-provided action permissions',async() => {
    const html=await readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8');
    const js=await readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8');
    expect(html+js).not.toMatch(/supabase|SUPABASE_URL|SUPABASE_ANON_KEY/i);
    expect(js).toContain('/api/texas');
    expect(js).toContain('game=texas');
    expect(js).toContain('room.allowedActions');
    expect(js).toContain("$('refreshButton').addEventListener('click',loadRooms)");
    expect(js).not.toMatch(/setInterval\([^)]*loadRooms/);
    expect(html).toContain('id="smallBlindInput" type="number" min="1" value="100"');
    expect(html).toContain('id="bigBlindInput" type="number" min="2" value="200"');
    expect(html).toContain('id="createBuyInInput" type="number" min="4000" value="10000"');
    expect(js).toContain("['黄总大帅逼',1_000]");
    expect(js).toContain("['我是菜逼',10_000]");
    expect(js).toContain("renderGlobalBanner({ type:'global_banner', banner })");
  });

  it('provides manual next-hand, leave, rebuy and responsive seat controls',async() => {
    const html=await readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8');
    const js=await readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8');
    const css=await readFile(new URL('../../public/dezhou.css',import.meta.url),'utf8');
    for (const id of ['startButton','leaveButton','rebuyButton','refreshButton','seats','seatLabels']) expect(html).toContain(`id="${id}"`);
    expect(js).toContain("sessionStorage.setItem('texas.roomId'");
    expect(js).toContain('function seatPosition');
    expect(js).toContain('function renderSeatLabel');
    expect(css).toMatch(/@media\(max-width:620px\)/);
  });

  it('provides accessible rule dialogs for Texas and Zhajinhua',async() => {
    const [texasHtml, texasJs, zhajinhuaHtml, zhajinhuaJs] = await Promise.all([
      readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8'),
      readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8'),
      readFile(new URL('../../public/index.html',import.meta.url),'utf8'),
      readFile(new URL('../../public/app.js',import.meta.url),'utf8')
    ]);
    for (const html of [texasHtml, zhajinhuaHtml]) {
      expect(html).toContain('id="rulesButton"');
      expect(html).toContain('id="rulesDialog"');
      expect(html).toContain('aria-labelledby="rulesTitle"');
    }
    expect(texasHtml).toContain('同花顺');
    expect(texasHtml).toContain('未被其他玩家匹配的多余下注会返还');
    expect(zhajinhuaHtml).toContain('豹子');
    expect(zhajinhuaHtml).toContain('发起比牌的一方判负');
    expect(texasJs).toContain("$('rulesDialog').showModal()");
    expect(zhajinhuaJs).toContain("$('rulesDialog').showModal()");
  });

  it('treats permitted spectating as a single global-open-card mode',async() => {
    const html=await readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8');
    const js=await readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8');
    expect(html).toContain('允许观战（观战视角全局明牌）');
    expect(html).not.toContain('spectatorCardsInput');
    expect(html).not.toContain('roomSpectatorCards');
    expect(js).not.toContain('spectatorCards:');
  });

  it('uses the same navigation controls without mapping 牌局 back to 炸金花',async() => {
    const [zhajinhuaHtml, texasHtml, zhajinhuaJs, texasJs] = await Promise.all([
      readFile(new URL('../../public/index.html',import.meta.url),'utf8'),
      readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8'),
      readFile(new URL('../../public/app.js',import.meta.url),'utf8'),
      readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8')
    ]);
    const expected = ['牌局','游戏大厅','公开房间','德州扑克','斗地主','炸金花','锦标赛','排行榜'];
    expect(navLabels(zhajinhuaHtml)).toEqual(expected);
    expect(navLabels(texasHtml)).toEqual(expected);
    expect(zhajinhuaJs).not.toContain("destination === 'table' ? 'zjh' : destination");
    expect(texasJs).toContain('function setActiveNav');
  });

  it('provides non-blocking table animation layers and keeps fold flights concealed',async() => {
    const [html, js, css] = await Promise.all([
      readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8'),
      readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8'),
      readFile(new URL('../../public/dezhou.css',import.meta.url),'utf8')
    ]);
    for (const id of ['tableEffectsLayer','muckZone','settlementStrip']) expect(html).toContain(`id="${id}"`);
    expect(js).toContain("from './dezhou-effects.js'");
    expect(js).toContain('playTableEvent');
    expect(js).not.toMatch(/await\s+playTableEvent/);
    expect(css).toMatch(/\.table-effects-layer\{[^}]*pointer-events:none/);
    expect(css).toMatch(/\.fold-flight[^}]*\.poker-card\.back|\.fold-flight-card/);
  });
});
