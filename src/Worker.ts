import { pool } from '#Db/Pool.js';
import {
    updateProcessingToFailed,
    updateWaMessagesToProcessing,
    updateWaMessagesWorkerStatus,
    type WaMessageStorage,
} from '#Db/WaMessages.js';
import { Agent } from '#Intelligence/Agent.js';
import { toDateTime } from '#Lib/Fmt.js';
import { Logger } from '#Lib/Logger.js';
import { sleep } from '#Lib/Sleep.js';

const CHATS_LIMIT = 3;
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
            Logger.logError('worker loop failed', error);
        }
        await sleep(POLL_INTERVAL_MS);
    }
};

const handleChat = async (phone: string, messageIds: string[]) => {
    let workerStatus: 'processed' | 'failed' = 'processed';

    try {
        await new Agent(phone).do();
    } catch (error) {
        Logger.logError(`[worker] chat ${phone} failed`, error);
        workerStatus = 'failed';
    }

    await cleanChatMessagesStatus(phone, messageIds, workerStatus);
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
        Logger.log(`[worker] chat ${phone}: ${messageIds.length} msg → ${workerStatus}`);
    } catch (error) {
        if (attempt >= CLEAN_STATUS_RETRIES) {
            Logger.logError(
                `[worker] chat ${phone} clean status exhausted, left in processing`,
                error,
            );
            return;
        }
        Logger.logError(`[worker] chat ${phone} clean status attempt ${attempt} failed`, error);
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

process.on('SIGTERM', () => {
    running = false;
});
process.on('SIGINT', () => {
    running = false;
});
