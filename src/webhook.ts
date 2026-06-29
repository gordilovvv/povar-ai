import { createServer } from 'node:http';
import { createServerAdapter } from '@whatwg-node/server';
import { IttyRouter, type RequestHandler, status, text } from 'itty-router';
import { ulid } from 'ulid';
import { env } from '../environment.ts';
import { pool } from './db/db.ts';
import { insertWebhookTask } from './db/webhook-tasks.ts';
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

    // ручка только пишет в очередь, разбирает воркер
    const client = await pool.connect();
    try {
        await insertWebhookTask(client, ulid(), 'whatsapp', body);
        return status(200);
    } catch (error) {
        console.error(error);
        return status(500);
    } finally {
        client.release();
    }
};

const router = IttyRouter();
router.get('/webhook', handleVerifyWebhook);
router.post('/webhook', handleWebhook);
router.all('*', () => status(404));

createServer(createServerAdapter(router.fetch)).listen(Number(env.PORT));
