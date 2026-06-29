import { createServer } from 'node:http';
import { createServerAdapter } from '@whatwg-node/server';
import { IttyRouter, type RequestHandler, status, text } from 'itty-router';
import { ulid } from 'ulid';
import { z } from 'zod';
import { env } from '../environment.ts';
import { pool, UNIQUE_ERROR_CODE } from './db/db.ts';
import { insertGuest, selectGuestByPhone } from './db/guests.ts';
import { upsertWaChat } from './db/wa-chats.ts';
import { insertWaMessage, selectWaMessage, updateWaMessageStatus } from './db/wa-messages.ts';
import { toDateTime } from './lib/fmt.ts';
import { payloadSchema, type WaMessage, type WaStatus } from './platforms/whatsapp/parse.ts';
import { verifySignature } from './platforms/whatsapp/signature.ts';

const deliveryStatusSchema = z.enum(['sent', 'delivered', 'read', 'failed']);

const handleVerifyWebhook: RequestHandler = (request) => {
    const query = request.query;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === env.WA_SECRET) {
        return text(query['hub.challenge'] as string);
    }
    return status(200);
};

const syncStatus = async (clientStatus: WaStatus) => {
    const client = await pool.connect();
    try {
        const parsed = deliveryStatusSchema.safeParse(clientStatus.status);
        if (!parsed.success) {
            return;
        }
        const existing = await selectWaMessage(client, clientStatus.id);
        if (!existing) {
            return;
        }
        await updateWaMessageStatus(
            client,
            clientStatus.id,
            parsed.data,
            existing.concurrency_version,
        );
    } finally {
        client.release();
    }
};

const saveIncomingMessage = async (message: WaMessage) => {
    const client = await pool.connect();
    try {
        const sentAt = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();

        let guest = await selectGuestByPhone(client, message.from);
        if (!guest) {
            try {
                guest = await insertGuest(client, {
                    id: ulid(),
                    wa_phone: message.from,
                    first_name: null,
                    last_name: null,
                    instagram_url: null,
                    came_from: message.referral ? 'ad' : null,
                    came_at: toDateTime(new Date()),
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== UNIQUE_ERROR_CODE) {
                    throw error;
                }
                guest = await selectGuestByPhone(client, message.from);
            }
            if (!guest) {
                throw new Error(`guest missing for ${message.from}`);
            }
        }

        await upsertWaChat(client, message.from, guest.id, sentAt);

        try {
            await insertWaMessage(client, {
                id: ulid(),
                wa_message_id: message.id,
                wa_chat_phone: message.from,
                text: message.text?.body ?? null,
                owner: 'guest',
                status: null,
                worker_state: 'pending',
                concurrency_version: 0,
                sent_at: sentAt,
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== UNIQUE_ERROR_CODE) {
                throw error;
            }
        }
    } finally {
        client.release();
    }
};

const handleWhatsAppWebhook: RequestHandler = async (request) => {
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
        console.error(`Payload validation failed: ${raw}`);
        return status(200);
    }

    const messages = parsed.data.entry.flatMap((entry) =>
        entry.changes.flatMap((change) => change.value.messages ?? []),
    );
    const statuses = parsed.data.entry.flatMap((entry) =>
        entry.changes.flatMap((change) => change.value.statuses ?? []),
    );

    for (const item of statuses) {
        try {
            await syncStatus(item);
        } catch (error) {
            console.error(`[webhook] sync status failed`, error);
        }
    }

    for (const message of messages) {
        try {
            await saveIncomingMessage(message);
        } catch (error) {
            console.error(`[webhook] save message ${message.id} failed`, error);
        }
    }

    return status(200);
};

const router = IttyRouter();
router.get('/webhook', handleVerifyWebhook);
router.post('/webhook', handleWhatsAppWebhook);
router.all('*', () => status(404));

createServer(createServerAdapter(router.fetch)).listen(Number(env.PORT));
