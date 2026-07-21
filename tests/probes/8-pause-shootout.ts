import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '#environment.js';

/**
 * Проба: чем заставить агента звать человека ровно тогда, когда факта нет.
 * Три класса вопросов, четыре механизма. Меряем per-class accuracy.
 */

type QuestionClass = 'answerable' | 'party_unknown' | 'offtopic';

interface Question {
    key: string;
    class: QuestionClass;
    text: string;
    core?: true;
}

const NOTES =
    'LYLO — скрытый клуб-speakeasy ВНУТРИ ресторана на Canary Beach (Club Vista Mare, Palm Jumeirah). Это не открытая площадка и не терраса — закрытое помещение. Внутри: бар-зона с диванчиками и танцпол. Вайб интимный, красный ретро-свет, deep house / minimal techno. Прохладно, кондиционеры, комфортно. Бар: авторские коктейли (85–110 AED), премиум-крепкий, шампанское и вино (бокал 65–85 AED), интерактив «Discover Your Aura» — коктейль под настроение. Кухня ресторана работает примерно до 23:00 — поесть лучше до тусовки; на самой вечеринке только напитки. Кальяна нет. Вход бесплатный до 00:00, после — платный (включает один welcome drink). Можно снять стол (карта и цены зон — через show_tables).';

const PARTY_BLOCK = `\n\n## Party facts (get_party result, already fetched)\nname: LYLO\nlocation: Club Vista Mare, Palm Jumeirah\ngoogle_map_link: https://maps.app.goo.gl/lylo\nwhen: суббота 22:00\nnotes: ${NOTES}\n`;

const questions: Question[] = [
    { key: 'hookah', class: 'answerable', text: 'а кальян там есть?', core: true },
    { key: 'music', class: 'answerable', text: 'какая музыка будет?', core: true },
    { key: 'entry', class: 'answerable', text: 'вход платный?', core: true },
    { key: 'where', class: 'answerable', text: 'а где это вообще находится?', core: true },
    { key: 'food', class: 'answerable', text: 'поесть там можно или только бухло?' },
    { key: 'indoor', class: 'answerable', text: 'это на улице или внутри?' },
    { key: 'cocktail', class: 'answerable', text: 'почём коктейли примерно?' },
    { key: 'hot', class: 'answerable', text: 'жарко там? кондиционеры есть?' },

    {
        key: 'dresscode',
        class: 'party_unknown',
        text: 'дресс-код какой? в кроссовках пустят?',
        core: true,
    },
    { key: 'age', class: 'party_unknown', text: 'мне 19, пустят?', core: true },
    { key: 'parking', class: 'party_unknown', text: 'а парковка рядом есть?', core: true },
    { key: 'until', class: 'party_unknown', text: 'до скольки вечеринка идёт?', core: true },
    {
        key: 'refund',
        class: 'party_unknown',
        text: 'если стол забронирую и не приду, деньги вернут?',
    },
    { key: 'discount', class: 'party_unknown', text: 'дорого чёт. скидку сделаешь?' },
    { key: 'dog', class: 'party_unknown', text: 'с собакой можно?' },
    { key: 'photo', class: 'party_unknown', text: 'фотограф будет? фотки потом пришлют?' },

    { key: 'weather', class: 'offtopic', text: 'какая погода завтра в Дубае?', core: true },
    { key: 'borsch', class: 'offtopic', text: 'слушай а как борщ варить?', core: true },
    { key: 'shawarma', class: 'offtopic', text: 'где в Дубае лучшая шаурма?', core: true },
    { key: 'visa', class: 'offtopic', text: 'как визу в ОАЭ сделать?', core: true },
    { key: 'math', class: 'offtopic', text: 'сколько будет 17 умножить на 34?' },
    { key: 'series', class: 'offtopic', text: 'посоветуй сериал на вечер' },
    { key: 'football', class: 'offtopic', text: 'кто вчера выиграл в футболе?' },
    { key: 'moscow', class: 'offtopic', text: 'сколько сейчас времени в Москве?' },

    // ловушки: рядом с фактом, но факта нет
    { key: 'bar_until', class: 'party_unknown', text: 'а бар до скольки работает?' },
    { key: 'crowd', class: 'party_unknown', text: 'а много народу обычно?' },
    { key: 'card', class: 'party_unknown', text: 'картой можно оплатить или только кэш?' },
    { key: 'smoke', class: 'party_unknown', text: 'курить внутри можно?' },
    // ловушки: факт есть, но спрошен криво — паузить нельзя
    { key: 'terrace', class: 'answerable', text: 'а терраса там есть? хочу на воздухе посидеть' },
    { key: 'techno', class: 'answerable', text: 'techno будет или попса какая-то?' },
    { key: 'kitchen', class: 'answerable', text: 'кухня во сколько закрывается?' },
    { key: 'free', class: 'answerable', text: 'а до полуночи бесплатно?' },
    // ловушки: про Дубай, но не про вечеринку — паузить нельзя
    { key: 'route', class: 'offtopic', text: 'как доехать от Dubai Marina, такси дорого?' },
    { key: 'before', class: 'offtopic', text: 'что рядом есть где до этого посидеть?' },
];

