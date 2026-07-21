/**
 * Проба 7: в каком виде подавать модели блок состояния.
 * Пять машинных форматов × четыре разделяющих сценария.
 * Сценарии подобраны так, чтобы форма могла провалиться: не повторить сделанное,
 * не ждать необязательного ответа, не сойти с повестки, увидеть +1.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Agent } from '#Intelligence/Agent.js';

/** CLEAN=1 — system.md без старой секции Flow, флоу живёт только в checklist */
const CLEAN = process.env.CLEAN === '1';
if (CLEAN) {
    Agent.system = readFileSync(join(import.meta.dirname, 'system-clean.md'), 'utf8');
}

/** Утверждённый чек-лист из CHECKLIST.md — подаётся отдельным блоком. */
const CHECKLIST = `## Flow (in order; skip what "Done" lists)
1. Greet. From ad/referral → jump to 3.
2. Pitch parties once. More than one party → ask which one.
3. Name: "пришли имя фамилию". Guest brings +1 → get every companion's name too.
4. Ask instagram once (optional) AND add_to_guestlist in the SAME turn —
   never wait for the answer, never re-ask. Confirm + entry conditions.
5. Unprompted after the confirm, once: our instagram + WhatsApp group.
6. Offer a table once. Never book yourself.`;

const REPS = Number(process.env.REPS ?? 2);
/** ONLY=подстрока — прогнать только разделяющие сценарии */
const ONLY = process.env.ONLY ?? null;

interface Facts {
    name: string | null;
    instagram: string | null;
    guestlist: string | null;
    table: 'not raised' | 'raised';
    companions: string;
}

interface State {
    facts: Facts;
    done: number[];
    now: number;
    nowText: string;
}

const STEPS: Record<number, string> = {
    1: 'greet',
    2: 'pitch parties once',
    3: 'get first+last name (and every companion name if +1)',
    4: 'ask instagram once (optional) AND add_to_guestlist in the same turn',
    5: 'send our instagram + WhatsApp group, unprompted',
    6: 'offer a table once',
};

/** standalone — формат сам рендерит весь чек-лист, отдельный блок шагов не добавляем */
type Formatter = { key: string; render: (state: State) => string; standalone?: boolean };

const FULL_STEPS: Record<number, string> = {
    1: 'Greet. From ad/referral → jump to 3.',
    2: 'Pitch parties once. More than one party → ask which one.',
    3: 'Name: "пришли имя фамилию". Guest brings +1 → get every companion\'s name too.',
    4: 'Ask instagram once (optional) AND add_to_guestlist in the SAME turn — never wait, never re-ask. Confirm + entry conditions.',
    5: 'Unprompted after the confirm, once: our instagram + WhatsApp group.',
    6: 'Offer a table once. Never book yourself.',
};

