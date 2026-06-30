import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../../environment.ts';
import type { PartyGuestlistStorage } from '../db/guestlist.ts';
import type { GuestStorage } from '../db/guests.ts';
import type { WaMessageStorage } from '../db/wa-messages.ts';
import { toolsByName, tools as toolsList } from './tools/index.ts';
import type { ToolContext } from './tools/types.ts';

export interface ChatContext {
    guest: GuestStorage;
    messages: WaMessageStorage[];
    ownedGuestlist: PartyGuestlistStorage[];
    now: string;
}

const MAX_STEPS = 12;
const MAX_TOKENS = 1024;

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const toolDefs: Anthropic.Tool[] = toolsList.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.input) as Anthropic.Tool.InputSchema,
}));

// Статичная часть промпта — кэшируется (cache_control), переиспользуется между вызовами.
const BEHAVIOR = `Ты — Сёма (sema), хост вечеринок в Дубае. Общаешься с гостями в WhatsApp как живой человек, не как бот.

## Тон
- На «бро/ты», тёпло, по-дружески, без давления. Пишешь СУХО и коротко, как живой парень в мессенджере.
- Каждый пузырь — одна короткая мысль. Часто 1–4 слова («Так», «Внутри тусовка», «Surf Club»). Длинное дроби на пузыри.
- Эмодзи РЕДКО: максимум один на весь ответ, и только ❤️/💙, обычно в тёплом закрытии. Никаких 🎉🔥👌😊👋 пачками.
- Скобка-улыбка ) уместна. Не расписывай, не объясняй лишнего, не продавай — сухо и по делу, но тепло.
- Все пузыри одного ответа отправляешь ОДНИМ вызовом send_message (массив texts), а не по одному.

Примеры реального тона (так и пиши):
гость: Привет → «Привет) как дела ?»
гость: я в Дубае → «Так» / «В субботу я жду»
гость: какая площадка? → «Surf Club» / «Четверг COYA» / «На пальме»
гость: жарко на улице → «Внутри тусовка» / «Комфортно будет»
гость: спасибо за приглашение ❤️ → «❤️❤️❤️» / «Тоже буду рад видеть»

## Как отвечать
- ЕДИНСТВЕННЫЙ способ написать гостю — вызвать send_message. Любой текст вне send_message гость не увидит.
- Это WhatsApp: пиши простым текстом, без markdown (никаких **, *, ##, списков с #). Выделяй смысл словами и эмодзи, а не разметкой.
- Не выдавай сразу всё. Сначала small talk: «как дела?», «ты в Дубае?». Потом переход к ивенту.

## Флоу
1. Приветствие + small talk (как дела / ты в Дубае).
2. Данные о вечеринках бери через get_parties (площадки, даты/время, цена, ассеты). Анонсируй дату и площадку.
3. Тихо собираешь данные гостя в чате: спрашиваешь имя/фамилию, потом инстаграм. Каждое поле сохраняешь через update_guest.
4. Когда есть имя — заносишь в гест-лист через add_to_guestlist (party_id из get_parties).
5. Можешь предложить стол. Если гость согласился — book_table. Если отказ/«подумаю» — не дави, закрывай позитивно.
6. Можешь поделиться афишей и WhatsApp-группой (из get_parties → assets).

## Важно
- Формы (forms.gle) больше НЕТ. Ты сам собираешь имя и инсту в переписке — не шли ссылок на формы.
- Не дави на продажу стола: приоритет — пригласить и занести в гест-лист.
- Нерелевантное (рецепты, оффтоп) — мягко отшей с юмором, не продолжай.`;

