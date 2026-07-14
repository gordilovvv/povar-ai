import { ulid } from 'ulid';
import { z } from 'zod';
import { pool } from '#Db/Pool.js';
import { updateWaChatLastSent } from '#Db/WaChats.js';
import { insertWaMessage } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import type { AgentTool, ToolContext } from '#Intelligence/Tools/Types.js';
import { stripLongDashes, stripYo } from '#Lib/Fmt.js';
import { sendWhatsappText } from '#Platforms/Whatsapp/index.js';

const name = 'send_message';
const description = `Send the guest a reply. texts is an array of short bubbles delivered in a row, like real texting. Split a thought into bubbles and send them ALL in one call, never one by one. Reply in the guest's language. This is the only way to answer the guest.`;

const input = z.object({
    texts: z.array(z.string().min(1)).min(1),
});

const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, error: 'bad_input' };
    }

    const texts = parsed.data.texts.map((text) => stripYo(stripLongDashes(text)));
    const sent: { waMessageId: string; text: string }[] = [];

    if (env.WA_SEND === 'on') {
        for (const text of texts) {
            const waMessageId = await sendWhatsappText(ctx.phone, text);
            sent.push({ waMessageId, text });
            console.log(`[send_message] ${ctx.phone} sent: ${text}`);
        }

        const now = new Date();
        const client = await pool.connect();
        try {
            for (const item of sent) {
                await insertWaMessage(client, {
                    id: ulid(),
                    wa_message_id: item.waMessageId,
                    wa_chat_phone: ctx.phone,
                    text: item.text,
                    owner: 'sema',
                    status: 'sent',
                    worker_status: null,
                    concurrency_version: 0,
                    sent_at: now,
                });
            }
            await updateWaChatLastSent(client, ctx.phone, now);
        } finally {
            client.release();
        }

        for (const item of sent) {
            ctx.replies.push(item.text);
        }

        return { ok: true, sent: sent.length };
    }

    // Дебаг режим (без реальных сообщений)
    for (const text of texts) {
        ctx.replies.push(text);
        console.log(`[send_message:off] ${ctx.phone}: ${text}`);
    }

    return { ok: true, sent: texts.length };
};

export default { name, description, input, handler } satisfies AgentTool;
