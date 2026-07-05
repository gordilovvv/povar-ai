import { createServer } from 'node:http';
import { createServerAdapter } from '@whatwg-node/server';
import { IttyRouter, type RequestHandler, status, text } from 'itty-router';
import type { PoolClient } from 'pg';
import { ulid } from 'ulid';
import { env } from '../environment.ts';
import { pool, UNIQUE_ERROR_CODE } from './db/db.ts';
import { type GuestStorage, insertGuest, selectGuestByPhone } from './db/guests.ts';
import { upsertWaChat } from './db/wa-chats.ts';
import {
    insertWaMessage,
    selectWaMessage,
    updateWaMessageStatus,
    waMessageStatusRank,
    waMessageStatusSchema,
} from './db/wa-messages.ts';
import { toDateTime } from './lib/fmt.ts';
import { payloadSchema } from './platforms/whatsapp/parse.ts';
import { verifySignature } from './platforms/whatsapp/signature.ts';

const handleVerifyWebhook: RequestHandler = (request) => {
    const query = request.query;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === env.WA_SECRET) {
        return text(query['hub.challenge'] as string);
    }
    return status(200);
};

const handleWebhook: RequestHandler = async (request) => {
    const raw = await request.text();
    if (!verifySignature(raw, request.headers.get('x-hub-signature-256'))) {
        return status(401);
    }

    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        console.error(`Failed to parse body: ${raw}`);
        return status(200);
    }

    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
        console.error('webhook payload parse failed', parsed.error);
        return status(200);
    }

    const messages = parsed.data.entry.flatMap((entry) =>
        entry.changes.flatMap((change) => change.value.messages ?? []),
    );
    const statuses = parsed.data.entry.flatMap((entry) =>
        entry.changes.flatMap((change) => change.value.statuses ?? []),
    );

    const now = new Date();
    const client = await pool.connect();
    try {
        for (const message of messages) {
            const guest = await handleCreateGuest(
                client,
                message.from,
                Boolean(message.referral),
                now,
            );

            await upsertWaChat(client, message.from, guest.id, now);

            try {
                await insertWaMessage(client, {
                    id: ulid(),
                    wa_message_id: message.id,
                    wa_chat_phone: message.from,
                    text: message.text?.body ?? null,
                    owner: 'guest',
                    status: 'delivered',
                    worker_status: 'need_processed',
                    concurrency_version: 0,
                    sent_at: now,
                });
            } catch (error) {
                if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
                    throw error;
                }
            }
        }

        // Обновить статусы сообщений
        for (const update of statuses) {
            const parsedStatus = waMessageStatusSchema.safeParse(update.status);
            if (!parsedStatus.success) {
                continue;
            }
            const current = await selectWaMessage(client, update.id);
            if (!current) {
                continue;
            }
            if (waMessageStatusRank[parsedStatus.data] <= waMessageStatusRank[current.status]) {
                continue;
            }
            await updateWaMessageStatus(
                client,
                update.id,
                parsedStatus.data,
                current.concurrency_version,
            );
        }

        return status(200);
    } catch (error) {
        console.error(error);
        return status(500);
    } finally {
        client.release();
    }
};

const handleCreateGuest = async (
    client: PoolClient,
    phone: string,
    fromAd: boolean,
    now: Date,
): Promise<GuestStorage> => {
    const existing = await selectGuestByPhone(client, phone);
    if (existing) {
        return existing;
    }
    const created: GuestStorage = {
        id: ulid(),
        wa_phone: phone,
        first_name: null,
        last_name: null,
        instagram_url: null,
        came_from: fromAd ? 'ad' : 'manual',
        came_at: toDateTime(now),
        lang: null,
    };
    try {
        await insertGuest(client, created);
        return created;
    } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_ERROR_CODE) {
            return handleCreateGuest(client, phone, fromAd, now);
        }
        throw error;
    }
};

const router = IttyRouter();
router.get('/webhook', handleVerifyWebhook);
router.post('/webhook', handleWebhook);
router.all('*', () => status(404));

createServer(createServerAdapter(router.fetch)).listen(Number(env.PORT));
