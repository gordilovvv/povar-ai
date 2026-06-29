import { ulid } from 'ulid';
import { pool } from './db/db.ts';
import {
    claimChatMessages,
    selectWaChatMessages,
    updateMessagesStatus,
    type WaMessageStorage,
} from './db/wa-messages.ts';
import { setWorkerState } from './db/wa-chats.ts';
import { insertGuest, selectGuestByPhone } from './db/guests.ts';
import { selectActiveParties } from './db/party.ts';
import { selectGuestlistByGuest } from './db/guestlist.ts';
import { agent } from './intelligence/agent.ts';
import { sleep } from './lib/sleep.ts';
import { getDubaiTime } from './lib/time.ts';

const MAX_CONCURRENT_CHATS = 8;
const CONTEXT_MESSAGE_LIMIT = 50;

let running = false;

const processChat = async (phone: string) => {
    const startedAt = process.hrtime();

    const ctxClient = await pool.connect();
    let guest;
    let parties;
    let guestlist;
    let messages: WaMessageStorage[];
    try {
        guest = await selectGuestByPhone(ctxClient, phone);
        if (!guest) {
            await insertGuest(ctxClient, {
                id: ulid(),
                wa_phone: phone,
                first_name: null,
                last_name: null,
                instagram_url: null,
                came_from: null,
                came_at: null,
            });
            guest = await selectGuestByPhone(ctxClient, phone);
        }
        parties = await selectActiveParties(ctxClient);
        guestlist = await selectGuestlistByGuest(ctxClient, guest!.id);
        const history = await selectWaChatMessages(ctxClient, phone, null, CONTEXT_MESSAGE_LIMIT);
        messages = history.reverse();
    } finally {
        ctxClient.release();
    }

    if (!guest) {
        await resetWorkerState(phone);
        return;
    }

    const receivedIds = messages.filter((m) => m.status === 'received').map((m) => m.id);

    try {
        await agent.do({
            guest,
            messages,
            parties,
            ownedGustlist: guestlist,
            now: getDubaiTime(),
        });

        const finClient = await pool.connect();
        try {
            if (receivedIds.length) {
                await updateMessagesStatus(finClient, receivedIds, 'processed');
            }
            await setWorkerState(finClient, phone, null);
        } finally {
            finClient.release();
        }
    } catch (e) {
        console.error(`[worker] agent failed for ${phone}`, e);

        const failClient = await pool.connect();
        try {
            await updateMessagesStatus(failClient, messages.map((m) => m.id), 'received');
            await setWorkerState(failClient, phone, null);
        } finally {
            failClient.release();
        }
    }

    const [seconds, nanos] = process.hrtime(startedAt);
    console.log(
        `[worker] chat ${phone}: ${messages.length} msg in ${seconds}s ${Math.round(nanos / 1e6)}ms`,
    );
};

const resetWorkerState = async (phone: string) => {
    const client = await pool.connect();
    try {
        await setWorkerState(client, phone, null);
    } finally {
        client.release();
    }
};

const run = async () => {
    while (running) {
        try {
            const client = await pool.connect();
            let rows: WaMessageStorage[];
            try {
                rows = await claimChatMessages(client, MAX_CONCURRENT_CHATS);
            } finally {
                client.release();
            }

            const phones = new Set(rows.map((r) => r.wa_chat_phone));
            for (const phone of phones) {
                processChat(phone).catch((e) =>
                    console.error(`[worker] unhandled error for ${phone}`, e),
                );
            }
        } catch (e) {
            console.error('[worker] loop error', e);
        } finally {
            await sleep(1000);
        }
    }
};

running = true;

void run();

process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));
