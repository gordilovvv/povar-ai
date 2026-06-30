import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const model = process.env.ANTHROPIC_MODEL as string;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_STEPS = 12;
const MAX_TOKENS = 1024;

const ASSETS = {
    whatsapp_group: 'https://chat.whatsapp.com/GZ2IIBdkm4W78CoqNtxayu',
    flyer_reel: 'https://www.instagram.com/reel/DZka5l_zn7c/',
};
const PARTIES = [
    {
        id: 'p1',
        name: 'COYA',
        location: 'COYA, Dubai',
        when: '02.07 18:00, бесплатно до 20:00',
        price: '100 дирхам',
    },
];

const BEHAVIOR = `Ты — Сёма (sema), хост вечеринок в Дубае. Общаешься в WhatsApp как живой человек.
Тон: на «бро/ты», тёпло, без давления, скобки-улыбки ) )) и эмодзи умеренно.
Отвечаешь на языке гостя. Это WhatsApp — простой текст, без markdown.
Все пузыри одного ответа шлёшь ОДНИМ вызовом send_message (массив texts). Текст вне send_message гость не видит.
Флоу: приветствие + small talk (как дела/ты в Дубае) → анонс вечеринки → собираешь имя/инсту в чате (update_guest) → тихо в гест-лист (add_to_guestlist) → можешь предложить стол (book_table), без давления. Нерелевантное — мягко отшей.`;

const partiesBlock = () => {
    const parties = PARTIES.map(
        (p) =>
            `- id=${p.id} «${p.name}», ${p.location}, когда: ${p.when}, вход после бесплатного ${p.price}`,
    ).join('\n');
    return `## Вечеринки\n${parties}\n## Ассеты\nгруппа: ${ASSETS.whatsapp_group}; афиша: ${ASSETS.flyer_reel}`;
};

const guestBlock = (guest: GuestState, lists: string[]) => {
    const known = [
        guest.first_name && `имя: ${guest.first_name}`,
        guest.last_name && `фамилия: ${guest.last_name}`,
        guest.instagram_url && `инста: ${guest.instagram_url}`,
    ]
        .filter(Boolean)
        .join('; ');
    return `## Гость знаем\n${known || '(ничего)'}\n## В гест-листах\n${lists.join(', ') || '(нет)'}`;
};

const inlineData = (v: Variant, state: { guest: GuestState; lists: string[] }) => {
    const parts = [
        !v.partiesTool && partiesBlock(),
        !v.guestTool && guestBlock(state.guest, state.lists),
        'Время в Дубае: 30.06 18:00.',
    ].filter(Boolean);
    return parts.join('\n');
};

interface GuestState {
    first_name?: string;
    last_name?: string;
    instagram_url?: string;
}

const sendMessage = {
    name: 'send_message',
    description: 'Ответ гостю: массив коротких пузырей подряд (на языке гостя).',
    input: z.object({ texts: z.array(z.string().min(1)).min(1) }),
};
const updateGuest = {
    name: 'update_guest',
    description: 'Сохранить имя/фамилию/инсту гостя по мере сбора в чате.',
    input: z.object({
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        instagram_url: z.string().optional(),
    }),
};
const addToGuestlist = {
    name: 'add_to_guestlist',
    description: 'Тихо занести гостя в гест-лист вечеринки (party_id).',
    input: z.object({ party_id: z.string() }),
};
const bookTable = {
    name: 'book_table',
    description: 'Забронировать стол на вечеринке, если гость согласился.',
    input: z.object({ party_id: z.string(), table: z.string().optional() }),
};
const getParties = {
    name: 'get_parties',
    description: 'Получить активные вечеринки (даты, площадки, цены) и ассеты (группа, афиша).',
    input: z.object({}),
};
const getGuestState = {
    name: 'get_guest_state',
    description: 'Получить что уже знаем о госте (имя/инста) и в каких он гест-листах.',
    input: z.object({}),
};

const toDef = (t: { name: string; description: string; input: z.ZodType }): Anthropic.Tool => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.input) as Anthropic.Tool.InputSchema,
});

interface Variant {
    name: string;
    partiesTool: boolean;
    guestTool: boolean;
    cache: boolean;
}
const VARIANTS: Variant[] = [
    { name: 'A-inline', partiesTool: false, guestTool: false, cache: false },
    { name: 'D-tools+cache', partiesTool: true, guestTool: true, cache: true },
    { name: 'E-hybrid', partiesTool: true, guestTool: false, cache: true },
];

const SCENARIO = [
    'Привет',
    'Норм, ты как? Я в Дубае. А когда тусовки?',
    'Давай, запиши меня',
    'Иван Петров, инста @ivan_petrov',
];