const FORMATS: Formatter[] = [
    {
        key: 'F1 ключ-значение',
        render: (s) =>
            `State: name: ${s.facts.name ?? '—'} | instagram: ${s.facts.instagram ?? '—'} | guestlist: ${s.facts.guestlist ?? '—'} | table: ${s.facts.table} | companions: ${s.facts.companions}
Done: ${s.done.join(', ')}
Now: step ${s.now} — ${s.nowText}`,
    },
    {
        key: 'F2 JSON',
        render: (s) =>
            `State (machine-generated, trust over your own reading):
${JSON.stringify({ facts: s.facts, done: s.done, now: { step: s.now, action: s.nowText } })}`,
    },
    {
        key: 'F3 XML-теги',
        render: (s) =>
            `<state>
  <name>${s.facts.name ?? ''}</name>
  <instagram>${s.facts.instagram ?? ''}</instagram>
  <guestlist>${s.facts.guestlist ?? ''}</guestlist>
  <table>${s.facts.table}</table>
  <companions>${s.facts.companions}</companions>
  <done>${s.done.join(',')}</done>
  <now step="${s.now}">${s.nowText}</now>
</state>`,
    },
    {
        key: 'F4 флаги',
        render: (s) =>
            `name=${s.facts.name ?? 'null'} instagram=${s.facts.instagram ?? 'null'} guestlist=${s.facts.guestlist ?? 'null'} table=${s.facts.table === 'raised' ? 'raised' : 'none'} companions=${s.facts.companions}
DONE=${s.done.join(',')} NEXT=${s.now}: ${s.nowText}`,
    },
    {
        key: 'F5 естественный язык',
        render: (s) => {
            const doneText = s.done.map((n) => STEPS[n]).join('; ');
            const known: string[] = [];
            known.push(s.facts.name ? `имя ${s.facts.name}` : 'имени нет');
            known.push(s.facts.instagram ? `инста ${s.facts.instagram}` : 'инсты нет');
            known.push(
                s.facts.guestlist ? `в гест-листе на ${s.facts.guestlist}` : 'не в гест-листе',
            );
            known.push(`спутники: ${s.facts.companions}`);
            return `Ты уже сделал: ${doneText}. Известно: ${known.join(', ')}. Сейчас: ${s.nowText}.`;
        },
    },
    {
        // идея владельца: не отдельный блок, а метка NOW прямо в списке шагов
        key: 'F11 NOW внутри чек-листа',
        standalone: true,
        render: (s) => {
            const lines = [1, 2, 3, 4, 5, 6].map((n) => {
                const mark = s.done.includes(n) ? '[done]' : n === s.now ? '>>> NOW <<<' : '';
                return `${n}. ${mark} ${FULL_STEPS[n]}`.replace('  ', ' ');
            });
            return `## Flow
${lines.join('\n')}

Facts: name: ${s.facts.name ?? '—'} | instagram: ${s.facts.instagram ?? '—'} | guestlist: ${s.facts.guestlist ?? '—'} | table: ${s.facts.table} | companions: ${s.facts.companions}`;
        },
    },
    {
        key: 'F7 символьная нотация',
        render: (s) => {
            const glyphs = [1, 2, 3, 4, 5, 6]
                .map((n) => (s.done.includes(n) ? '✓' : n === s.now ? '►' : '·'))
                .join('');
            return `FLOW ⟦${glyphs}⟧  (✓ done · ► now · · pending)
FACTS name:${s.facts.name ?? '∅'} | ig:${s.facts.instagram ?? '∅'} | gl:${s.facts.guestlist ?? '∅'} | tbl:${s.facts.table === 'raised' ? '±' : '∅'} | comp:${s.facts.companions}
NOW ►${s.now} ${s.nowText}`;
        },
    },
    {
        key: 'F8 S-выражения',
        render: (s) =>
            `(state
  (done ${s.done.map((n) => STEPS[n].split(' ')[0]).join(' ')})
  (now :step ${s.now} :action "${s.nowText}")
  (facts (name ${s.facts.name ? `"${s.facts.name}"` : 'nil'}) (instagram ${s.facts.instagram ? `"${s.facts.instagram}"` : 'nil'}) (guestlist ${s.facts.guestlist ? `"${s.facts.guestlist}"` : 'nil'}) (table ${s.facts.table === 'raised' ? 't' : 'nil'}) (companions "${s.facts.companions}")))`,
    },
    {
        key: 'F9 YAML',
        render: (s) =>
            `state:
  done: [${s.done.map((n) => STEPS[n]).join(', ')}]
  now: ${s.nowText}
  facts:
    name: ${s.facts.name ?? 'null'}
    instagram: ${s.facts.instagram ?? 'null'}
    guestlist: ${s.facts.guestlist ?? 'null'}
    table: ${s.facts.table}
    companions: ${s.facts.companions}`,
    },
    {
        key: 'F10 императив + причина',
        render: (s) =>
            `NOW: ${s.nowText}
BECAUSE: ${s.facts.companions !== 'none' ? `companions declared but not all named (${s.facts.companions})` : `it is the first unfinished step`}
DONE: ${s.done.map((n) => STEPS[n]).join('; ')}
FACTS: name=${s.facts.name ?? 'null'} instagram=${s.facts.instagram ?? 'null'} guestlist=${s.facts.guestlist ?? 'null'} table=${s.facts.table} companions=${s.facts.companions}`,
    },
    {
        // гибрид: структура как у F1, но шаги названы словами, а не номерами
        key: 'F6 структура + именованные шаги',
        render: (s) =>
            `State: name: ${s.facts.name ?? '—'} | instagram: ${s.facts.instagram ?? '—'} | guestlist: ${s.facts.guestlist ?? '—'} | table: ${s.facts.table} | companions: ${s.facts.companions}
Done: ${s.done.map((n) => STEPS[n]).join('; ')}
Now: ${s.nowText}`,
    },
];

interface Scenario {
    key: string;
    state: State;
    messages: Anthropic.MessageParam[];
    /** true = форма отработала правильно */
    check: (out: { replies: string[]; toolCalls: string[] }) => boolean;
}

