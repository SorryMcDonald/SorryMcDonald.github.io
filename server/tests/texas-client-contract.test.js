import { describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('Texas browser client contract',() => {
  it('uses Supabase RPC, Realtime and server-provided action permissions',async() => {
    const html=await readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8');
    const js=await readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8');
    expect(html).toContain('SUPABASE TABLE');
    expect(js).toContain("supabase.rpc(name,args)");
    expect(js).toContain("table:'texas_sb_rooms'");
    expect(js).toContain('signInAnonymously');
    expect(js).not.toMatch(/fetch\(|new WebSocket|setInterval\(/);
    expect(js).toContain('room.allowedActions');
    expect(js).toContain("$('refreshButton').addEventListener('click',loadRooms)");
  });

  it('provides manual next-hand, leave, rebuy and responsive seat controls',async() => {
    const html=await readFile(new URL('../../public/dezhou.html',import.meta.url),'utf8');
    const js=await readFile(new URL('../../public/dezhou.js',import.meta.url),'utf8');
    const css=await readFile(new URL('../../public/dezhou.css',import.meta.url),'utf8');
    for (const id of ['startButton','leaveButton','rebuyButton','refreshButton','seats']) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('id="refillButton"');
    expect(js).toContain('已重置');
    expect(js).toContain("sessionStorage.setItem('texas.roomId'");
    expect(js).toContain('function seatPosition');
    expect(js).toContain('function playRoomEvents');
    expect(js).toContain("event.eventType==='texas_hand_settled'");
    expect(html).toContain('id="potChipStack"');
    for (const className of ['seat-enter','table-bet','mini-chip-stack','pot-chip-stack','chip-flight','round-winner','round-loser','settlement-burst']) expect(css).toContain(className);
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
    expect(css).toMatch(/@media\(max-width:620px\)/);
  });

  it('keeps Supabase credentials limited to the browser-safe anon key',async() => {
    const config=await readFile(new URL('../../public/supabase-config.js',import.meta.url),'utf8');
    expect(config).toContain('SUPABASE_URL');
    expect(config).toContain('SUPABASE_ANON_KEY');
    const token=config.match(/SUPABASE_ANON_KEY='([^']+)'/)?.[1];
    expect(token).toBeTruthy();
    const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    expect(claims.role).toBe('anon');
  });
});
