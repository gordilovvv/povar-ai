// Tone probe: полный system-промт, урезанный флоу. Гоняем короткие сценарии на тон агента.
// node --env-file-if-exists=.env.dev scripts/toneProbe.ts [A|B|C|B2|current]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const base = readFileSync(join(process.cwd(), 'src/intelligence/system.md'), 'utf8');

type Swap = [string, string];

const variants: Record<string, Swap[]> = {
    current: [],
    // A — спокойный взрослый, минимум слов, без «бро»
    A: [
        [
            '- "Bro" style, warm, friendly, zero pressure. Write DRY and short, like a real guy texting.',
            '- Easy and grown, warm, zero pressure — a guy in his late 20s texting, not a hyped teenager. No "bro" or slang. Short and to the point, but never cold.',
        ],
        [
            "- Don't over-explain, don't sell hard — dry and to the point, but warm.",
            "- Don't over-explain, don't sell hard — economical with words, but there's a person behind them.",
        ],
        [
            'joke it off ("Bro, there\'s google 🤣") and stop.',
            'joke it off ("Это не ко мне, загугли 🤣" / "Not my department, google it 🤣") and stop.',
        ],
        [
            'just close warm ("Всё бро, жду, увидимся на тусовке")',
            'just close warm ("Всё, буду ждать, увидимся на вечеринке")',
        ],
        [
            'confirm: "All set bro, table booked, see you at the party".',
            'confirm: "Готово, стол забронил, до встречи на вечеринке" / "Done, table\'s booked, see you there".',
        ],
    ],
    // B — чуть теплее, немного человечнее, лёгкая взрослость
    B: [
        [
            '- "Bro" style, warm, friendly, zero pressure. Write DRY and short, like a real guy texting.',
            '- Warm and grown-up, glad the guest wrote — like a host, not a kid. No "bro". Still short, one thought per bubble, but with a human touch, not robotic.',
        ],
        [
            "- Don't over-explain, don't sell hard — dry and to the point, but warm.",
            "- Don't over-explain, don't sell hard — short and warm, a real person on the other end.",
        ],
        [
            'joke it off ("Bro, there\'s google 🤣") and stop.',
            'joke it off ("Ну это уже в гугл 🤣" / "That\'s one for google 🤣") and stop.',
        ],
        [
            'just close warm ("Всё бро, жду, увидимся на тусовке")',
            'just close warm ("Всё, буду ждать тебя, до встречи 🤝")',
        ],
        [
            'confirm: "All set bro, table booked, see you at the party".',
            'confirm: "Готово, стол за тобой, до встречи на вечеринке" / "All done, table\'s yours, see you there".',
        ],
    ],
    // B2 — доработка B по вердикту fable: зеркалить эмоцию, мягче оффтоп, не сухая точка
    B2: [
        [
            '- "Bro" style, warm, friendly, zero pressure. Write DRY and short, like a real guy texting.',
            '- Warm and grown-up, glad the guest wrote — like a host, not a kid. No "bro". Still short, one thought per bubble, but with a human touch, not robotic.',
        ],
        [
            "- Don't over-explain, don't sell hard — dry and to the point, but warm.",
            '- Don\'t over-explain, don\'t sell hard — short and warm, a real person on the other end.\n- When the guest shares a feeling, mirror it in one human phrase — never a flat "Понимаю" / "I get it" on its own.\n- Don\'t close on a flat period-statement; where it fits, leave a small hook ("приходи — услышишь" / "come by, you\'ll hear it").',
        ],
        [
            'joke it off ("Bro, there\'s google 🤣") and stop.',
            'joke it off ("Такое лучше у гугла спросить 🤣" / "That one\'s better asked to google 🤣") and stop.',
        ],
        [
            'just close warm ("Всё бро, жду, увидимся на тусовке")',
            'just close warm ("Всё, буду ждать тебя, до встречи 🤝")',
        ],
        [
            'confirm: "All set bro, table booked, see you at the party".',
            'confirm: "Готово, стол за тобой, до встречи на вечеринке" / "All done, table\'s yours, see you there".',
        ],
    ],
    // C — сухой, но взрослый и уверенный, без «бро»
    C: [
        [
            '- "Bro" style, warm, friendly, zero pressure. Write DRY and short, like a real guy texting.',
            '- Dry, short, confident — a grown guy texting, zero pressure, no "bro". Warm underneath, but sparing with words.',
        ],
        [
            'joke it off ("Bro, there\'s google 🤣") and stop.',
            'joke it off ("Это в гугл 🤣" / "That\'s a google one 🤣") and stop.',
        ],
        [
            'just close warm ("Всё бро, жду, увидимся на тусовке")',
            'just close warm ("Всё, жду, увидимся на вечеринке")',
        ],
        [
            'confirm: "All set bro, table booked, see you at the party".',
            'confirm: "Всё, стол забронил, до встречи" / "Done, table booked, see you there".',
        ],
    ],
    // G — сообщение о поддержке: инста + вотсап-группа с афишами
    G: [
        [
            `   - Offer to support the event: ask to follow the instagram (link from get_parties assets), once per conversation. Exact shape:
     "Будем рад, если подпишешься на нашу инсту, там анонсы вечеринок, фото/видео с ивентов

     Insta: {link}"
     (in English if the guest writes English, same structure.)`,
            `   - Offer to support the event: ask to follow the instagram (link from get_parties assets) AND to join the WhatsApp group, once per conversation. Exact shape:
     "Будем рад, если подпишешься на нашу инсту, там анонсы вечеринок, фото/видео с ивентов

     Insta: {link}

     И залетай в наш вотсап, там все афиши тусовок и анонсы

     Группа: https://chat.whatsapp.com/GZ2IIBdkm4W78CoqNtxayu?mode=gi_t"
     English shape (same structure):
     "Would be glad if you follow our instagram — party announcements, photos and videos from events

     Insta: {link}

     And hop into our WhatsApp group, all the party posters and announcements are there

     Group: https://chat.whatsapp.com/GZ2IIBdkm4W78CoqNtxayu?mode=gi_t"`,
        ],
    ],
};

