import type { PoolClient } from 'pg';
import format from 'pg-format';

export interface ChatListRow {
    wa_phone: string;
    first_name: string | null;
    last_name: string | null;
    last_message_at: string | null;
    last_message_text: string | null;
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
}

export interface ChatMessageRow {
    id: string;
    text: string | null;
    owner: string;
    status: string | null;
    sent_at: string | null;
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
                chat.last_sent_message_at as last_bot_message_at
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
            `select id, text, owner, status, sent_at
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

export const selectChatsList = async (
    client: PoolClient,
    cursor: ChatsCursor | null,
    limit: number,
) => {
    const result = await client.query<ChatListRow>(
        format(
            `select
                chat.wa_phone,
                guest.first_name,
                guest.last_name,
                greatest(chat.last_sent_message_at, chat.last_received_message_at) as last_message_at,
                (select message.text
                    from wa_messages message
                    where message.wa_chat_phone = chat.wa_phone
                    order by message.id desc
                    limit 1) as last_message_text
            from wa_chats chat
            left join guests guest on guest.id = chat.guest_id
            where %L::timestamptz is null
                or greatest(chat.last_sent_message_at, chat.last_received_message_at) < %L::timestamptz
                or (greatest(chat.last_sent_message_at, chat.last_received_message_at) = %L::timestamptz
                    and chat.wa_phone < %L)
            order by last_message_at desc nulls last, chat.wa_phone desc
            limit %L`,
            cursor?.last_message_at ?? null,
            cursor?.last_message_at ?? null,
            cursor?.last_message_at ?? null,
            cursor?.wa_phone ?? null,
            limit,
        ),
    );
    return result.rows;
};
