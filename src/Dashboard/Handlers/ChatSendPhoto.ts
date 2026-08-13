import type { IRequest, RequestHandler } from 'itty-router';
import { ulid } from 'ulid';
import { insertOutgoingMessage, selectChat, updateChatLastSent } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, notFound, success } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';
import { sendWhatsappPhoto } from '#Platforms/Whatsapp/index.js';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION_LENGTH = 1024;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const chatSendPhotoHandler: RequestHandler<IRequest> = async (request) => {
    const phone = safeParseString(request.params.phone);
    if (phone === null) {
        return badRequest();
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return badRequest();
    }

    const photo = form.get('photo');
    if (!(photo instanceof File) || photo.size === 0 || photo.size > MAX_PHOTO_BYTES) {
        return badRequest();
    }
    if (!ALLOWED_MIME_TYPES.includes(photo.type)) {
        return badRequest();
    }

    const caption = form.get('caption');
    if (
        caption !== null &&
        (typeof caption !== 'string' ||
            !caption.length ||
            caption.length > MAX_CAPTION_LENGTH ||
            // postgres не хранит \u0000 вовсе: без этой проверки вставка падала бы уже ПОСЛЕ доставки фото гостю
            caption.includes('\u0000'))
    ) {
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

    const { waMessageId, mediaId } = await sendWhatsappPhoto(phone, photo, caption ?? undefined);

    const now = new Date();
    const writeClient = await pool.connect();
    try {
        await insertOutgoingMessage(writeClient, {
            id: ulid(),
            waMessageId,
            phone,
            text: caption,
            sentAt: now,
            mediaType: 'image',
            mediaId,
        });
        await updateChatLastSent(writeClient, phone, now);
    } finally {
        writeClient.release();
    }
    console.log(`[dashboard:send_photo] ${phone} sent: media_id=${mediaId}`);

    return success({ mediaId });
};
