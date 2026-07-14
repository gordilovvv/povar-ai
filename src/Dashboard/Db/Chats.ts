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