export const agent = {
    async do(context: ChatContext): Promise<string[]> {
        const replies: string[] = [];
        const ctx: ToolContext = {
            guestId: context.guest.id,
            phone: context.guest.wa_phone ?? '',
            replies,
        };

        const messages = buildMessages(context.messages);
        const system = buildSystem(context);

        const startedAt = process.hrtime();
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let steps = 0;

        for (let step = 0; step < MAX_STEPS; step++) {
            steps = step + 1;
            const response = await client.messages.create({
                model: env.ANTHROPIC_MODEL,
                max_tokens: MAX_TOKENS,
                system,
                tools: toolDefs,
                messages,
            });
            messages.push({ role: 'assistant', content: response.content });
            inputTokens += response.usage.input_tokens;
            outputTokens += response.usage.output_tokens;
            cacheRead += response.usage.cache_read_input_tokens ?? 0;
            cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

            const toolUses = response.content.filter((block) => block.type === 'tool_use');
            console.log(
                `[agent] ${ctx.phone} step ${step} stop=${response.stop_reason} tools=${toolUses.map((t) => t.name).join(',') || '-'} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
            );

            if (response.stop_reason !== 'tool_use' || !toolUses.length) {
                // fallback: модель ответила текстом мимо send_message — не теряем реплику
                if (!replies.length) {
                    for (const block of response.content) {
                        if (block.type !== 'text') {
                            continue;
                        }
                        for (const line of block.text.split('\n')) {
                            const bubble = line.trim();
                            if (bubble) {
                                replies.push(bubble);
                            }
                        }
                    }
                }
                break;
            }

            const results: Anthropic.ToolResultBlockParam[] = [];
            for (const toolUse of toolUses) {
                const tool = toolsByName.get(toolUse.name);
                let output: unknown;
                try {
                    output = tool
                        ? await tool.handler(ctx, toolUse.input)
                        : { ok: false, error: 'unknown_tool' };
                } catch (error) {
                    console.error(`[agent] ${ctx.phone} tool ${toolUse.name} threw`, error);
                    output = { ok: false, error: 'tool_failed' };
                }
                console.log(
                    `[agent] ${ctx.phone} tool ${toolUse.name} → ${JSON.stringify(output)}`,
                );
                results.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(output),
                });
            }
            messages.push({ role: 'user', content: results });
        }

        const [sec, nano] = process.hrtime(startedAt);
        console.log(
            `[agent] ${ctx.phone} turn done: ${steps} steps, ${replies.length} replies, ${sec}s ${Math.round(nano / 1e6)}ms, tokens in=${inputTokens} cacheR=${cacheRead} cacheW=${cacheWrite} out=${outputTokens}`,
        );

        return replies;
    },
};

const buildMessages = (history: WaMessageStorage[]): Anthropic.MessageParam[] => {
    const messages: Anthropic.MessageParam[] = [];
    for (const message of history) {
        if (!message.text) {
            continue;
        }
        messages.push({
            role: message.owner === 'guest' ? 'user' : 'assistant',
            content: message.text,
        });
    }
    const last = messages[messages.length - 1];
    if (last?.role !== 'user') {
        messages.push({
            role: 'user',
            content: '(гость молчит — начни диалог тёплым приветствием)',
        });
    }
    return messages;
};

const buildSystem = (context: ChatContext): Anthropic.TextBlockParam[] => {
    const lang = detectGuestLang(context.messages);
    const langLine =
        lang === 'en'
            ? 'Гость пишет ПО-АНГЛИЙСКИ — отвечай ТОЛЬКО на английском, ни слова по-русски.'
            : 'Гость пишет ПО-РУССКИ — отвечай на русском.';

    const known: string[] = [];
    if (context.guest.first_name) known.push(`имя: ${context.guest.first_name}`);
    if (context.guest.last_name) known.push(`фамилия: ${context.guest.last_name}`);
    if (context.guest.instagram_url) known.push(`instagram: ${context.guest.instagram_url}`);
    if (context.guest.came_from === 'ad') known.push('пришёл с рекламы');

    const onLists: string[] = [];
    for (const entry of context.ownedGuestlist) {
        const booked = entry.booked_table ? ', стол забронирован' : '';
        onLists.push(`- party_id=${entry.party_id}${booked}`);
    }

    const tail = `## Язык (критично)
${langLine}

## Что уже знаем о госте
${known.length ? known.join('; ') : '(пока ничего — собери имя и инсту)'}

## Гость уже в гест-листах
${onLists.length ? onLists.join('\n') : '(ни в одном)'}

Текущее время в Дубае: ${context.now}.`;

    return [
        { type: 'text', text: BEHAVIOR, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: tail },
    ];
};

const detectGuestLang = (history: WaMessageStorage[]): 'ru' | 'en' => {
    let cyrillic = 0;
    let latin = 0;
    for (const message of history) {
        if (message.owner !== 'guest' || !message.text) {
            continue;
        }
        cyrillic += (message.text.match(/[а-яё]/gi) ?? []).length;
        latin += (message.text.match(/[a-z]/gi) ?? []).length;
    }
    return latin > cyrillic ? 'en' : 'ru';
};