const SCENARIOS: Scenario[] = [
    {
        key: 'не переспрашивать имя',
        state: {
            facts: {
                name: 'Игорь Гордилов',
                instagram: null,
                guestlist: 'LYLO',
                table: 'not raised',
                companions: 'none',
            },
            done: [1, 2, 3, 4],
            now: 5,
            nowText: STEPS[5],
        },
        messages: [
            { role: 'user', content: 'привет, хочу на вечеринку' },
            { role: 'assistant', content: 'Привет! В эту субботу LYLO' },
            { role: 'user', content: 'Игорь Гордилов' },
            { role: 'assistant', content: 'Всё, добавил тебя. Вход бесплатный до 12:00' },
            { role: 'user', content: 'ага' },
        ],
        check: (out) => !/имя\s+фамили|name and surname/i.test(out.replies.join(' ')),
    },
    {
        key: 'инста необязательна — не ждать ответа',
        state: {
            facts: {
                name: 'Игорь Гордилов',
                instagram: null,
                guestlist: null,
                table: 'not raised',
                companions: 'none',
            },
            done: [1, 2, 3],
            now: 4,
            nowText: STEPS[4],
        },
        messages: [
            { role: 'user', content: 'привет, хочу на LYLO' },
            { role: 'assistant', content: 'Привет! LYLO в субботу' },
            { role: 'user', content: 'Игорь Гордилов' },
        ],
        check: (out) => out.toolCalls.includes('add_to_guestlist'),
    },
    {
        key: 'вопрос не по повестке — ответить и продолжить',
        state: {
            facts: {
                name: 'Игорь Гордилов',
                instagram: null,
                guestlist: 'LYLO',
                table: 'not raised',
                companions: 'none',
            },
            done: [1, 2, 3, 4],
            now: 5,
            nowText: STEPS[5],
        },
        messages: [
            { role: 'user', content: 'привет' },
            { role: 'assistant', content: 'Привет! Всё, добавил тебя на LYLO' },
            { role: 'user', content: 'а музыка там какая?' },
        ],
        check: (out) => /house|техно|techno|deep|минимал|музык/i.test(out.replies.join(' ')),
    },
    {
        key: '+1 — спросить имя спутника',
        state: {
            facts: {
                name: 'Игорь Гордилов',
                instagram: null,
                guestlist: null,
                table: 'not raised',
                companions: '1 unnamed',
            },
            done: [1, 2],
            now: 3,
            nowText: STEPS[3],
        },
        messages: [
            { role: 'user', content: 'привет, хочу на LYLO' },
            { role: 'assistant', content: 'Привет! LYLO в субботу' },
            { role: 'user', content: 'Игорь Гордилов, нас будет двое' },
        ],
        check: (out) => /имя|зовут|name/i.test(out.replies.join(' ')),
    },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.ANTHROPIC_MODEL ?? '';
const tools = Agent.toolDefs.filter((t) =>
    ['send_message', 'get_parties', 'update_guest', 'add_to_guestlist'].includes(t.name),
);

const fakeTool = (name: string): unknown => {
    if (name === 'get_parties') {
        return {
            parties: [
                {
                    party_id: 'lylo',
                    name: 'LYLO',
                    location: 'Club Vista Mare, Palm Jumeirah',
                    notes: 'Закрытый speakeasy внутри ресторана. Deep house и minimal techno. Прохладно, кондиционеры.',
                },
            ],
            assets: { instagram: 'https://www.instagram.com/weare.wrld/' },
        };
    }
    return { ok: true };
};

const runOnce = async (tail: string, base: Anthropic.MessageParam[]) => {
    const replies: string[] = [];
    const toolCalls: string[] = [];
    const messages = [...base];

    for (let step = 0; step < 6; step++) {
        const response = await client.messages.create({
            model,
            max_tokens: Agent.MAX_TOKENS,
            system: [
                { type: 'text', text: Agent.system, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: tail },
            ],
            tools,
            messages,
        });
        messages.push({ role: 'assistant', content: response.content });
        const uses = response.content.filter((b) => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || !uses.length) {
            if (!replies.length) {
                for (const block of response.content) {
                    if (block.type === 'text' && block.text.trim()) replies.push(block.text.trim());
                }
            }
            break;
        }
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
            toolCalls.push(use.name);
            if (use.name === 'send_message') {
                replies.push(...((use.input as { texts?: string[] }).texts ?? []));
            }
            results.push({
                type: 'tool_result',
                tool_use_id: use.id,
                content: JSON.stringify(
                    use.name === 'send_message' ? { ok: true } : fakeTool(use.name),
                ),
            });
        }
        messages.push({ role: 'user', content: results });
    }
    return { replies, toolCalls };
};

const startedAt = process.hrtime();
const board: { key: string; score: number; detail: string[] }[] = [];

const active = ONLY ? SCENARIOS.filter((s) => s.key.includes(ONLY)) : SCENARIOS;
/** FONLY=F4,F6,F7 — прогнать только эти форматы */
const keys = process.env.FONLY?.split(',') ?? null;
const formats = keys ? FORMATS.filter((f) => keys.some((k) => f.key.startsWith(k))) : FORMATS;

for (const format of formats) {
    let score = 0;
    const detail: string[] = [];
    for (const scenario of active) {
        const tail = `${CLEAN && !format.standalone ? `${CHECKLIST}\n\n` : ''}${format.render(scenario.state)}\n\nDo the "Now" step. If the guest just asked something, answer it first, in the same reply.`;
        let passed = 0;
        for (let rep = 0; rep < REPS; rep++) {
            const out = await runOnce(tail, scenario.messages);
            if (scenario.check(out)) passed++;
        }
        score += passed;
        detail.push(`${scenario.key} ${passed}/${REPS}`);
    }
    board.push({ key: format.key, score, detail });
    console.log(`${format.key}: ${score}/${active.length * REPS}`);
    for (const line of detail) console.log(`    ${line}`);
}

const [sec, nano] = process.hrtime(startedAt);
console.log(`\n=== итог ===`);
for (const row of [...board].sort((a, b) => b.score - a.score)) {
    console.log(`${row.score}/${active.length * REPS}  ${row.key}`);
}
console.log(`[probe7] ${sec}s ${Math.round(nano / 1e6)}ms`);
