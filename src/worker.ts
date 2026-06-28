import { handleChat } from './conversation.ts';
import { pool } from './db/db.ts';
import {
    deleteWebhookTasks,
    incrementWebhookTasksRetry,
    selectPendingWebhookTasks,
    type WebhookTaskStorage,
} from './db/webhook-tasks.ts';
import { sleep } from './lib/sleep.ts';
import { payloadSchema, type WaMessage } from './platforms/whatsapp/parse.ts';

const POLL_INTERVAL_MS = 3000;
const BATCH_LIMIT = 100;

let running = false;

const run = async () => {
    while (running) {
        try {
            const client = await pool.connect();
            let tasks: WebhookTaskStorage[];
            try {
                tasks = await selectPendingWebhookTasks(client, BATCH_LIMIT);
            } finally {
                client.release();
            }

            if (tasks.length) {
                // склейка: сообщения нескольких вебхуков одного номера → один чат
                const chats = new Map<string, { messages: WaMessage[]; taskIds: Set<string> }>();
                const failed = new Set<string>();
                for (const task of tasks) {
                    let messages: WaMessage[];
                    try {
                        messages = payloadSchema
                            .parse(task.data)
                            .entry.flatMap((entry) =>
                                entry.changes.flatMap((change) => change.value.messages ?? []),
                            );
                    } catch (error) {
                        console.error(`parse failed for task ${task.id}`, error);
                        failed.add(task.id);
                        continue;
                    }
                    for (const message of messages) {
                        const chat = chats.get(message.from) ?? {
                            messages: [],
                            taskIds: new Set(),
                        };
                        chat.messages.push(message);
                        chat.taskIds.add(task.id);
                        chats.set(message.from, chat);
                    }
                }

                for (const [phone, chat] of chats) {
                    try {
                        await handleChat(phone, chat.messages);
                    } catch (error) {
                        console.error(`handleChat failed for ${phone}`, error);
                        for (const id of chat.taskIds) {
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
                    if (failedIds.length)
                        await incrementWebhookTasksRetry(finalizeClient, failedIds);
                    if (successIds.length) await deleteWebhookTasks(finalizeClient, successIds);
                } finally {
                    finalizeClient.release();
                }
            }
        } catch (error) {
            console.error('worker loop failed', error);
        }
        await sleep(POLL_INTERVAL_MS);
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
