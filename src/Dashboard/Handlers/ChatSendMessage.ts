import type { IRequest, RequestHandler } from 'itty-router';
import { ulid } from 'ulid';
import { z } from 'zod';
import { insertOutgoingMessage, selectChat, updateChatLastSent } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, notFound, success } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';
import { sendWhatsappText } from '#Platforms/Whatsapp/index.js';

const bodySchema = z.object({ texts: z.array(z.string().min(1)).min(1) });

export const chatSendMessageHandler: RequestHandler<IRequest> = async (request) => {
    const phone = safeParseString(request.params.phone);
    if (phone === null) {
        return badRequest();
    }
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return badRequest();
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        return badRequest();
    }

    const client = await pool.connect();
    let chat: Awaited<ReturnType<typeof selectChat>>;
    try {
        chat = await selectChat(client, phone);
    } finally {
        client.release();
    }
    if (!chat) {
        return notFound();
    }

    // Пишем каждый баббл сразу после его доставки: если следующий упадёт, уже
    // отправленное гостю останется в истории, а не потеряется.
    let sent = 0;
    for (const text of parsed.data.texts) {
        const waMessageId = await sendWhatsappText(phone, text);
        const now = new Date();
        const writeClient = await pool.connect();
        try {
            await insertOutgoingMessage(writeClient, {
                id: ulid(),
                waMessageId,
                phone,
                text,
                sentAt: now,
            });
            await updateChatLastSent(writeClient, phone, now);
        } finally {
            writeClient.release();
        }
        sent++;
        console.log(`[dashboard:send_message] ${phone} sent: ${text}`);
    }

    return success({ sent });
};
