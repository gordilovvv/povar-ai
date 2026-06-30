import { z } from 'zod';
import type { AgentTool, ToolContext } from './types.ts';

const name = 'send_message';
const description = `Отправить гостю ответ. texts — массив коротких пузырей, которые уйдут подряд, как в живой переписке. Дроби мысль на несколько пузырей и шли их ВСЕ одним вызовом, а не по одному. Веди диалог на языке гостя. Это единственный способ ответить гостю.`;

const input = z.object({
    texts: z.array(z.string().min(1)).min(1),
});

const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, error: 'bad_input' };
    }

    for (const text of parsed.data.texts) {
        ctx.replies.push(text);
        console.log(`[tool] send_message ${ctx.phone}: ${text}`);
    }
    return { ok: true, sent: parsed.data.texts.length };
};

export default { name, description, input, handler } satisfies AgentTool;
