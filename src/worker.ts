import { handleChatUpdate } from './conversation.ts';
import { pool } from './db/db.ts';
import {
    claimReadyWaMessages,
    resetStuckWaMessages,
    updateWaMessagesWorkerState,
    type WaMessageStorage,
    type WaMessageWorkerState,
} from './db/wa-messages.ts';
import { sleep } from './lib/sleep.ts';

const POLL_BUSY_MS = 1_000;
const POLL_IDLE_MS = 3_000;

let running = false;

const finalize = async (ids: string[], state: WaMessageWorkerState) => {
    const client = await pool.connect();
    try {
        await updateWaMessagesWorkerState(client, ids, state);
    } finally {
        client.release();
    }
};

const run = async () => {
    const startupClient = await pool.connect();
    try {
        await resetStuckWaMessages(startupClient);
    } finally {
        startupClient.release();
    }

    while (running) {
        let rows: WaMessageStorage[];
        try {
            const client = await pool.connect();
            try {
                rows = await claimReadyWaMessages(client);
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('[worker] claim failed', error);
            await sleep(POLL_BUSY_MS);
            continue;
        }

        if (!rows.length) {
            await sleep(POLL_IDLE_MS);
            continue;
        }

        const chats = new Map<string, WaMessageStorage[]>();
        for (const row of rows) {
            const list = chats.get(row.wa_chat_phone) ?? [];
            list.push(row);
            chats.set(row.wa_chat_phone, list);
        }

        for (const [phone, messages] of chats) {
            const ids = messages.map((message) => message.id);
            const startedAt = process.hrtime();
            void handleChatUpdate(phone, messages)
                .then(() => {
                    const [seconds, nanos] = process.hrtime(startedAt);
                    console.log(
                        `[worker] chat ${phone}: ${messages.length} msg in ${seconds}s ${Math.round(nanos / 1e6)}ms`,
                    );
                    return finalize(ids, 'done');
                })
                .catch((error: unknown) => {
                    console.error(`[worker] chat ${phone} failed`, error);
                    void finalize(ids, 'failed');
                });
        }

        await sleep(POLL_BUSY_MS);
    }
};

running = true;

void run();

process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));