const runVariant = async (v: Variant) => {
    const state: { guest: GuestState; lists: string[] } = { guest: {}, lists: [] };
    const baseTools = [sendMessage, updateGuest, addToGuestlist, bookTable];
    const extra = [...(v.partiesTool ? [getParties] : []), ...(v.guestTool ? [getGuestState] : [])];
    const tools = [...baseTools, ...extra].map(toDef);
    const lastTool = tools[tools.length - 1];
    if (v.cache && lastTool) {
        lastTool.cache_control = { type: 'ephemeral' };
    }

    const replies: string[] = [];
    const metrics = { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, steps: 0 };
    const messages: Anthropic.MessageParam[] = [];
    const startedAt = process.hrtime();

    for (const text of SCENARIO) {
        messages.push({ role: 'user', content: text });

        const hints = [
            v.partiesTool && 'Данные о вечеринках бери через get_parties.',
            v.guestTool && 'Что знаем о госте — через get_guest_state.',
        ].filter(Boolean);
        const behaviorHint = hints.length ? `${BEHAVIOR}\n${hints.join(' ')}` : BEHAVIOR;
        const inline = inlineData(v, state);
        const system: Anthropic.MessageCreateParams['system'] = v.cache
            ? [
                  { type: 'text', text: behaviorHint, cache_control: { type: 'ephemeral' } },
                  ...(inline ? [{ type: 'text' as const, text: inline }] : []),
              ]
            : inline
              ? `${behaviorHint}\n${inline}`
              : behaviorHint;

        for (let step = 0; step < MAX_STEPS; step++) {
            metrics.steps++;
            const response = await client.messages.create({
                model,
                max_tokens: MAX_TOKENS,
                system,
                tools,
                messages,
            });
            messages.push({ role: 'assistant', content: response.content });
            metrics.inTokens += response.usage.input_tokens;
            metrics.outTokens += response.usage.output_tokens;
            metrics.cacheRead += response.usage.cache_read_input_tokens ?? 0;
            metrics.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

            const toolUses = response.content.filter((b) => b.type === 'tool_use');
            if (response.stop_reason !== 'tool_use' || !toolUses.length) {
                break;
            }

            const results: Anthropic.ToolResultBlockParam[] = [];
            for (const tu of toolUses) {
                const out = dispatch(tu.name, tu.input, state, replies);
                results.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify(out),
                });
            }
            messages.push({ role: 'user', content: results });
        }
    }

    const [sec, nano] = process.hrtime(startedAt);
    const ms = sec * 1000 + Math.round(nano / 1e6);
    const cost =
        metrics.inTokens +
        metrics.cacheRead * 0.1 +
        metrics.cacheWrite * 1.25 +
        metrics.outTokens * 5;
    return { ...metrics, ms, cost: Math.round(cost), replies };
};

const dispatch = (
    name: string,
    input: unknown,
    state: { guest: GuestState; lists: string[] },
    replies: string[],
) => {
    if (name === 'send_message') {
        const texts = (input as { texts: string[] }).texts;
        replies.push(...texts);
        return { ok: true, sent: texts.length };
    }
    if (name === 'update_guest') {
        Object.assign(state.guest, input);
        const missing = ['first_name', 'instagram_url'].filter(
            (k) => !(state.guest as Record<string, unknown>)[k],
        );
        return { ok: true, missing };
    }
    if (name === 'add_to_guestlist') {
        const pid = (input as { party_id: string }).party_id;
        if (!state.lists.includes(pid)) state.lists.push(pid);
        return { ok: true };
    }
    if (name === 'book_table') {
        return { ok: true };
    }
    if (name === 'get_parties') {
        return { parties: PARTIES, assets: ASSETS };
    }
    if (name === 'get_guest_state') {
        return { guest: state.guest, lists: state.lists };
    }
    return { ok: false, error: 'unknown_tool' };
};

const results = [];
for (const v of VARIANTS) {
    const r = await runVariant(v);
    results.push({ v: v.name, ...r });
    console.log(
        `\n##### ${v.name}: steps=${r.steps} in=${r.inTokens} cacheR=${r.cacheRead} cacheW=${r.cacheWrite} out=${r.outTokens} ms=${r.ms} cost~${r.cost}`,
    );
    for (const reply of r.replies) console.log(`  ${reply}`);
}

console.log('\n===== СВОДКА (cost = взвешенные токены, ниже лучше) =====');
for (const r of results.sort((a, b) => a.cost - b.cost)) {
    console.log(
        `${r.v.padEnd(16)} cost~${String(r.cost).padStart(7)} | in=${r.inTokens} cacheR=${r.cacheRead} cacheW=${r.cacheWrite} out=${r.outTokens} | steps=${r.steps} ms=${r.ms} replies=${r.replies.length}`,
    );
}
