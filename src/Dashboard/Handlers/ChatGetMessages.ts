import type { IRequest, RequestHandler } from 'itty-router';
import { type ChatMessageRow, selectChatMessages } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, success } from '#Dashboard/Lib/Response.js';
import { fromDateTime, minMax, safeParseInt, safeParseString } from '#Lib/Fmt.js';

interface ChatMessageItem {
    id: string;
    text: string | null;
    owner: 'user' | 'bot';
    status: string | null;
    sentAt: string | null;
}

export const chatGetMessagesHandler: RequestHandler<IRequest> = async (request) => {
    const phone = safeParseString(request.params.phone);
    if (phone === null) {
        return badRequest();
    }
    const limit = minMax(safeParseInt(request.query.limit, 30), 1, 100);
    const cursor = safeParseString(request.query.cursor);

    const client = await pool.connect();
    let rows: ChatMessageRow[];
    try {
        rows = await selectChatMessages(client, phone, cursor, limit);
    } finally {
        client.release();
    }

    const items: ChatMessageItem[] = [];
    for (const row of rows) {
        items.push({
            id: row.id,
            text: row.text,
            owner: row.owner === 'sema' ? 'bot' : 'user',
            status: row.status,
            sentAt: fromDateTime(row.sent_at),
        });
    }

    const tail = rows.length === limit ? rows[rows.length - 1] : null;
    const nextCursor = tail ? tail.id : null;

    return success({ items, nextCursor });
};
