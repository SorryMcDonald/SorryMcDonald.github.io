import { describe,expect,it } from 'vitest';
import { cleanupTexasRooms } from '../src/texas/cleanup.js';

describe('Texas room cleanup',() => {
  it('only closes rooms without active players and prunes old runtime state',async() => {
    const queries=[];
    const db={ async query(text,values=[]) { queries.push({ text,values }); return { rows:[{ id:'room' }] }; } };
    const result=await cleanupTexasRooms(db,{ closedRetentionHours:48 });
    expect(result).toEqual({ closed:1,pruned:1 });
    expect(queries[0].text).toMatch(/NOT EXISTS[\s\S]*left_room=false/i);
    expect(queries[0].text).not.toMatch(/preflop.*interval|current_turn.*interval/i);
    expect(queries[1].text).toMatch(/status='closed'/i);
    expect(queries[1].text).toMatch(/SET state='\{\}'::jsonb/i);
    expect(queries[1].text).not.toMatch(/DELETE FROM/i);
    expect(queries[1].values).toEqual([48]);
  });
});
