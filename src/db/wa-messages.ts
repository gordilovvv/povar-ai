import type { PoolClient } from 'pg';
import format from 'pg-format';
import { z } from 'zod';
import { toDateTime } from '../lib/fmt.ts';

export const waMessageStatusSchema = z.enum([
    'idle',
    'sent',
    'delivered',
    'read',
    'failed',
    'received',
    'processed',
]);
type WaMessageStatus = z.infer<typeof waMessageStatusSchema>;

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

type WaMessageInsert = Omit<WaMessageStorage, 'sent_at'> & { sent_at: Date };

export const insertWaMessage = async (client: PoolClient, message: WaMessageInsert) => {
    await client.query(
        format(
            `insert into wa_messages
                (id, wa_message_id, wa_chat_phone, text, owner, status, concurrency_version, sent_at)
            values
                (%L, %L, %L, %L, %L, %L, %L, %L)`,
            message.id,
            message.wa_message_id,
            message.wa_chat_phone,
            message.text,
            message.owner,
            message.status,
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

export const setWaMessageStatus = async (
    client: PoolClient,
    waMessageId: string,
    status: WaMessageStatus,
) => {
    await client.query(
        format(
            'update wa_messages set status = %L where wa_message_id = %L',
            status,
            waMessageId,
        ),
    );
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

export const updateMessagesStatus = async (
    client: PoolClient,
    ids: string[],
    status: WaMessageStatus,
) => {
    await client.query(
        `update wa_messages set status = $1 where id = any($2::text[])`,
        [status, ids],
    );
};

export const claimChatMessages = async (client: PoolClient, maxConcurrent: number) => {
    const result = await client.query<WaMessageStorage>(
        format(
            `with current as (
                select count(*)::int as cnt from wa_chats where worker_state = 'processing'
            ),
            ready as (
                select wa_chat_phone
                from wa_messages
                where status = 'received'
                group by wa_chat_phone
                having max(sent_at) <= now() - interval '5' second
                order by max(sent_at) asc
                limit greatest(0, %L - (select cnt from current))
            ),
            locked as (
                update wa_chats
                set worker_state = 'processing'
                where wa_phone in (select wa_chat_phone from ready)
                    and worker_state is distinct from 'processing'
                returning wa_phone
            )
            update wa_messages
            set status = 'processed'
            from locked
            where wa_messages.wa_chat_phone = locked.wa_phone
                and wa_messages.status = 'received'
            returning
                wa_messages.id,
                wa_messages.wa_message_id,
                wa_messages.wa_chat_phone,
                wa_messages.text,
                wa_messages.owner,
                wa_messages.status,
                wa_messages.concurrency_version,
                wa_messages.sent_at`,
            maxConcurrent,
        ),
    );
    return result.rows;
};
