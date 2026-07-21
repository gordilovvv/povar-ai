/**
 * Проба идеи 3: заменить регекс-вывод состояния на самодекларацию модели.
 * send_message получает поле intent; проверяем, ставит ли модель его честно.
 * Если да — flow-state читается из журнала интентов, а не угадывается по тексту.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { Agent } from '#Intelligence/Agent.js';

const INTENTS = [
    'small_talk',
    'lineup',
    'ask_name',
    'ask_instagram',
    'guestlist_confirm',
    'insta_followup',
    'venue_answer',
    'table_flow',
    'closing',
] as const;

const sendMessageWithIntent: Anthropic.Tool = {
    name: 'send_message',
    description:
        'Send bubbles to the guest. `intent` MUST describe what this reply DOES in the flow — it is recorded and drives the next turn. Pick the single dominant intent.',
    input_schema: z.toJSONSchema(
        z.object({
            texts: z.array(z.string()),
            intent: z.enum(INTENTS),
        }),
    ) as Anthropic.Tool.InputSchema,
};

interface Case {
    name: string;
    /** что сёма пишет гостю — модель должна это протегировать */
    reply: string[];
    expect: (typeof INTENTS)[number];
}

const CASES: Case[] = [
    { name: 'вопрос про инсту', reply: ['Скинь свой инстаграм'], expect: 'ask_instagram' },
    {
        name: 'follow-up с нашей ссылкой',
        reply: [
            'Буду рад если подпишешься на наш инстаграм — анонсы, фото и видео с вечеринок',
            'Insta: https://www.instagram.com/weare.wrld/',
        ],
        expect: 'insta_followup',
    },
    {
        name: 'афиша (reels_url) — НЕ follow-up',
        reply: ['https://www.instagram.com/p/DUBJSn8DZW5/'],
        expect: 'venue_answer',
    },
    {
        name: 'ответ про комфорт — НЕ стол',
        reply: ['Внутри прохладно, кондиционеры, диванчики — комфортно'],
        expect: 'venue_answer',
    },
    {
        name: 'упоминание инста-зоны — НЕ вопрос про инсту',
        reply: ['Да, там есть инста-зона, красиво выходит'],
        expect: 'venue_answer',
    },
    { name: 'подтверждение гестлиста', reply: ['Всё, добавил тебя'], expect: 'guestlist_confirm' },
    { name: 'вопрос имени', reply: ['Пришли имя фамилию'], expect: 'ask_name' },
    {
        name: 'реальный разговор про стол',
        reply: ['Скинул карту — напиши номер стола'],
        expect: 'table_flow',
    },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.ANTHROPIC_MODEL ?? '';

const startedAt = process.hrtime();
let hits = 0;

for (const item of CASES) {
    const response = await client.messages.create({
        model,
        max_tokens: 512,
        system: [
            { type: 'text', text: Agent.system, cache_control: { type: 'ephemeral' } },
            {
                type: 'text',
                text: 'You are replaying a reply you already decided to send. Call send_message with EXACTLY these texts and the correct intent. Do not reword.',
            },
        ],
        tools: [sendMessageWithIntent],
        tool_choice: { type: 'tool', name: 'send_message' },
        messages: [{ role: 'user', content: `Reply to send:\n${item.reply.join('\n')}` }],
    });

    const use = response.content.find((block) => block.type === 'tool_use');
    const intent = (use?.input as { intent?: string })?.intent ?? '(none)';
    const ok = intent === item.expect;
    if (ok) hits++;
    console.log(
        `${ok ? '✅' : '❌'} ${item.name} → ${intent}${ok ? '' : ` (ждали ${item.expect})`}`,
    );
}

const [sec, nano] = process.hrtime(startedAt);
console.log(
    `\n[probe2] intent угадан ${hits}/${CASES.length}, ${sec}s ${Math.round(nano / 1e6)}ms`,
);
