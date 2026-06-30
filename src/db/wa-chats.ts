import type { PoolClient } from 'pg';
import format from 'pg-format';
import { toDateTime } from '../lib/fmt.ts';

export interface WaChatStorage {
    wa_phone: string;
    guest_id: string | null;
    last_sent_message_at: string | null;
    last_received_message_at: string | null;
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
