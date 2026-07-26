alter table chip_transactions
  add column balance_scope text not null default 'wallet'
  check (balance_scope in ('wallet', 'table'));

create table if not exists table_escrows (
  user_id text primary key,
  room_id text not null,
  chips integer not null,
  last_hand_id integer,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  check (chips >= 0),
  check (last_hand_id is null or last_hand_id > 0),
  foreign key (user_id) references users(id)
);

create table if not exists server_runtime_lease (
  lease_key text primary key,
  owner_id text not null,
  heartbeat_at text not null,
  expires_at text not null
);

create unique index if not exists idx_chip_transactions_hand_result
  on chip_transactions(user_id, room_id, hand_id, type)
  where type in ('win_pot', 'lose_bet');
