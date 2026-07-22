import { selectGuestlistByGuest } from '#Db/Guestlist.js';
import { selectGuestByPhone, updateGuestLang } from '#Db/Guests.js';
import { pool } from '#Db/Pool.js';
import {
    selectWaChatMessages,
    updateProcessingToFailed,
    updateWaMessagesToProcessing,
    updateWaMessagesWorkerStatus,
    type WaMessageStorage,
} from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { Agent, type ChatContext } from '#Intelligence/Agent.js';
import { startGuestlistJob } from '#Jobs/Guestlist.js';
import { toDateTime } from '#Lib/Fmt.js';
import { parseLanguage } from '#Lib/Lang.js';
import { sleep } from '#Lib/Sleep.js';
import { formatDubaiNow } from '#Lib/Time.js';
import { sendTypingIndicator } from '#Platforms/Whatsapp/index.js';

const CHATS_LIMIT = 3;
const MESSAGES_HISTORY_LIMIT = 40;
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

        if (env.WA_SEND === 'on') {
            const waId = context.messages.findLast((m) => m.owner === 'guest')?.wa_message_id;
            if (waId) void sendTypingIndicator(waId).catch(() => {});
        }

        const [seconds, nanos] = process.hrtime(startedAt);
        console.log(
            `[worker] chat ${phone} context collected in ${seconds}s ${Math.round(nanos / 1e6)}ms`,
        );

        await Agent.do(context);
    } catch (error) {
        console.error(`[worker] chat ${phone} failed`, error);
        workerStatus = 'failed';
    }

    await cleanChatMessagesStatus(phone, messageIds, workerStatus);
};

const buildChatContext = async (phone: string): Promise<ChatContext> => {
    const client = await pool.connect();
    try {
        const guest = await selectGuestByPhone(client, phone);
        if (!guest) {
            throw new Error(`Unknown guest ${phone}`);
        }
        const messages = (
            await selectWaChatMessages(client, phone, null, MESSAGES_HISTORY_LIMIT)
        ).reverse(); // последние N, разворот в хронологию

        // Язык пользователья
        if (!guest.lang) {
            const guestTexts: string[] = [];
            for (const message of messages) {
                if (message.owner === 'guest' && message.text) {
                    guestTexts.push(message.text);
                }
            }
            const lang = parseLanguage(guestTexts);
            if (lang) {
                await updateGuestLang(client, guest.id, lang);
                guest.lang = lang;
            }
        }

        const ownedGuestlist = await selectGuestlistByGuest(client, guest.id);
        const now = formatDubaiNow();
        return { guest, messages, ownedGuestlist, now };
    } finally {
        client.release();
    }
};

const CLEAN_STATUS_RETRIES = 30;
const CLEAN_STATUS_RETRY_BASE_MS = 100;
const CLEAN_STATUS_RETRY_MAX_MS = 10_000;

// Дочищает статусы сообщений
const cleanChatMessagesStatus = async (
    phone: string,
    messageIds: string[],
    workerStatus: 'processed' | 'failed',
    attempt = 1,
    timeout = CLEAN_STATUS_RETRY_BASE_MS,
): Promise<void> => {
    try {
        const client = await pool.connect();
        try {
            await updateWaMessagesWorkerStatus(client, messageIds, workerStatus);
        } finally {
            client.release();
        }
        console.log(`[worker] chat ${phone}: ${messageIds.length} msg → ${workerStatus}`);
    } catch (error) {
        if (attempt >= CLEAN_STATUS_RETRIES) {
            console.error(
                `[worker] chat ${phone} clean status exhausted, left in processing`,
                error,
            );
            return;
        }
        console.error(`[worker] chat ${phone} clean status attempt ${attempt} failed`, error);
        await sleep(timeout);
        const nextTimeout = Math.min(timeout * 2, CLEAN_STATUS_RETRY_MAX_MS);
        return cleanChatMessagesStatus(phone, messageIds, workerStatus, attempt + 1, nextTimeout);
    }
};

// При внезапном выключении, убираем зависшие сообщения
const client = await pool.connect();
try {
    await updateProcessingToFailed(client);
} finally {
    client.release();
}

running = true;
void run();
startGuestlistJob();

process.on('SIGTERM', () => {
    running = false;
});
process.on('SIGINT', () => {
    running = false;
});
