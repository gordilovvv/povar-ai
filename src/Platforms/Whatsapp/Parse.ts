import { z } from 'zod';

const mediaSchema = z.looseObject({
    id: z.string(),
    mime_type: z.string().optional(),
    caption: z.string().optional(),
});

const messageSchema = z.looseObject({
    id: z.string(),
    from: z.string(),
    type: z.string(),
    text: z.looseObject({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    video: mediaSchema.optional(),
    audio: mediaSchema.optional(),
    document: mediaSchema.optional(),
    sticker: mediaSchema.optional(),
    referral: z.looseObject({ source_id: z.string() }).optional(),
});

const statusSchema = z.looseObject({
    id: z.string(),
    status: z.string(), // sent | delivered | read | failed
});

const valueSchema = z.looseObject({
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
    contacts: z
        .array(
            z.looseObject({
                profile: z.looseObject({ name: z.string() }).optional(),
                wa_id: z.string().optional(),
            }),
        )
        .optional(),
});

export const payloadSchema = z.looseObject({
    entry: z.array(z.looseObject({ changes: z.array(z.looseObject({ value: valueSchema })) })),
});

export type WaWebhookPayload = z.infer<typeof payloadSchema>;
export type WaMessage = z.infer<typeof messageSchema>;
export type WaMedia = z.infer<typeof mediaSchema>;
export type WaStatus = z.infer<typeof statusSchema>;

export const waMessageMedia = (message: WaMessage): WaMedia | undefined =>
    message.image ?? message.video ?? message.audio ?? message.document ?? message.sticker;
