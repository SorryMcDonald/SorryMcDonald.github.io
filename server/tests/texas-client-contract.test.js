import { describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';

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
  });

  it('provides manual next-hand, leave, rebuy and responsive seat controls',async() => {
    const html=await readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8');
    const js=await readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8');
    const css=await readFile(new URL('../../public/dezhou.css',import.meta.url),'utf8');
    for (const id of ['startButton','leaveButton','rebuyButton','refreshButton','seats']) expect(html).toContain(`id="${id}"`);
    expect(js).toContain("sessionStorage.setItem('texas.roomId'");
    expect(js).toContain('function seatPosition');
    expect(css).toMatch(/@media\(max-width:620px\)/);
  });

  it('treats permitted spectating as a single global-open-card mode',async() => {
    const html=await readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8');
    const js=await readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8');
    expect(html).toContain('允许观战（观战视角全局明牌）');
    expect(html).not.toContain('spectatorCardsInput');
    expect(html).not.toContain('roomSpectatorCards');
    expect(js).not.toContain('spectatorCards:');
  });
});
