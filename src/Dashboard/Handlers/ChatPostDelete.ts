import type { IRequest, RequestHandler } from 'itty-router';
import { DatabaseError } from 'pg';
import { deleteChat } from '#Dashboard/Db/Chats.js';
import { FOREIGN_KEY_ERROR_CODE, pool } from '#Dashboard/Db/Pool.js';
import { badRequest, conflict, notFound, success } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';

export const chatPostDeleteHandler: RequestHandler<IRequest> = async (request) => {
    const phone = safeParseString(request.params.phone);
    if (phone === null) {
        return badRequest();
    }

    const client = await pool.connect();
    try {
        const deleted = await deleteChat(client, phone);
        if (!deleted) {
            return notFound();
        }
    } catch (error) {
        // FK от wa_messages: у чата остались сообщения в работе у воркера (или прилетело новое) — statement откатился целиком
        if (error instanceof DatabaseError && error.code === FOREIGN_KEY_ERROR_CODE) {
            return conflict();
        }
        throw error;
    } finally {
        client.release();
    }

    console.log(`[dashboard:chat_delete] ${phone}`);

    return success({ phone });
};
