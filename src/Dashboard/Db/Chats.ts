import type { PoolClient } from 'pg';
import format from 'pg-format';
import { toDateTime } from '#Lib/Fmt.js';

export interface ChatListRow {
    wa_phone: string;
    first_name: string | null;
    last_name: string | null;
    last_message_at: string | null;
    sort_at: string;
    last_message_text: string | null;
    paused: boolean;
}

export interface ChatsCursor {
    last_message_at: string;
    wa_phone: string;
}

export interface ChatRow {
    wa_phone: string;
    first_name: string | null;
    last_name: string | null;
    last_message_at: string | null;
    last_user_message_at: string | null;
    last_bot_message_at: string | null;
    paused_at: string | null;
    pause_details: string | null;
}

export interface ChatMessageRow {
    id: string;
    text: string | null;
    owner: string;
    status: string | null;
    sent_at: string | null;
    media_type: string | null;
    media_id: string | null;
}

export const selectChat = async (client: PoolClient, phone: string) => {
    const result = await client.query<ChatRow>(
        format(
            `select
                chat.wa_phone,
                guest.first_name,
                guest.last_name,
                greatest(chat.last_sent_message_at, chat.last_received_message_at) as last_message_at,
                chat.last_received_message_at as last_user_message_at,
                chat.last_sent_message_at as last_bot_message_at,
                chat.paused_at,
                chat.pause_details
            from wa_chats chat
            left join guests guest on guest.id = chat.guest_id
            where chat.wa_phone = %L`,
            phone,
        ),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const selectChatMessages = async (
    client: PoolClient,
    phone: string,
    lastId: string | null,
    limit: number,
) => {
    const result = await client.query<ChatMessageRow>(
        format(
            `select id, text, owner, status, sent_at, media_type, media_id
            from wa_messages
            where wa_chat_phone = %L and (%L::text is null or id < %L)
            order by id desc
            limit %L`,
            phone,
            lastId,
            lastId,
            limit,
        ),
    );
    return result.rows;
};

export const insertOutgoingMessage = async (
    client: PoolClient,
    message: {
        id: string;
        waMessageId: string;
        phone: string;
        text: string | null;
        sentAt: Date;
        mediaType?: 'image';
        mediaId?: string;
    },
) => {
    await client.query(
        format(
            `insert into wa_messages
                (id, wa_message_id, wa_chat_phone, text, owner, status, sent_at, media_type, media_id)
            values
                (%L, %L, %L, %L, 'sema', 'sent', %L, %L, %L)`,
            message.id,
            message.waMessageId,
            message.phone,
            message.text,
            toDateTime(message.sentAt),
            message.mediaType ?? null,
            message.mediaId ?? null,
        ),
    );
};

export const selectMediaIdExists = async (client: PoolClient, mediaId: string) => {
    const result = await client.query(
        format(`select 1 from wa_messages where media_id = %L limit 1`, mediaId),
    );
    return result.rows.length > 0;
};

export const updateChatLastSent = async (client: PoolClient, phone: string, sentAt: Date) => {
    await client.query(
        format(
            `update wa_chats
                set last_sent_message_at = greatest(last_sent_message_at, %L)
            where wa_phone = %L`,
            toDateTime(sentAt),
            phone,
        ),
    );
};

export const updateChatPause = async (
    client: PoolClient,
    phone: string,
    pausedAt: Date | null,
    details: string | null,
) => {
    const result = await client.query(
        format(
            `update wa_chats
                set paused_at = %L, pause_details = %L
            where wa_phone = %L
            returning wa_phone`,
            pausedAt === null ? null : toDateTime(pausedAt),
            details,
            phone,
        ),
    );
    return result.rows.length > 0;
};

export const selectChatsList = async (
    client: PoolClient,
    cursor: ChatsCursor | null,
    limit: number,
    phone: string | null = null,
) => {
    const result = await client.query<ChatListRow>(
        format(
            // null last_message_at -> epoch, иначе чат без сообщений выпадает из keyset (null не проходит </=)
            `with base as (
                select
                    chat.wa_phone,
                    guest.first_name,
                    guest.last_name,
                    greatest(chat.last_sent_message_at, chat.last_received_message_at) as last_message_at,
                    coalesce(
                        greatest(chat.last_sent_message_at, chat.last_received_message_at),
                        'epoch'::timestamptz
                    ) as sort_at,
                    (select message.text
                        from wa_messages message
                        where message.wa_chat_phone = chat.wa_phone
                        order by message.id desc
                        limit 1) as last_message_text,
                    chat.paused_at is not null as paused
                from wa_chats chat
                left join guests guest on guest.id = chat.guest_id
            )
            select wa_phone, first_name, last_name, last_message_at, sort_at, last_message_text, paused
            from base
            where (%L::text is null or wa_phone like %L)
                and (%L::timestamptz is null
                    or sort_at < %L::timestamptz
                    or (sort_at = %L::timestamptz and wa_phone < %L))
            order by sort_at desc, wa_phone desc
            limit %L`,
            phone !== null ? `%${phone}%` : null,
            phone !== null ? `%${phone}%` : null,
            cursor?.last_message_at ?? null,
            cursor?.last_message_at ?? null,
            cursor?.last_message_at ?? null,
            cursor?.wa_phone ?? null,
            limit,
        ),
    );
    return result.rows;
};
