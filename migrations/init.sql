create table party (
    id text primary key,
    type text not null, -- owned | invited
    name text not null,
    price numeric,
    location text not null,
    google_map_link text,
    reels_url text,
    notes text,
    marketing_message jsonb -- { image, message }
);

create table party_tables (
    party_id text not null references party (id),
    prices jsonb,
    map text
);

create table party_time (
    party_id text not null references party (id),
    party_start_at timestamp with time zone,
    free_entry_before timestamp with time zone
);

-- Guests (users)
create table guests (
    id text primary key,
    wa_phone text unique,
    first_name text,
    last_name text,
    instagram text,
    instagram_asked_at timestamp with time zone,
    came_from text, -- ad | manual | party_invite
    came_at timestamp with time zone,
    lang text,
    marketing_enable boolean not null default true
);

create table party_guestlist (
    party_id text not null references party (id),
    guest_id text not null references guests (id),
    primary key (party_id, guest_id),
    "table" text,
    visited_party boolean,
    booked_table boolean,
    booked_table_paid boolean,
    joined_at timestamp with time zone,
    friends text[], -- имя + фамилия одной строкой на друга
    table_offered_at timestamp with time zone,
    telegram_alert_at timestamp with time zone,
    guest_confirm_answer text -- pending | yes | no | failed
);

-- WhatsApp
create table wa_chats (
    wa_phone text primary key,
    guest_id text,
    last_sent_message_at timestamp with time zone,
    last_received_message_at timestamp with time zone,
    paused_at timestamp with time zone,
    pause_details text,
    pause_alerted_at timestamp with time zone
);

create table wa_messages (
    id text primary key,
    wa_message_id text unique,
    wa_chat_phone text not null references wa_chats (wa_phone),
    text text,
    owner text not null, -- ai | guest | marketing | sema
    status text, -- idle | sent | delivered | read | failed
    worker_status text, -- need_processed | processing | processed | failed | skipped
    concurrency_version integer not null default 0,
    sent_at timestamp with time zone,
    media_type text, -- image | video | audio | document | sticker
    media_id text,
    media_key text
);

create index if not exists wa_messages_claim
    on wa_messages (worker_status, wa_chat_phone, sent_at)
    where worker_status in ('need_processed', 'processing');

create index if not exists wa_messages_chat_history
    on wa_messages (wa_chat_phone, id desc);

create index if not exists wa_messages_media_id
    on wa_messages (media_id)
    where media_id is not null;

create table wa_marketing_sends (
    party_id text not null references party (id),
    wa_phone text not null,
    primary key (party_id, wa_phone),
    sent_at timestamp with time zone
);

create index if not exists wa_marketing_sends_phone
    on wa_marketing_sends (wa_phone);

-- Dashboard
create table dashboard_users (
    id text primary key,
    phone_number text not null unique,
    created_at timestamp with time zone
);
