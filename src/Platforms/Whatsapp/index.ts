import { z } from 'zod';
import { env } from '#environment.js';

const WA_API_VERSION = 'v21.0';

const sendResponseSchema = z.looseObject({
    messages: z.array(z.looseObject({ id: z.string() })).min(1),
});

const postWhatsappMessage = async (payload: object): Promise<string> => {
    const response = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${env.WA_PHONE_ID}/messages`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${env.WA_TOKEN}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                ...payload,
            }),
        },
    );

    if (!response.ok) {
        throw new Error(`WhatsApp send failed: ${response.status} ${await response.text()}`);
    }

    const parsed = sendResponseSchema.safeParse(await response.json());
    const id = parsed.success ? parsed.data.messages[0]?.id : undefined;
    if (!id) {
        throw new Error('WhatsApp send: unexpected response shape');
    }
    return id;
};

export const sendWhatsappText = async (to: string, body: string) =>
    postWhatsappMessage({ to, type: 'text', text: { preview_url: false, body } });

export const sendWhatsappPhoto = async (
    to: string,
    photo: Blob,
    caption?: string,
): Promise<{ waMessageId: string; mediaId: string }> => {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', photo.type);
    form.append('file', photo, 'photo');

    const uploadResponse = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${env.WA_PHONE_ID}/media`,
        {
            method: 'POST',
            headers: { authorization: `Bearer ${env.WA_TOKEN}` },
            body: form,
        },
    );

    if (!uploadResponse.ok) {
        throw new Error(
            `WhatsApp media upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`,
        );
    }

    const uploaded = z.looseObject({ id: z.string() }).safeParse(await uploadResponse.json());
    if (!uploaded.success) {
        throw new Error('WhatsApp media upload: unexpected response shape');
    }
    const mediaId = uploaded.data.id;

    const waMessageId = await postWhatsappMessage({
        to,
        type: 'image',
        image: caption ? { id: mediaId, caption } : { id: mediaId },
    });
    return { waMessageId, mediaId };
};

const mediaMetaSchema = z.looseObject({ url: z.string(), mime_type: z.string() });
// На исчезнувшее медиа Graph отвечает не 404, а 400 с этим кодом — «объекта не существует».
const GRAPH_UNKNOWN_OBJECT_CODE = 100;
const graphErrorSchema = z.looseObject({ error: z.looseObject({ code: z.number() }) });

export const downloadWhatsappMedia = async (mediaId: string) => {
    const metaResponse = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`, {
        headers: { authorization: `Bearer ${env.WA_TOKEN}` },
    });
    if (metaResponse.status === 404) {
        return null;
    }
    if (!metaResponse.ok) {
        const body = await metaResponse.json().catch(() => null);
        const graphError = graphErrorSchema.safeParse(body);
        if (graphError.success && graphError.data.error.code === GRAPH_UNKNOWN_OBJECT_CODE) {
            return null;
        }
        throw new Error(
            `WhatsApp media lookup failed: ${metaResponse.status} ${JSON.stringify(body)}`,
        );
    }

    const meta = mediaMetaSchema.safeParse(await metaResponse.json());
    if (!meta.success) {
        throw new Error('WhatsApp media lookup: unexpected response shape');
    }

    // Сам файл лежит на lookaside-хосте и тоже требует Bearer — без него отдаёт 401.
    const fileResponse = await fetch(meta.data.url, {
        headers: { authorization: `Bearer ${env.WA_TOKEN}` },
    });
    if (fileResponse.status === 404) {
        return null;
    }
    if (!fileResponse.ok) {
        throw new Error(
            `WhatsApp media download failed: ${fileResponse.status} ${await fileResponse.text()}`,
        );
    }

    return {
        bytes: new Uint8Array(await fileResponse.arrayBuffer()),
        mimeType: meta.data.mime_type,
    };
};

// Показывает «печатает…» в ответ на входящее и помечает прочитанным.
export const sendTypingIndicator = async (waMessageId: string): Promise<void> => {
    const response = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${env.WA_PHONE_ID}/messages`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${env.WA_TOKEN}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: waMessageId,
                typing_indicator: { type: 'text' },
            }),
        },
    );

    if (!response.ok) {
        throw new Error(`WhatsApp typing failed: ${response.status} ${await response.text()}`);
    }
};
