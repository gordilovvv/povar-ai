import type { IRequest, RequestHandler } from 'itty-router';
import { updateChatsPauseOff } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { success } from '#Dashboard/Lib/Response.js';

export const chatsPostPauseOffHandler: RequestHandler<IRequest> = async () => {
    const client = await pool.connect();
    let affectedCount: number;
    try {
        affectedCount = await updateChatsPauseOff(client);
    } finally {
        client.release();
    }

    console.log(`[dashboard:pause_off] affected=${affectedCount}`);

    return success({ affectedCount });
};
