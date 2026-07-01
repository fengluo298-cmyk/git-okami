create table if not exists users (
  id text primary key,
  username text,
  password_hash text,
  nickname text not null,
  avatar_url text,
  chips integer not null,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create unique index if not exists idx_users_username on users(username) where username is not null;

create table if not exists chip_transactions (
  id text primary key,
  user_id text not null,
  type text not null,
  amount integer not null,
  before_chips integer not null,
  after_chips integer not null,
  room_id text,
  hand_id integer,
  created_at text not null default current_timestamp,
  foreign key (user_id) references users(id)
);
