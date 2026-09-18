import type { PoolClient } from 'pg';
import { ulid } from 'ulid';
import { updateGuestMarketingEnableOff } from '#Db/Guests.js';
import {
    marketingMessageSchema,
    type PartyWithTimeStorage,
    selectActivePartiesWithTimes,
} from '#Db/Party.js';
import { pool, UNIQUE_ERROR_CODE } from '#Db/Pool.js';
import { selectWaChat, updateWaChatLastSent } from '#Db/WaChats.js';
import { insertWaMarketingSend, selectWaMarketingSend } from '#Db/WaMarketingSends.js';
import { insertWaMessage } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { Logger } from '#Lib/Logger.js';
import { downloadFromS3 } from '#Lib/S3.js';
import {
    sendWhatsappMediaByMediaId,
    sendWhatsappText,
    uploadWhatsappMedia,
} from '#Platforms/Whatsapp/index.js';
import type { WaMessage } from '#Platforms/Whatsapp/Parse.js';

/** Ветки рассылки: нажатие кнопки шаблона и отписка. Обработанное сюда сообщение агенту не достаётся. */
export class Marketing {
    private static readonly STOP = /^stop$/i;
    private static readonly STOP_REPLY = "You're unsubscribed 😅";
    private static readonly MEDIA_TTL_MS = 25 * 24 * 60 * 60 * 1000;
    private static readonly mediaIds = new Map<string, { mediaId: string; uploadedAtMs: number }>();

    static async handleMessage(
        client: PoolClient,
        message: WaMessage,
        now: Date,
    ): Promise<boolean> {
        if (message.button) {
            const payload = message.button.payload;
            const party = (await selectActivePartiesWithTimes(client)).find(
                (row) => row.id === payload,
            );
            if (!party) {
                return false;
            }

            void Marketing.sendMarketingMessage(party, message.from);
            return true;
        }

        const text = message.text?.body.trim();
        if (text && Marketing.STOP.test(text)) {
            return Marketing.unsubscribeFromMarketing(client, message, now);
        }

        return false;
    }

    // @TODO сделать так, чтобы рассылку без сообщения запустить было нельзя
    private static async sendMarketingMessage(
        party: PartyWithTimeStorage,
        phone: string,
    ): Promise<void> {
        const partyId = party.id;
        const parsed = marketingMessageSchema.safeParse(party.marketing_message);
        if (!parsed.success) {
            Logger.logError(
                `[marketing] ${phone} party ${partyId} has no valid marketing_message`,
                parsed.error,
                parsed.data,
            );
            return;
        }
        const marketing = parsed.data;
        const media =
            'video' in marketing
                ? { type: 'video' as const, reference: marketing.video }
                : { type: 'image' as const, reference: marketing.image };

        const readClient = await pool.connect();
        try {
            if (await selectWaMarketingSend(readClient, partyId, phone)) {
                Logger.log(`[marketing] ${phone} marketing message for ${partyId} already sent`);
                return;
            }
        } finally {
            readClient.release();
        }

        if (env.WA_SEND !== 'on') {
            Logger.log(`[marketing:off] ${phone} message ${partyId}: ${marketing.message}`);
            return;
        }

        const { waMessageId, mediaId } = await Marketing.sendMedia(phone, media, marketing.message);

        const sentAt = new Date();
        const client = await pool.connect();
        try {
            await client.query('begin');
            await insertWaMessage(client, {
                id: ulid(),
                wa_message_id: waMessageId,
                wa_chat_phone: phone,
                text: marketing.message,
                owner: 'marketing',
                status: 'sent',
                worker_status: 'skipped',
                concurrency_version: 0,
                sent_at: sentAt,
                media_type: media.type,
                media_id: mediaId,
            });
            await updateWaChatLastSent(client, phone, sentAt);
            await client.query('savepoint send');
            try {
                await insertWaMarketingSend(client, partyId, phone, sentAt);
            } catch (error) {
                // одновременное нажатие уже записало отправку: фото ушло дважды, ронять процесс не за что
                if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
                    throw error;
                }
                await client.query('rollback to savepoint send');
            }
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
        Logger.log(`[marketing] ${phone} message ${partyId} sent: media_id=${mediaId}`);
    }

    private static async sendMedia(
        phone: string,
        media: { type: 'image' | 'video'; reference: string },
        caption: string,
    ) {
        const cached = Marketing.mediaIds.get(media.reference);
        const fresh = !!cached && Date.now() - cached.uploadedAtMs < Marketing.MEDIA_TTL_MS;
        if (cached && fresh) {
            try {
                return {
                    waMessageId: await sendWhatsappMediaByMediaId(
                        phone,
                        media.type,
                        cached.mediaId,
                        caption,
                    ),
                    mediaId: cached.mediaId,
                };
            } catch (error) {
                Marketing.mediaIds.delete(media.reference);
                Logger.logWarn(
                    `[marketing] media_id ${cached.mediaId} rejected, re-uploading`,
                    error,
                );
            }
        }

        const file = await downloadFromS3(media.reference);
        const mediaId = await uploadWhatsappMedia(file);
        Marketing.mediaIds.set(media.reference, { mediaId, uploadedAtMs: Date.now() });
        return {
            waMessageId: await sendWhatsappMediaByMediaId(phone, media.type, mediaId, caption),
            mediaId,
        };
    }

    private static async unsubscribeFromMarketing(
        client: PoolClient,
        message: WaMessage,
        now: Date,
    ): Promise<boolean> {
        const chat = await selectWaChat(client, message.from);
        if (!chat) {
            return false;
        }

        const revoked = await updateGuestMarketingEnableOff(client, message.from);

        try {
            // worker_status skipped напрямую: через insertIncomingWaMessage STOP ляжет как need_processed и агент ответит вторым сообщением
            await insertWaMessage(client, {
                id: ulid(),
                wa_message_id: message.id,
                wa_chat_phone: message.from,
                text: message.text?.body ?? null,
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

        if (!revoked) {
            Logger.log(`[marketing] ${message.from} STOP repeated, consent already revoked`);
            return true;
        }

        if (env.WA_SEND !== 'on') {
            Logger.log(`[marketing:off] ${message.from} stop reply: ${Marketing.STOP_REPLY}`);
            return true;
        }

        const waMessageId = await sendWhatsappText(message.from, Marketing.STOP_REPLY);
        await insertWaMessage(client, {
            id: ulid(),
            wa_message_id: waMessageId,
            wa_chat_phone: message.from,
            text: Marketing.STOP_REPLY,
            owner: 'marketing',
            status: 'sent',
            worker_status: 'skipped',
            concurrency_version: 0,
            sent_at: now,
        });
        await updateWaChatLastSent(client, message.from, now);
        Logger.log(`[marketing] ${message.from} unsubscribed by STOP`);
        return true;
    }
}