const buildSystem = (swaps: Swap[]): string => {
    let text = base;
    for (const [from, to] of swaps) {
        if (!text.includes(from)) throw new Error(`swap not found: ${from.slice(0, 40)}`);
        text = text.replace(from, to);
    }
    return text;
};

const tail = (opts: { lang: 'ru' | 'en'; known: string; lists: string }) =>
    [
        `Language: The guest writes in ${opts.lang === 'en' ? 'ENGLISH — reply ONLY in English' : 'RUSSIAN — reply in Russian'}.`,
        `Known about guest: ${opts.known}`,
        `On guestlists: ${opts.lists}`,
        `Dubai time now: Saturday 18:00.`,
    ].join('\n');

interface Scene {
    name: string;
    lang: 'ru' | 'en';
    known: string;
    lists: string;
    turns: { role: 'user' | 'assistant'; text: string }[];
}

// Урезанные сценарии — только точки, где живёт тон, без прогона всего флоу.
const scenes: Scene[] = [
    {
        name: 'RU · приветствие',
        lang: 'ru',
        known: 'nothing yet — collect name and instagram',
        lists: 'none',
        turns: [{ role: 'user', text: 'Привет' }],
    },
    {
        name: 'RU · тёплое закрытие',
        lang: 'ru',
        known: 'first name: Игорь; instagram: instagram.com/igor; came from an ad',
        lists: 'party 1',
        turns: [
            { role: 'assistant', text: 'Всё, добавил тебя в гест-лист' },
            { role: 'user', text: 'спасибо, до встречи' },
        ],
    },
    {
        name: 'EN · greeting',
        lang: 'en',
        known: 'nothing yet — collect name and instagram',
        lists: 'none',
        turns: [{ role: 'user', text: 'hey' }],
    },
    {
        name: 'RU · оффтоп (шутка)',
        lang: 'ru',
        known: 'nothing yet — collect name and instagram',
        lists: 'none',
        turns: [{ role: 'user', text: 'а как пасту карбонара приготовить?' }],
    },
    {
        name: 'RU · эмоция гостя',
        lang: 'ru',
        known: 'first name: Игорь; came from an ad',
        lists: 'party 1',
        turns: [
            { role: 'assistant', text: 'Всё, добавил тебя в гест-лист' },
            { role: 'user', text: 'спасибо, неделя была капец тяжёлая, отдохну наконец' },
        ],
    },
    {
        name: 'RU · вопрос про себя',
        lang: 'ru',
        known: 'nothing yet — collect name and instagram',
        lists: 'none',
        turns: [
            { role: 'assistant', text: 'В субботу жду' },
            { role: 'user', text: 'а ты сам будешь играть?' },
        ],
    },
    {
        name: 'RU · поддержка (инста + группа)',
        lang: 'ru',
        known: 'first name: Игорь; instagram: instagram.com/igor; came from an ad',
        lists: 'party 1',
        turns: [
            { role: 'assistant', text: 'Всё, добавил тебя' },
            { role: 'user', text: 'класс, а как вас поддержать?' },
        ],
    },
    {
        name: 'EN · support (insta + group)',
        lang: 'en',
        known: 'first name: John; instagram: instagram.com/john; came from an ad',
        lists: 'party 1',
        turns: [
            { role: 'assistant', text: 'Done, added you' },
            { role: 'user', text: 'nice, how can I support you?' },
        ],
    },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

const run = async (variantKey: string) => {
    const system = buildSystem(variants[variantKey]);
    console.log(`\n${'='.repeat(60)}\nVARIANT ${variantKey}  (model ${model})\n${'='.repeat(60)}`);
    for (const scene of scenes) {
        const response = await client.messages.create({
            model,
            max_tokens: 1024,
            system: [
                { type: 'text', text: system },
                { type: 'text', text: tail(scene) },
            ],
            messages: scene.turns.map((t) => ({ role: t.role, content: t.text })),
        });
        const text = response.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('\n')
            .trim();
        console.log(
            `\n— ${scene.name} —\n${text || '(пусто — модель дернулась в tool, тут инструментов нет)'}`,
        );
    }
};

const arg = process.argv[2];
const keys = arg && variants[arg] ? [arg] : ['current', 'A', 'B', 'C'];
for (const key of keys) {
    await run(key);
}
