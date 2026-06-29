import type { PoolClient } from 'pg';
import format from 'pg-format';
import { z } from 'zod';
import { toDateTime } from '../lib/fmt.ts';

export const waMessageStatusSchema = z.enum(['idle', 'sent', 'delivered', 'read', 'failed']);
type WaMessageStatus = z.infer<typeof waMessageStatusSchema>;

export type WaMessageWorkerState = 'pending' | 'processing' | 'failed' | 'done';

export interface WaMessageStorage {
    id: string;
    wa_message_id: string | null;
    wa_chat_phone: string;
    text: string | null;
    owner: string;
    status: WaMessageStatus | null;
    worker_state: WaMessageWorkerState | null;
    concurrency_version: number;
    sent_at: string;
}

type WaMessageInsert = Omit<WaMessageStorage, 'sent_at'> & { sent_at: Date };

export const insertWaMessage = async (client: PoolClient, message: WaMessageInsert) => {
    await client.query(
        format(
            `insert into wa_messages
                (id, wa_message_id, wa_chat_phone, text, owner, status, worker_state, concurrency_version, sent_at)
            values
                (%L, %L, %L, %L, %L, %L, %L, %L, %L)`,
            message.id,
            message.wa_message_id,
            message.wa_chat_phone,
            message.text,
            message.owner,
            message.status,
            message.worker_state,
            message.concurrency_version,
            toDateTime(message.sent_at),
        ),
    );
};

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

const SILENCE_WINDOW = '5 seconds';
const MAX_PROCESSING = 8;

export const claimReadyWaMessages = async (client: PoolClient): Promise<WaMessageStorage[]> => {
    const result = await client.query<WaMessageStorage>(
        format(
            `update wa_messages m
            set worker_state = 'processing'
            where m.owner = 'guest' and m.worker_state = 'pending'
              and not exists (
                select 1 from wa_messages x
                where x.wa_chat_phone = m.wa_chat_phone
                  and x.owner = 'guest' and x.worker_state = 'pending'
                  and x.sent_at > now() - %L::interval
              )
              and not exists (
                select 1 from wa_messages p
                where p.wa_chat_phone = m.wa_chat_phone and p.worker_state = 'processing'
              )
              and (select count(*) from wa_messages where worker_state = 'processing') < %s
            returning m.*`,
            SILENCE_WINDOW,
            MAX_PROCESSING,
        ),
    );
    return result.rows;
};

export const updateWaMessagesWorkerState = async (
    client: PoolClient,
    ids: string[],
    state: WaMessageWorkerState,
) => {
    await client.query(
        format('update wa_messages set worker_state = %L where id in (%L)', state, ids),
    );
};

export const resetStuckWaMessages = async (client: PoolClient) => {
    await client.query(
        "update wa_messages set worker_state = 'pending' where worker_state = 'processing'",
    );
};
