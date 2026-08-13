import type { IRequest, RequestHandler } from 'itty-router';
import { selectMediaIdExists } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, notFound } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';
import { downloadWhatsappMedia } from '#Platforms/Whatsapp/index.js';

export const mediaGetHandler: RequestHandler<IRequest> = async (request) => {
    const mediaId = safeParseString(request.params.id);
    if (mediaId === null) {
        return badRequest();
    }

    // Чужой media_id отсекаем до похода в WA: иначе ручка проксирует любое медиа нашего WABA.
    const client = await pool.connect();
    let exists: boolean;
    try {
        exists = await selectMediaIdExists(client, mediaId);
    } finally {
        client.release();
    }
    if (!exists) {
        return notFound();
    }

    // @TODO s3
    const media = await downloadWhatsappMedia(mediaId);
    if (!media) {
        return notFound();
    }

    return new Response(media.bytes, {
        headers: { 'content-type': media.mimeType, 'cache-control': 'no-store' },
    });
};