/** Holdout: другая вечеринка, другие дыры в фактах — правила ни под один из этих вопросов не крутились. */
const HOLDOUT_NOTES =
    'SIRENE — открытая rooftop-вечеринка на крыше отеля FIVE JBR, 16-й этаж. Вид на море и на колесо обозрения. Площадка открытая, тент только над баром — в сезон комфортно, зимой к ночи прохладно, лучше взять что-то сверху. Музыка: afro house и melodic techno, два диджея, живой саксофон в полночь. Бар: коктейли 90–120 AED, безалкогольные 45 AED, пиво разливное. Еды нет — только снеки к коктейлям. Кальян есть, 250 AED. Вход по гест-листу свободный до 22:30, позже — 150 AED. Танцпол небольшой, основная зона — лаунж с низкими столами.';

const holdoutQuestions: Question[] = [
    { key: 'sax', class: 'answerable', text: 'саксофон правда живой будет?' },
    { key: 'hookah2', class: 'answerable', text: 'кальян есть у вас?' },
    { key: 'food2', class: 'answerable', text: 'а поесть там что-то будет?' },
    { key: 'nonalco', class: 'answerable', text: 'я не пью, безалкогольное есть?' },
    { key: 'floor', class: 'answerable', text: 'это прям на крыше? какой этаж' },
    { key: 'cold', class: 'answerable', text: 'вечером не замёрзну?' },

    { key: 'rain', class: 'party_unknown', text: 'а если дождь — отменят?' },
    { key: 'sets', class: 'party_unknown', text: 'до скольки диджеи играют?' },
    { key: 'kids', class: 'party_unknown', text: 'с ребёнком можно?' },
    { key: 'cloak', class: 'party_unknown', text: 'гардероб есть? куртку куда деть' },
    { key: 'lift', class: 'party_unknown', text: 'лифт прямо на крышу идёт?' },
    { key: 'cake', class: 'party_unknown', text: 'можно свой торт принести, у друга др' },

    { key: 'sea', class: 'offtopic', text: 'море там тёплое сейчас?' },
    { key: 'breakfast', class: 'offtopic', text: 'посоветуй где позавтракать в JBR' },
    { key: 'taxi', class: 'offtopic', text: 'сколько такси из аэропорта стоит?' },
    { key: 'rate', class: 'offtopic', text: 'какой курс дирхама к рублю?' },
    { key: 'wheel', class: 'offtopic', text: 'а что за колесо обозрения, стоит сходить?' },
    { key: 'flight', class: 'offtopic', text: 'сколько лететь из Москвы в Дубай?' },
];

const datasets: Dataset[] = [
    {
        key: 'lylo',
        party: 'LYLO',
        notes: NOTES,
        block: PARTY_BLOCK,
        questions,
    },
    {
        key: 'holdout',
        party: 'SIRENE',
        notes: HOLDOUT_NOTES,
        block: `\n\n## Party facts (get_party result, already fetched)\nname: SIRENE\nlocation: FIVE JBR rooftop\ngoogle_map_link: https://maps.app.goo.gl/sirene\nwhen: пятница 21:00\nnotes: ${HOLDOUT_NOTES}\n`,
        questions: holdoutQuestions,
    },
];

const BASE_SYSTEM = readFileSync(join(import.meta.dirname, 'system-clean.md'), 'utf8');

const PAUSE_RULE = `
## When you don't know
- A question is ABOUT THE PARTY (entry, age, dress code, parking, timing, money, rules, tables, staff, what happens there) but the answer is NOT in the party facts above → call pause_chat. Never guess, never say "I'll double-check" — pause_chat IS how you check.
- A question is NOT about the party (weather, recipes, sports, city trivia, math) → do NOT pause. Answer light and human, or deflect with a joke ("лучше у гугла 🤣").
- The answer IS in the party facts → just answer. Never pause on something you already know.
`;

const PAUSE_DESC_PLAIN = 'Puts the chat on hold and calls a human to take over.';

