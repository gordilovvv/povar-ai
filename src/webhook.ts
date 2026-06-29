import { createServer } from 'node:http';
import { createServerAdapter } from '@whatwg-node/server';
import { IttyRouter, type RequestHandler, status, text } from 'itty-router';
import { ulid } from 'ulid';
import { env } from '../environment.ts';
import { UNIQUE_ERROR_CODE, pool } from './db/db.ts';
import { insertWaMessage, setWaMessageStatus } from './db/wa-messages.ts';
import { touchWaChat } from './db/wa-chats.ts';
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
        return status(200);
    }

    const payload = payloadSchema.safeParse(body);
    if (!payload.success) {
        return status(200);
    }

    const client = await pool.connect();
    try {
        for (const entry of payload.data.entry) {
            for (const change of entry.changes) {
                const value = change.value;

                if (value.statuses) {
                    for (const s of value.statuses) {
                        await setWaMessageStatus(client, s.id, s.status as 'sent' | 'delivered' | 'read' | 'failed');
                    }
                }

                if (value.messages) {
                    for (const msg of value.messages) {
                        try {
                            await insertWaMessage(client, {
                                id: ulid(),
                                wa_message_id: msg.id,
                                wa_chat_phone: msg.from,
                                text: msg.text?.body ?? null,
                                owner: 'guest',
                                status: 'received',
                                concurrency_version: 0,
                                sent_at: new Date(),
                            });
                            await touchWaChat(client, msg.from);
                        } catch (e) {
                            if ((e as { code: string }).code === UNIQUE_ERROR_CODE) {
                                continue;
                            }
                            throw e;
                        }
                    }
                }
            }
        }
    } finally {
        client.release();
    }

    return status(200);
};

const router = IttyRouter();
router.get('/webhook', handleVerifyWebhook);
router.post('/webhook', handleWebhook);
router.all('*', () => status(404));

createServer(createServerAdapter(router.fetch)).listen(Number(env.PORT));
