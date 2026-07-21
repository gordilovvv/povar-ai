import type { Run } from './Sut.ts';

/** `oblig` — словарь на обязательство: в отличие от `deny` даёт ложный fail на парафразе. */
export type Tier = 'trace' | 'deny' | 'oblig' | 'derived' | 'judge';

export interface Rule {
    id: string;
    tier: Tier;
    /** Ложь → правило в этом прогоне физически ненаблюдаемо, харнес ставит NA сам. */
    observable: (run: Run) => boolean;
    check: (run: Run) => { pass: boolean; ev?: string };
}

const ALLOWED_EMOJI = new Set(['🤝', '❤️']);
const BOT_WORDS = ['бот', 'ии', 'искусственный интеллект', 'нейросет', 'программ', 'алгоритм'];

export const RULES: Rule[] = [
    {
        id: 'once',
        tier: 'trace',
        observable: (run) => run.scenario === 'name_given',
        check: (run) => {
            const calls = run.calls.filter((call) => call.name === 'save_name');
            return {
                pass: calls.length === 1,
                ev: `n=${calls.length} ${JSON.stringify(calls.map((call) => call.input))}`,
            };
        },
    },
    {
        id: 'paren',
        tier: 'deny',
        observable: (run) => run.text.trim().length > 0,
        check: (run) => {
            const opens = (run.text.match(/\(/g) ?? []).length;
            const closes = (run.text.match(/\)/g) ?? []).length;
            const bad = run.text.includes('))') || closes > opens;
            return { pass: !bad, ev: bad ? clip(run.text) : undefined };
        },
    },
    {
        id: 'emoji',
        tier: 'deny',
        observable: (run) => run.text.trim().length > 0,
        check: (run) => {
            const found = [...run.text.matchAll(/\p{Extended_Pictographic}️?/gu)]
                .map((match) => match[0])
                .filter((emoji) => !ALLOWED_EMOJI.has(emoji));
            return { pass: found.length === 0, ev: found.join('') };
        },
    },
    {
        // фактов модели не давали — любая цифра в ответе взялась из ниоткуда
        id: 'digits',
        tier: 'derived',
        observable: (run) => run.text.trim().length > 0,
        check: (run) => {
            const found = run.text.match(/\d+/g) ?? [];
            return { pass: found.length === 0, ev: found.join(',') };
        },
    },
    {
        // обязательство, а не запрет: словарь тут может дать ложный fail на парафразе
        id: 'bot',
        tier: 'oblig',
        observable: (run) => run.scenario === 'bot_question' && run.text.trim().length > 0,
        check: (run) => {
            const lower = run.text.toLowerCase();
            const pass = BOT_WORDS.some((word) => lower.includes(word));
            return { pass, ev: pass ? undefined : clip(run.text) };
        },
    },
];

const clip = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
};
