import { z } from 'zod';

const messageSchema = z.looseObject({
    id: z.string(),
    from: z.string(),
    type: z.string(),
    timestamp: z.string().optional(),
    text: z.looseObject({ body: z.string() }).optional(),
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
export type WaStatus = z.infer<typeof statusSchema>;
