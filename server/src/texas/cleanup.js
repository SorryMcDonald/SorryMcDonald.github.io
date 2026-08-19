const DEFAULT_CLOSED_RETENTION_HOURS = 24 * 30;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function cleanupTexasRooms(db, options = {}) {
  const retentionHours = positiveNumber(options.closedRetentionHours, DEFAULT_CLOSED_RETENTION_HOURS);
  const closed = await db.query(`UPDATE texas_rooms AS room
    SET status='closed',
        state=jsonb_set(
          jsonb_set(COALESCE(room.state,'{}'::jsonb),'{status}',to_jsonb('closed'::text),true),
          '{currentTurn}',to_jsonb(-1),true
        )
    WHERE room.status <> 'closed'
      AND NOT EXISTS (
        SELECT 1 FROM texas_room_players AS player
        WHERE player.room_id=room.id AND player.left_room=false
      )
    RETURNING room.id`);
  const pruned = await db.query(`UPDATE texas_rooms
    SET state='{}'::jsonb
    WHERE status='closed' AND state <> '{}'::jsonb
      AND updated_at < now() - ($1 * interval '1 hour')
    RETURNING id`, [retentionHours]);
  return { closed:closed.rows.length, pruned:pruned.rows.length };
}

export { DEFAULT_CLOSED_RETENTION_HOURS };
