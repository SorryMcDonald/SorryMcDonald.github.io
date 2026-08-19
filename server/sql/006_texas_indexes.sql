create index if not exists texas_rooms_public_updated_idx
  on texas_rooms (is_public, status, updated_at desc) where status <> 'closed';
create index if not exists texas_room_players_room_active_idx
  on texas_room_players (room_id, seat) where left_room = false;
create unique index if not exists texas_room_players_room_seat_active_unique
  on texas_room_players (room_id, seat) where left_room = false;
create unique index if not exists texas_room_players_user_active_unique
  on texas_room_players (user_id) where left_room = false;
create index if not exists texas_hands_room_number_idx
  on texas_hands (room_id, hand_number desc);
create index if not exists texas_actions_room_seq_idx
  on texas_actions (room_id, event_seq);
create index if not exists texas_actions_hand_idx
  on texas_actions (hand_id, id);
create index if not exists texas_wallet_ledger_user_created_idx
  on texas_wallet_ledger (user_id, created_at desc);
create index if not exists texas_client_actions_room_created_idx
  on texas_client_actions (room_id, created_at desc);
