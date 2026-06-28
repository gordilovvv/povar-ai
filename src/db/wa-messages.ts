import type { PoolClient } from 'pg';
import format from 'pg-format';

type WaMessageStatus = 'idle' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WaMessageStorage {
    id: string;
    wa_message_id: string | null;
    wa_chat_phone: string;
    text: string | null;
    owner: string;
    status: WaMessageStatus;
    concurrency_version: number;
    sent_at: string;
}

export const selectWaMessage = async (client: PoolClient, waMessageId: string) => {
    const result = await client.query<WaMessageStorage>(
        format('select * from wa_messages where wa_message_id = %L', waMessageId),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const updateWaMessageStatus = async (
    client: PoolClient,
    waMessageId: string,
    status: WaMessageStatus,
    concurrencyVersion: number,
) => {
    const result = await client.query<WaMessageStorage>(
        format(
            `update wa_messages
                set status = %L, concurrency_version = concurrency_version + 1
                where wa_message_id = %L and concurrency_version = %L
                returning *`,
            status,
            waMessageId,
            concurrencyVersion,
        ),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const selectWaChatMessages = async (
    client: PoolClient,
    waChatPhone: string,
    lastId: string | null,
    limit: number,
) => {
    const result = await client.query<WaMessageStorage>(
        format(
            'select * from wa_messages where wa_chat_phone = %L and (%L::text is null or id < %L) order by id desc limit %L',
            waChatPhone,
            lastId,
            lastId,
            limit,
        ),
    );
    return result.rows;
};
