import type { PoolClient } from 'pg';
import { ulid } from 'ulid';
import { UNIQUE_ERROR_CODE } from '#Db/Pool.js';
import { selectWaChat, updateWaChatLastSent } from '#Db/WaChats.js';
import { insertWaMessage } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { Logger } from '#Lib/Logger.js';
import { GuestConfirm } from '#Marketing/GuestConfirm.js';
import { Invite } from '#Marketing/Invite.js';
import { sendWhatsappText } from '#Platforms/Whatsapp/index.js';
import type { WaMessage } from '#Platforms/Whatsapp/Parse.js';

/** Ветки вне агента: кнопки шаблонов (Info, перекличка Yes/No) и отписка. Обработанное сюда сообщение агенту не достаётся. */
export class Marketing {
    static async handleMessage(
        client: PoolClient,
        message: WaMessage,
        now: Date,
    ): Promise<boolean> {
        if (message.button) {
            const guestConfirm = GuestConfirm.parsePayload(message.button.payload);
            if (guestConfirm) {
                const reply = await GuestConfirm.answer(client, message.from, guestConfirm);
                await Marketing.replyOutsideAgent(client, message, message.button.text, reply, now);
                return true;
            }
            return Invite.sendOnButton(client, message.button.payload, message.from);
        }

        // STOP - unsubscribe
        const text = message.text?.body.trim();
        if (text && Invite.STOP.test(text)) {
            if (!(await selectWaChat(client, message.from))) {
                return false;
            }
            const reply = await Invite.unsubscribe(client, message.from);
            await Marketing.replyOutsideAgent(
                client,
                message,
                message.text?.body ?? null,
                reply,
                now,
            );
            return true;
        }

        return false;
    }

    private static async replyOutsideAgent(
        client: PoolClient,
        message: WaMessage,
        incomingText: string | null,
        reply: string | null,
        now: Date,
    ): Promise<void> {
        try {
            // worker_status skipped напрямую: через insertIncomingWaMessage сообщение ляжет как need_processed и агент ответит вторым сообщением
            await insertWaMessage(client, {
                id: ulid(),
                wa_message_id: message.id,
                wa_chat_phone: message.from,
                text: incomingText,
                owner: 'guest',
                status: 'delivered',
                worker_status: 'skipped',
                concurrency_version: 0,
                sent_at: now,
            });
        } catch (error) {
            if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
                throw error;
            }
        }

        if (!reply) {
            return;
        }
        if (env.WA_SEND !== 'on') {
            Logger.log(`[marketing:off] ${message.from} reply: ${reply}`);
            return;
        }

        const waMessageId = await sendWhatsappText(message.from, reply);
        await insertWaMessage(client, {
            id: ulid(),
            wa_message_id: waMessageId,
            wa_chat_phone: message.from,
            text: reply,
            owner: 'marketing',
            status: 'sent',
            worker_status: 'skipped',
            concurrency_version: 0,
            sent_at: now,
        });
        await updateWaChatLastSent(client, message.from, now);
    }
}
