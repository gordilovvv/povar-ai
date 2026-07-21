import { z } from 'zod';
import { pool } from '#Db/Pool.js';
import { selectWaChat, updateWaChatPaused } from '#Db/WaChats.js';
import { updateNeedProcessedToSkipped } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { sendMessages } from '#Intelligence/Tools/SendMessage.js';
import { badInput } from '#Intelligence/Tools/Utils.js';
import { type Lang, langSchema } from '#Lib/Lang.js';
import { Logger } from '#Lib/Logger.js';
import type { AgentTool, ToolContext } from '#Lib/Tools.js';

const name = 'pause_chat';
const description = `Hand the chat to Sema and stop replying. Call it whenever the guest needs something the party facts from get_party do not answer — money, discounts, refunds, exceptions to the rules, complaints, special conditions, personal requests to Sema, and any other question you have no facts for: never guess and never promise to check. Not for the guest's answer about a table — that is want_table in save_guest, even though both tools end the turn the same way. details is one short line in your own words telling Sema what the guest wants. language is the language the guest writes in; use en if it is neither Russian nor English. This tool is the whole reply: it answers the guest and closes the chat itself, so do not call send_message or any other tool after it — end your turn with no output.`;

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
        Logger.log(`[pause_chat] ${ctx.phone} already paused, ignored: ${parsed.data.details}`);
        return RES;
    }

    Logger.logWarn(`[pause_chat] ${ctx.phone} paused: ${parsed.data.details}`);

    // Отправить сообщение по шаблону
    if (env.TEXT_AFTER_PAUSE_CHAT === 'on') {
        await sendMessages(ctx, [PAUSE_MESSAGES[parsed.data.language]]);
    }

    return RES;
};

export default { name, description, input, handler } satisfies AgentTool;
