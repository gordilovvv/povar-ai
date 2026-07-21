import type { IRequest, RequestHandler } from 'itty-router';
import { selectChat } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, notFound, success } from '#Dashboard/Lib/Response.js';
import { fromDateTime, safeParseString } from '#Lib/Fmt.js';

export const chatGetHandler: RequestHandler<IRequest> = async (request) => {
    const phone = safeParseString(request.params.phone);
    if (phone === null) {
        return badRequest();
    }

    const client = await pool.connect();
    let row: Awaited<ReturnType<typeof selectChat>>;
    try {
        row = await selectChat(client, phone);
    } finally {
        client.release();
    }
    if (!row) {
        return notFound();
    }

    const name = [row.first_name, row.last_name].filter(Boolean).join(' ');

    return success({
        phone: row.wa_phone,
        userName: name.length ? name : null,
        lastMessageAt: fromDateTime(row.last_message_at),
        lastUserMessageAt: fromDateTime(row.last_user_message_at),
        lastBotMessageAt: fromDateTime(row.last_bot_message_at),
    });
};
