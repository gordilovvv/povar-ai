import { ulid } from 'ulid';
import { z } from 'zod';
import { pool } from '#Db/Pool.js';
import { selectWaChat, updateWaChatLastSent } from '#Db/WaChats.js';
import { insertWaMessage } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { badInput } from '#Intelligence/Tools/Utils.js';
import { stripLongDashes, stripYo } from '#Lib/Fmt.js';
import type { AgentTool, ToolContext } from '#Lib/Tools.js';
import { sendWhatsappText } from '#Platforms/Whatsapp/index.js';

const name = 'send_message';
const description = `Send the guest a reply. texts is an array of short bubbles delivered in a row, like real texting. Split a thought into bubbles and send them ALL in one call, never one by one. Reply in the guest's language. This is the only way to answer the guest.`;

const input = z.object({
    texts: z.array(z.string().min(1)).min(1),
});

const PAUSED_INSTRUCTION =
    'The chat is closed and handed to a human. Nothing was sent. Do not call any other tool. End your turn with no output.';

const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return badInput(parsed.error);
    }

    const client = await pool.connect();
    let chat: Awaited<ReturnType<typeof selectWaChat>>;
    try {
        chat = await selectWaChat(client, ctx.phone);
    } finally {
        client.release();
    }

    if (chat?.paused_at) {
        console.log(`[send_message] ${ctx.phone} paused, nothing sent`);
        return { ok: false, error: 'chat_paused', instruction: PAUSED_INSTRUCTION };
    }

    return sendMessages(ctx, parsed.data.texts);
};

export const sendMessages = async (ctx: ToolContext, texts: string[]) => {
    const prepared = texts.map((text) => stripYo(stripLongDashes(text)));
    const sent: { waMessageId: string; text: string }[] = [];

    if (env.WA_SEND === 'on') {
        for (const text of prepared) {
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
    for (const text of prepared) {
        ctx.replies.push(text);
        console.log(`[send_message:off] ${ctx.phone}: ${text}`);
    }

    return { ok: true, sent: prepared.length };
};

export default { name, description, input, handler } satisfies AgentTool;
