create table party (
    id text primary key,
    name text not null,
    location text not null,
    google_map_link text,
    price numeric
);

create table party_ads (
    party_id text not null references party (id),
    source_ad_id text not null
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
    instagram_url text,
    came_from text, -- ad | manual
    came_at timestamp with time zone
);

create table party_guestlist (
    party_id text not null references party (id),
    guest_id text not null references guests (id),
    primary key (party_id, guest_id),
    "table" text,
    visited_party boolean,
    booked_table boolean,
    booked_table_paid boolean,
    joined_at timestamp with time zone
);

-- WhatsApp
create table wa_chats (
    wa_phone text primary key,
    guest_id text,
    last_sent_message_at timestamp with time zone,
    last_received_message_at timestamp with time zone
);

create table wa_messages (
    id text primary key,
    wa_message_id text unique,
    wa_chat_phone text not null references wa_chats (wa_phone),
    text text,
    owner text not null, -- ai | guest | marketing | sema
    status text, -- idle | sent | delivered | read | failed
    concurrency_version integer not null default 0,
    sent_at timestamp with time zone
);

-- Webhooks-queue
create table webhook_tasks (
    id text primary key,
    platform text not null, -- whatsapp | instagram
    data jsonb not null,
    retry integer not null default 0
);
