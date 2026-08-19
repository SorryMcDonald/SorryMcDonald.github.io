import { describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';

const loadSql=()=>readFile(new URL('../../dezhou_supabase.sql',import.meta.url),'utf8');

describe('Texas Supabase SQL contract',() => {
  it('is SQL content rather than a Git patch',async() => {
    const sql=await loadSql();
    expect(sql).not.toMatch(/^(diff --git|index [0-9a-f]+|@@|\+\+\+|--- a\/)/m);
    expect(sql.trimStart()).toMatch(/^--/);
    expect(sql).toContain('create table if not exists public.texas_sb_rooms');
  });

  it('is authenticated, RPC-only and Realtime-enabled',async() => {
    const sql=await loadSql();
    expect(sql).toContain('auth.uid()');
    for(const table of ['profiles','rooms','players','spectators','hands','hole_cards','events','pots','client_actions']){
      expect(sql).toContain(`alter table public.texas_sb_${table} enable row level security`);
    }
    expect(sql).toContain('from anon,authenticated');
    expect(sql).toContain('grant execute on function public.texas_sb_action');
    expect(sql).toContain('grant execute on function public._texas_sb_can_view_room(uuid) to authenticated');
    expect(sql).toContain('alter publication supabase_realtime add table public.texas_sb_rooms');
  });

  it('keeps cards and game authority inside database functions',async() => {
    const sql=await loadSql();
    expect(sql).toContain("'holeCards',case when");
    expect(sql).toContain('p.user_id=v_uid');
    expect(sql).toContain('jsonb_array_length(v_eligible)=1');
    expect(sql).toContain('(v_level-v_prev)*count(*)');
    expect(sql).toContain("p_type='all_in'");
    expect(sql).toContain('p_expected_version<>r.version');
  });

  it('automatically restores an exhausted balance and records leaderboard resets',async() => {
    const sql=await loadSql();
    expect(sql).toContain('reset_count integer not null default 0');
    expect(sql).toContain('set beans=10000,reset_count=reset_count+1');
    expect(sql).toContain("p.in_hand and r.status in ('preflop','flop','turn','river','showdown')");
    expect(sql).toContain("'resetCount',reset_count");
  });

  it('contains no action timeout or automatic fold path',async() => {
    const sql=await loadSql();
    expect(sql).not.toMatch(/action_timeout|turn_deadline|auto(?:matic)?_fold|超时弃牌/i);
    expect(sql).toContain("not exists(select 1 from public.texas_sb_players p where p.room_id=texas_sb_rooms.id and not p.left_room)");
  });
});
