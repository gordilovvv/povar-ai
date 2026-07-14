import { z } from 'zod';
import { env } from '#environment.js';

const WA_API_VERSION = 'v21.0';

const sendResponseSchema = z.looseObject({
    messages: z.array(z.looseObject({ id: z.string() })).min(1),
});

export const sendWhatsappText = async (to: string, body: string): Promise<string> => {
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
                to,
                type: 'text',
                text: { preview_url: false, body },
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

export const sendWhatsappImage = async (
    to: string,
    link: string,
    caption?: string,
): Promise<string> => {
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
                to,
                type: 'image',
                image: caption ? { link, caption } : { link },
            }),
        },
    );

    if (!response.ok) {
        throw new Error(`WhatsApp image send failed: ${response.status} ${await response.text()}`);
    }

    const parsed = sendResponseSchema.safeParse(await response.json());
    const id = parsed.success ? parsed.data.messages[0]?.id : undefined;
    if (!id) {
        throw new Error('WhatsApp image send: unexpected response shape');
    }
    return id;
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
