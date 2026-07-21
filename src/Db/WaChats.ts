import type { PoolClient } from 'pg';
import format from 'pg-format';
import { toDateTime } from '#Lib/Fmt.js';

export interface WaChatStorage {
    wa_phone: string;
    guest_id: string | null;
    last_sent_message_at: string | null;
    last_received_message_at: string | null;
    paused_at: string | null;
    pause_details: string | null;
}

export const upsertWaChat = async (
    client: PoolClient,
    waPhone: string,
    guestId: string,
    lastReceivedMessageAt: Date,
) => {
    await client.query(
        format(
            `insert into wa_chats (wa_phone, guest_id, last_received_message_at)
            values (%L, %L, %L)
            on conflict (wa_phone) do update
                set guest_id = excluded.guest_id,
                    last_received_message_at = greatest(
                        wa_chats.last_received_message_at,
                        excluded.last_received_message_at
                    )`,
            waPhone,
            guestId,
            toDateTime(lastReceivedMessageAt),
        ),
    );
};

export const selectWaChat = async (client: PoolClient, waPhone: string) => {
    const result = await client.query(
        format('select * from wa_chats where wa_phone = %L', waPhone),
    );

    return result.rows.length ? (result.rows[0] as WaChatStorage) : null;
};

export const updateWaChatPaused = async (
    client: PoolClient,
    waPhone: string,
    details: string,
    pausedAt: Date,
) => {
    const result = await client.query(
        format(
            `update wa_chats
                set paused_at = %L,
                    pause_details = %L
            where wa_phone = %L and paused_at is null
            returning wa_phone`,
            toDateTime(pausedAt),
            details,
            waPhone,
        ),
    );

    return result.rows.length > 0;
};

export const updateWaChatLastSent = async (
    client: PoolClient,
    waPhone: string,
    lastSentMessageAt: Date,
) => {
    await client.query(
        format(
            `update wa_chats
                set last_sent_message_at = greatest(last_sent_message_at, %L)
            where wa_phone = %L`,
            toDateTime(lastSentMessageAt),
            waPhone,
        ),
    );
};
