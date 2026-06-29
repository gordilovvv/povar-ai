import { handleChatUpdate, handleMessageStatusUpdate } from './conversation.ts';
import { pool } from './db/db.ts';
import {
    deleteWebhookTasks,
    incrementWebhookTasksRetry,
    selectPendingWebhookTasks,
    type WebhookTaskStorage,
} from './db/webhook-tasks.ts';
import { sleep } from './lib/sleep.ts';
import { payloadSchema, type WaMessage, type WaStatus } from './platforms/whatsapp/parse.ts';

const POLL_INTERVAL_MS = 3_000;

let running = false;

// TODO неверный он остановится для всех остальный сообщений и людей (цикл поправить)
// TODO: Для надёжного «человеческого» поведения нужно осознанное окно: например, у чата держать last_message_at, и обрабатывать чат только если прошло N секунд тишины.
const run = async () => {
    while (running) {
        try {
            const client = await pool.connect();
            let tasks: WebhookTaskStorage[];
            try {
                tasks = await selectPendingWebhookTasks(client, 10);
            } finally {
                client.release();
            }

            if (!tasks.length) {
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            // склейка: сообщения нескольких вебхуков одного номера → один чат
            const chats = new Map<string, { messages: WaMessage[]; taskIds: Set<string> }>();
            const statuses: WaStatus[] = [];
            const statusTaskIds = new Set<string>();
            const failed = new Set<string>();
            for (const task of tasks) {
                let payload: ReturnType<typeof payloadSchema.parse>;
                try {
                    payload = payloadSchema.parse(task.data);
                } catch (error) {
                    console.error(`parse failed for task ${task.id}`, error);
                    failed.add(task.id);
                    continue;
                }

                const messages = payload.entry.flatMap((entry) =>
                    entry.changes.flatMap((change) => change.value.messages ?? []),
                );
                for (const message of messages) {
                    const chat = chats.get(message.from) ?? {
                        messages: [],
                        taskIds: new Set(),
                    };
                    chat.messages.push(message);
                    chat.taskIds.add(task.id);
                    chats.set(message.from, chat);
                }

                const taskStatuses = payload.entry.flatMap((entry) =>
                    entry.changes.flatMap((change) => change.value.statuses ?? []),
                );
                if (taskStatuses.length) {
                    statuses.push(...taskStatuses);
                    statusTaskIds.add(task.id);
                }
            }

            // TODO instagrm
            for (const [phone, chat] of chats) {
                try {
                    const startedAt = process.hrtime();
                    await handleChatUpdate(phone, chat.messages);
                    const [seconds, nanos] = process.hrtime(startedAt);
                    console.log(
                        `[worker] chat ${phone}: ${chat.messages.length} msg, ${chat.taskIds.size} tasks in ${seconds}s ${Math.round(nanos / 1e6)}ms`,
                    );
                } catch (error) {
                    console.error(`handleChat failed for ${phone}`, error);
                    for (const id of chat.taskIds) {
                        failed.add(id);
                    }
                }
            }

            if (statuses.length) {
                try {
                    const startedAt = process.hrtime();
                    await handleMessageStatusUpdate(statuses);
                    const [seconds, nanos] = process.hrtime(startedAt);
                    console.log(
                        `[worker] statuses: ${statuses.length} upd, ${statusTaskIds.size} tasks in ${seconds}s ${Math.round(nanos / 1e6)}ms`,
                    );
                } catch (error) {
                    console.error('handleStatus failed', error);
                    for (const id of statusTaskIds) {
                        failed.add(id);
                    }
                }
            }

            const failedIds: string[] = [];
            const successIds: string[] = [];
            for (const task of tasks) {
                if (failed.has(task.id)) {
                    failedIds.push(task.id);
                } else {
                    successIds.push(task.id);
                }
            }

            const finalizeClient = await pool.connect();
            try {
                if (failedIds.length) {
                    await incrementWebhookTasksRetry(finalizeClient, failedIds);
                }
                if (successIds.length) {
                    await deleteWebhookTasks(finalizeClient, successIds);
                }
            } finally {
                finalizeClient.release();
            }
        } catch (error) {
            console.error('worker loop failed', error);
            await sleep(POLL_INTERVAL_MS);
        }
    }
};

running = true;

void run();

process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));
