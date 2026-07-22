import type { IRequest, RequestHandler } from 'itty-router';
import { type ChatListRow, type ChatsCursor, selectChatsList } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { PaginationCursor } from '#Dashboard/Lib/PaginationCursor.js';
import { parsePhoneQuery } from '#Dashboard/Lib/PhoneQuery.js';
import { badRequest, success } from '#Dashboard/Lib/Response.js';
import { fromDateTime, minMax, safeParseInt, safeParseString } from '#Lib/Fmt.js';

interface ChatListItem {
    phone: string;
    userName: string | null;
    lastMessageText: string | null;
    lastMessageAt: string | null;
    paused: boolean;
}

export const chatsGetListHandler: RequestHandler<IRequest> = async (request) => {
    const limit = minMax(safeParseInt(request.query.limit, 30), 1, 100);

    const rawPhone = request.query.phone;
    let phone: string | null = null;
    // пусто/массив/отсутствует → фильтр не задан; непустое значение обязано распарситься, иначе 400
    if (typeof rawPhone === 'string' && rawPhone.trim() !== '') {
        const sanitized = safeParseString(rawPhone);
        phone = sanitized !== null ? parsePhoneQuery(sanitized) : null;
        if (phone === null) {
            return badRequest();
        }
    }

    const rawCursor = safeParseString(request.query.cursor);
    let cursor: ChatsCursor | null = null;
    if (rawCursor !== null) {
        const decoded = PaginationCursor.decode(rawCursor);
        if (decoded === null) {
            return badRequest();
        }
        cursor = { last_message_at: decoded.time, wa_phone: decoded.id };
    }

    const client = await pool.connect();
    let rows: ChatListRow[];
    try {
        rows = await selectChatsList(client, cursor, limit, phone);
    } finally {
        client.release();
    }

    const items: ChatListItem[] = [];
    for (const row of rows) {
        const name = [row.first_name, row.last_name].filter(Boolean).join(' ');
        items.push({
            phone: row.wa_phone,
            userName: name.length ? name : null,
            lastMessageText: row.last_message_text,
            lastMessageAt: fromDateTime(row.last_message_at),
            paused: row.paused,
        });
    }

    const tail = rows.length === limit ? rows[rows.length - 1] : null;
    const tailAt = tail ? fromDateTime(tail.sort_at) : null;
    const nextCursor = tail && tailAt ? PaginationCursor.encode(tailAt, tail.wa_phone) : null;

    return success({ items, nextCursor });
};
