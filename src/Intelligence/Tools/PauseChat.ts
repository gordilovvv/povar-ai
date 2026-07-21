import { z } from 'zod';
import { pool } from '#Db/Pool.js';
import { selectWaChat, updateWaChatPaused } from '#Db/WaChats.js';
import { updateNeedProcessedToSkipped } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { sendMessages } from '#Intelligence/Tools/SendMessage.js';
import { badInput } from '#Intelligence/Tools/Utils.js';
import { type Lang, langSchema } from '#Lib/Lang.js';
import type { AgentTool, ToolContext } from '#Lib/Tools.js';

const name = 'pause_chat';
const description = `Hand the chat to Sema and stop replying. Call it for anything about this party that the facts do not answer — money, discounts, refunds, exceptions, complaints, special conditions, personal questions to Sema, and any other question the facts cannot answer. Not for tables — a table answer goes to add_to_guestlist. This tool is the whole reply: it closes the chat itself, so send nothing after it. details is one short line for Sema saying what the guest wants. language is the language the guest writes in; use en if it is neither Russian nor English.`;

const input = z.object({
    details: z.string().trim().min(1),
    language: langSchema,
});

const PAUSE_MESSAGES: Record<Lang, string> = {
    ru: 'Позову Сёму, он ответит тебе сам',
    en: "Let me get Sema, he'll answer you himself",
} as const;

const RES = {
    ok: true,
    status: 'chat_closed',
    instruction:
        'The chat is closed and the guest has already been answered. Do not call send_message or any other tool. End your turn with no output.',
} as const;

const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return badInput(parsed.error);
    }

    const client = await pool.connect();
    let paused: boolean;
    try {
        await client.query('begin');
        paused = await updateWaChatPaused(client, ctx.phone, parsed.data.details, new Date());
        if (!paused && !(await selectWaChat(client, ctx.phone))) {
            throw new Error(`pause_chat: чата ${ctx.phone} нет в wa_chats`);
        }
        // Если чат на паузе - скипнуть сообщения в обработке
        if (paused) {
            await updateNeedProcessedToSkipped(client, ctx.phone);
        }
        await client.query('commit');
    } catch (error) {
        await client.query('rollback');
        throw error;
    } finally {
        client.release();
    }

    if (!paused) {
        console.log(`[pause_chat] ${ctx.phone} already paused, ignored: ${parsed.data.details}`);
        return RES;
    }

    console.log(`[pause_chat] ${ctx.phone} paused: ${parsed.data.details}`);

    // Отправить сообщение по шаблону
    if (env.TEXT_AFTER_PAUSE_CHAT === 'on') {
        await sendMessages(ctx, [PAUSE_MESSAGES[parsed.data.language]]);
    }

    return RES;
};

export default { name, description, input, handler } satisfies AgentTool;
