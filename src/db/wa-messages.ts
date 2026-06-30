import type { PoolClient } from 'pg';
import format from 'pg-format';
import { z } from 'zod';
import { toDateTime } from '../lib/fmt.ts';

export const waMessageStatusSchema = z.enum(['idle', 'sent', 'delivered', 'read', 'failed']);

type WaMessageStatus = z.infer<typeof waMessageStatusSchema>;
type WaWorkerStatus = 'need_processed' | 'processing' | 'processed' | 'failed';

export const waMessageStatusRank: Record<WaMessageStatus, number> = Object.fromEntries(
    waMessageStatusSchema.options.map((status, index) => [status, index]),
) as Record<WaMessageStatus, number>;

export interface WaMessageStorage {
    id: string;
    wa_message_id: string | null;
    wa_chat_phone: string;
    text: string | null;
    owner: string;
    status: WaMessageStatus;
    worker_status: WaWorkerStatus | null;
    concurrency_version: number;
    sent_at: string;
}

type WaMessageInsert = Omit<WaMessageStorage, 'sent_at'> & { sent_at: Date };

export const insertWaMessage = async (client: PoolClient, message: WaMessageInsert) => {
    await client.query(
        format(
            `insert into wa_messages
                (id, wa_message_id, wa_chat_phone, text, owner, status, worker_status, concurrency_version, sent_at)
            values
                (%L, %L, %L, %L, %L, %L, %L, %L, %L)`,
            message.id,
            message.wa_message_id,
            message.wa_chat_phone,
            message.text,
            message.owner,
            message.status,
            message.worker_status,
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

// Атомарно захватываем готовые чаты и помечаем ВСЕ их сообщения processing.
export const updateWaMessagesToProcessing = async (
    client: PoolClient,
    beforeSentAt: string,
    chatLimit: number,
) => {
    const result = await client.query<WaMessageStorage>(
        format(
            `update wa_messages
                set worker_status = 'processing'
            where worker_status = 'need_processed'
                and wa_chat_phone in (
                    select wa_chat_phone from wa_messages
                    where worker_status = 'need_processed'
                        and wa_chat_phone not in (
                            select wa_chat_phone from wa_messages where worker_status = 'processing'
                        )
                    group by wa_chat_phone
                    having max(sent_at) <= %L
                    order by min(sent_at)
                    limit %L
                )
            returning *`,
            beforeSentAt,
            chatLimit,
        ),
    );
    return result.rows;
};

export const updateWaMessagesWorkerStatus = async (
    client: PoolClient,
    ids: string[],
    workerStatus: WaWorkerStatus,
) => {
    await client.query(
        format('update wa_messages set worker_status = %L where id = any(%L)', workerStatus, ids),
    );
};

export const updateProcessingToFailed = async (client: PoolClient) => {
    await client.query(
        "update wa_messages set worker_status = 'failed' where worker_status = 'processing'",
    );
};
