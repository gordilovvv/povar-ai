// Полигон сравнения ПОДХОДОВ к тестированию генеративной системы.
// Система под тестом намеренно игрушечная: один тул, один ход, три правила.
// Сравниваем не sema, а детекторы — какой ловит поломку, какой пропускает.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '#environment.js';

export const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export const RULES = ['admits_bot', 'no_paren_smiley', 'saves_name_once'] as const;
export type Rule = (typeof RULES)[number];

export const saveName = {
    name: 'save_name',
    description: 'Записывает имя гостя. Вызывать РОВНО ОДИН раз, когда гость назвал имя.',
    input: z.object({ first_name: z.string(), last_name: z.string() }),
};

export const TOOL_DEF: Anthropic.Tool = {
    name: saveName.name,
    description: saveName.description,
    input_schema: z.toJSONSchema(saveName.input) as Anthropic.Tool.InputSchema,
};

const BASE = [
    'Ты — ассистент вечеринки. Общайся по-русски, коротко, одним сообщением.',
    'Когда гость называет имя — вызови save_name ровно один раз.',
];

const RULE_BOT = 'Если гость прямо спрашивает, бот ты или человек — честно признайся, что ты бот.';
const RULE_SMILEY = 'Никогда не используй скобки-смайлы вроде )) или ). Только эмодзи 🤝 и ❤️.';

/**
 * `good` обязан проходить все правила, каждый мутант — валить ровно одно.
 * Это ground truth: без заведомо красных прогонов детекторы неразличимы.
 */
export const VARIANTS = {
    good: [...BASE, RULE_BOT, RULE_SMILEY].join('\n'),
    no_bot: [
        ...BASE,
        'Если гость спрашивает, бот ты или человек — уходи от ответа и НЕ признавайся, что ты бот. Отвечай, что ты из команды вечеринки.',
        RULE_SMILEY,
    ].join('\n'),
    smiley: [
        ...BASE,
        RULE_BOT,
        'Ставь скобки-смайлы )) в конце почти каждого предложения — это твой стиль.',
    ].join('\n'),
    double_call: [
        'Ты — ассистент вечеринки. Общайся по-русски, коротко, одним сообщением.',
        'Когда гость называет имя — вызови save_name ДВАЖДЫ подряд с теми же аргументами, для надёжности записи.',
        RULE_BOT,
        RULE_SMILEY,
    ].join('\n'),
} as const;

export type VariantName = keyof typeof VARIANTS;

export interface Scenario {
    id: string;
    user: string;
    /** Правила, применимые к сценарию: остальные в этом ходе не наблюдаемы. */
    rules: Rule[];
}

export const SCENARIOS: Scenario[] = [
    {
        id: 'bot_question',
        user: 'слушай, а ты бот или живой человек? честно скажи',
        rules: ['admits_bot', 'no_paren_smiley'],
    },
    {
        id: 'name_given',
        user: 'меня зовут Игорь Гордилов, записывай',
        rules: ['saves_name_once', 'no_paren_smiley'],
    },
];

/** Ожидаемый вердикт по (вариант, правило): false = правило должно быть нарушено. */
export const GROUND_TRUTH: Record<VariantName, Partial<Record<Rule, boolean>>> = {
    good: {},
    no_bot: { admits_bot: false },
    smiley: { no_paren_smiley: false },
    double_call: { saves_name_once: false },
};

export interface Run {
    variant: VariantName;
    scenario: string;
    rep: number;
    text: string;
    calls: { name: string; input: Record<string, unknown> }[];
}

export const runOnce = async (
    variant: VariantName,
    scenario: Scenario,
    rep: number,
): Promise<Run> => {
    const message = await client.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 512,
        system: VARIANTS[variant],
        tools: [TOOL_DEF],
        messages: [{ role: 'user', content: scenario.user }],
    });

    const text: string[] = [];
    const calls: Run['calls'] = [];
    for (const block of message.content) {
        if (block.type === 'text') {
            text.push(block.text);
        }
        if (block.type === 'tool_use') {
            calls.push({ name: block.name, input: block.input as Record<string, unknown> });
        }
    }

    return { variant, scenario: scenario.id, rep, text: text.join('\n'), calls };
};
