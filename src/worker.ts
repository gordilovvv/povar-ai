import { pool } from './db/db.ts';
import { selectGuestlistByGuest } from './db/guestlist.ts';
import { selectGuestByPhone } from './db/guests.ts';
import { selectActiveParties } from './db/party.ts';
import {
    selectWaChatMessages,
    updateWaMessagesToProcessing,
    updateWaMessagesWorkerStatus,
    type WaMessageStorage,
} from './db/wa-messages.ts';
import { agent, type ChatContext } from './intelligence/agent.ts';
import { toDateTime } from './lib/fmt.ts';
import { sleep } from './lib/sleep.ts';
import { getDubaiTime } from './lib/time.ts';

const CHATS_LIMIT = 3;
const MESSAGES_HISTORY_LIMIT = 15;
const POLL_INTERVAL_MS = 1_000;
const BEFORE_REPLY_WINDOW_MS = 5_000;

let running = false;

const run = async () => {
    while (running) {
        try {
            const beforeReplyAt = toDateTime(Date.now() - BEFORE_REPLY_WINDOW_MS);
            const client = await pool.connect();
            let claimed: WaMessageStorage[];
            try {
                claimed = await updateWaMessagesToProcessing(client, beforeReplyAt, CHATS_LIMIT);
            } finally {
                client.release();
            }

            if (claimed.length) {
                const chats = new Map<string, string[]>();
                for (const message of claimed) {
                    const ids = chats.get(message.wa_chat_phone) ?? [];
                    ids.push(message.id);
                    chats.set(message.wa_chat_phone, ids);
                }

                await Promise.all([...chats].map(([phone, ids]) => handleChat(phone, ids)));
            }
        } catch (error) {
            console.error('worker loop failed', error);
        }
        await sleep(POLL_INTERVAL_MS);
    }
};

const handleChat = async (phone: string, messageIds: string[]) => {
    let workerStatus: 'processed' | 'failed' = 'processed';

    try {
        const startedAt = process.hrtime();
        const context = await buildChatContext(phone);

        const [seconds, nanos] = process.hrtime(startedAt);
        console.log(
            `[worker] chat ${phone} context collected in ${seconds}s ${Math.round(nanos / 1e6)}ms`,
        );

        await agent.do(context);
    } catch (error) {
        console.error(`[worker] chat ${phone} failed`, error);
        workerStatus = 'failed';
    }

    const client = await pool.connect();
    try {
        await updateWaMessagesWorkerStatus(client, messageIds, workerStatus);
        console.log(`[worker] chat ${phone}: ${messageIds.length} msg → ${workerStatus}`);
    } finally {
        client.release();
    }
};

const buildChatContext = async (phone: string): Promise<ChatContext> => {
    const client = await pool.connect();
    try {
        const guest = await selectGuestByPhone(client, phone);
        if (!guest) {
            throw new Error(`Unknown guest ${phone}`);
        }
        const parties = await selectActiveParties(client);
        const messages = (
            await selectWaChatMessages(client, phone, null, MESSAGES_HISTORY_LIMIT)
        ).reverse(); // последние N, разворот в хронологию
        const ownedGuestlist = await selectGuestlistByGuest(client, guest.id);
        const now = getDubaiTime().format('YYYY-MM-DD HH:mm:ss');
        return { guest, parties, messages, ownedGuestlist, now };
    } finally {
        client.release();
    }
};

running = true;
void run();

process.on('SIGTERM', () => {
    running = false;
});
process.on('SIGINT', () => {
    running = false;
});