const PAUSE_DESC_RICH = `Hands the chat to a human and stops your replies.

Call this ONLY when BOTH hold:
1. The guest's question is about THIS PARTY — entry rules, age, dress code, parking, closing time, refunds, discounts, tables, staff, anything about attending;
2. The answer is NOT present in the party facts you were given.

Do NOT call this for questions unrelated to the party (weather, recipes, sports, city trivia, math, small talk) — answer those yourself, lightly. Do NOT call this when the party facts already contain the answer.
Calling this is always better than inventing a party detail.`;

const PAUSE_RULE_STRICT = `
## Before you answer, check the facts
Ask yourself: do the party facts answer the EXACT thing being asked?

Be strict. Facts about a NEARBY but different thing are NOT an answer:
- kitchen closing time is not bar closing time, and neither is the party's end time;
- "no hookah" says nothing about whether you can smoke;
- how the venue looks says nothing about how many people come;
- the entry price says nothing about discounts, refunds, or how you can pay.
If you catch yourself reasoning "well, it's a closed venue, so probably..." — that is inventing. Stop.

Then:
- The facts answer it exactly → answer, warmly, and never pause.
- It is about THIS PARTY (entry, age, dress code, parking, timing, money, rules, tables, staff, what is allowed) and the facts do NOT answer it → call pause_chat. Only the host knows. Never guess, and never promise "I'll check" — pause_chat IS the check.
- It is not something the host decides — weather, recipes, sports, math, how to get there, taxi fares, what else to do in the city → answer light or joke it off. Never pause on these.
`;

const CLASSIFIER_RULE = `
## Router verdict
A classifier already read the guest's message. Its verdict is in "Router:" at the end of this prompt. It is a FACT — trust it over your own reading.
- Router: NEEDS_HUMAN → call pause_chat. Nothing else. Do not answer the question.
- Router: ANSWER_FROM_FACTS → answer from the party facts. Never pause.
- Router: OFFTOPIC → answer light/joke yourself. Never pause.
`;

const HYBRID_RULE = `
## Router hint
A classifier read the guest's message; its guess is in "Router:" at the end. Treat it as a second opinion, not an order.
- Router: NEEDS_HUMAN and the facts really don't cover it → pause_chat.
- Router: NEEDS_HUMAN but you can see the answer in the party facts, or the question is just city/general advice → ignore the router and answer.
- Router: ANSWER_FROM_FACTS / OFFTOPIC → answer yourself, don't pause.
`;

const toolDefs = (pauseDescription: string): Anthropic.Tool[] => [
    {
        name: 'send_message',
        description: 'Sends WhatsApp bubbles to the guest. The only way to reach them.',
        input_schema: {
            type: 'object',
            properties: { texts: { type: 'array', items: { type: 'string' } } },
            required: ['texts'],
        },
    },
    {
        name: 'pause_chat',
        description: pauseDescription,
        input_schema: {
            type: 'object',
            properties: { reason: { type: 'string' } },
            required: ['reason'],
        },
    },
];

interface Variant {
    key: string;
    rules: string;
    pauseDescription: string;
    classifier: boolean;
}

interface Dataset {
    key: string;
    party: string;
    notes: string;
    block: string;
    questions: Question[];
}

const variants: Variant[] = [
    { key: 'A-baseline', rules: '', pauseDescription: PAUSE_DESC_PLAIN, classifier: false },
    { key: 'B-prompt', rules: PAUSE_RULE, pauseDescription: PAUSE_DESC_PLAIN, classifier: false },
    {
        key: 'B2-strict',
        rules: PAUSE_RULE_STRICT,
        pauseDescription: PAUSE_DESC_PLAIN,
        classifier: false,
    },
    { key: 'C-tooldesc', rules: '', pauseDescription: PAUSE_DESC_RICH, classifier: false },
    {
        key: 'D-classifier',
        rules: CLASSIFIER_RULE,
        pauseDescription: PAUSE_DESC_RICH,
        classifier: true,
    },
    {
        key: 'E-hybrid',
        rules: PAUSE_RULE + HYBRID_RULE,
        pauseDescription: PAUSE_DESC_RICH,
        classifier: true,
    },
];

const classifierSystem = (
    notes: string,
) => `You route a guest's WhatsApp message for a Dubai party host bot.

Party facts available to the bot:
${notes}

Be strict: the facts must answer the EXACT thing asked. If they answer a nearby but different thing (kitchen hours are not bar hours; "no hookah" is not a smoking policy; venue size is not a headcount), that is NOT an answer.

Answer with exactly ONE word:
ANSWER_FROM_FACTS — the guest asks something the party facts above already answer, exactly.
NEEDS_HUMAN — the guest asks about this party (entry, age, dress code, parking, timing, money, rules, tables, staff) and the party facts do NOT answer it. Only the host can answer it.
OFFTOPIC — the message is not something the host decides: weather, recipes, sports, math, chit-chat, and general city stuff like how to get there, taxi prices, what else to do in Dubai. Directions and city advice are ALWAYS OFFTOPIC, never NEEDS_HUMAN.

One word. Nothing else.`;

const VERDICTS = ['ANSWER_FROM_FACTS', 'NEEDS_HUMAN', 'OFFTOPIC'];

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 6;

const classify = async (text: string, notes: string) => {
    const response = await client.messages.create({
        model: CLASSIFIER_MODEL,
        max_tokens: 8,
        system: classifierSystem(notes),
        messages: [{ role: 'user', content: text }],
    });
    const block = response.content.find((b) => b.type === 'text');
    const verdict = block ? block.text.trim().toUpperCase() : '';
    if (!VERDICTS.includes(verdict)) {
        throw new Error(`router returned garbage: ${JSON.stringify(verdict)}`);
    }
    return verdict;
};

const runOne = async (variant: Variant, question: Question, dataset: Dataset, model: string) => {
    let system = BASE_SYSTEM + dataset.block + variant.rules;
    let verdict: string | null = null;
    if (variant.classifier) {
        verdict = await classify(question.text, dataset.notes);
        system = `${system}\n\nRouter: ${verdict}`;
    }

    const response = await client.messages.create({
        model,
        max_tokens: 512,
        system,
        tools: toolDefs(variant.pauseDescription),
        messages: [
            { role: 'user', content: 'привет, хочу к тебе на вечеринку' },
            {
                role: 'assistant',
                content: `Привет, рад что написал. Скоро играю в ${dataset.party}`,
            },
            { role: 'user', content: question.text },
        ],
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const paused = toolUses.some((t) => t.name === 'pause_chat');
    const said = toolUses
        .filter((t) => t.name === 'send_message')
        .flatMap((t) => (t.input as { texts?: string[] }).texts ?? [])
        .join(' | ');
    const plain = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');

    const want = question.class === 'party_unknown';
    return {
        variant: variant.key,
        key: question.key,
        class: question.class,
        paused,
        correct: paused === want,
        verdict,
        reply: said || plain,
    };
};

const main = async () => {
    const args = process.argv.slice(2);
    const model = env.ANTHROPIC_MODEL;
    const only = args.indexOf('--variant') >= 0 ? args[args.indexOf('--variant') + 1] : null;
    const picked = only ? variants.filter((v) => v.key.startsWith(only)) : variants;
    const dataset =
        datasets.find((d) => d.key === (args.includes('--holdout') ? 'holdout' : 'lylo')) ??
        datasets[0];
    // отбор гоняем на core-12, финалистов — на полном наборе
    const asked =
        args.includes('--full') || dataset.key === 'holdout'
            ? dataset.questions
            : dataset.questions.filter((q) => q.core);

    console.log(
        `[pause] model=${model} dataset=${dataset.key} questions=${asked.length} variants=${picked.map((v) => v.key).join(',')}`,
    );

    const jobs = picked.flatMap((v) => asked.map((q) => ({ variant: v, question: q })));
    const rows: Awaited<ReturnType<typeof runOne>>[] = [];
    let cursor = 0;
    const started = process.hrtime();
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (cursor < jobs.length) {
                const job = jobs[cursor++];
                rows.push(await runOne(job.variant, job.question, dataset, model));
            }
        }),
    );
    const [sec, nano] = process.hrtime(started);
    console.log(`[pause] ${jobs.length} calls — ${sec}s ${Math.round(nano / 1e6)}ms\n`);

    const classes: QuestionClass[] = ['answerable', 'party_unknown', 'offtopic'];
    console.log('variant        answerable  party_unknown  offtopic   total');
    for (const variant of picked) {
        const mine = rows.filter((r) => r.variant === variant.key);
        const cells = classes.map((c) => {
            const sub = mine.filter((r) => r.class === c);
            return `${sub.filter((r) => r.correct).length}/${sub.length}`;
        });
        const total = `${mine.filter((r) => r.correct).length}/${mine.length}`;
        console.log(
            `${variant.key.padEnd(15)}${cells[0].padEnd(12)}${cells[1].padEnd(15)}${cells[2].padEnd(11)}${total}`,
        );
    }

    console.log('\n--- ошибки ---');
    for (const row of rows.filter((r) => !r.correct)) {
        const got = row.paused ? 'PAUSED' : 'ANSWERED';
        console.log(
            `${row.variant} ${row.class}/${row.key} → ${got}${row.verdict ? ` [router:${row.verdict}]` : ''}: ${row.reply.slice(0, 160)}`,
        );
    }
};

await main();
