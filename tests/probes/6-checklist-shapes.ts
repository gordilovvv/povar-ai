/**
 * Проба 6: сравнение форм чек-листа на бумаге.
 * Один и тот же сценарий, пять разных блоков состояния.
 * Меряем, что бот реально делает, когда висят два шага и вопрос гостя.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Agent } from '#Intelligence/Agent.js';

const REPS = 3;
const ASSET_INSTAGRAM = 'https://www.instagram.com/weare.wrld/';

/** Сценарий: имя есть, в гест-листе, инсты нет, приглашение не слали, гость спросил про духоту. */
const GUEST_QUESTION = 'а там кондиционеры есть? не люблю духоту';

const VARIANTS: { key: string; tail: string }[] = [
    {
        key: 'current — как в проде',
        tail: `Flow state (computed from the real saved state and chat — trust it over your own reading):
[✓] name — collected
[✓] guestlist — added
[→] ask for the guest's instagram; if the guest just asked a question, answer it AND ask in the SAME reply
[→] after the guestlist confirm: send the instagram follow-up with the link, unprompted
Do the [→] steps (after handling what the guest just said). [✗] and […] are hard constraints — never violate them.`,
    },
    {
        key: 'A — одно действие',
        tail: `Состояние диалога (факты, доверяй им больше своего чтения):
имя — есть
гест-лист — есть
инста — нет
инста-приглашение — не отправляли
стол — не обсуждали

Следующий шаг: спроси инстаграм.
Если гость только что задал вопрос — сначала ответь на него, шаг вплети в тот же ответ.`,
    },
    {
        key: 'B — стабильная таблица',
        tail: `Состояние диалога:
[✓] имя
[✓] гест-лист
[→] инста
[ ] инста-приглашение
[ ] стол

Делай ровно один шаг [→]. Сначала ответь на то, что гость только что спросил.`,
    },
    {
        key: 'C — гость и повестка',
        tail: `Гость ждёт ответа на: вопрос про кондиционеры и духоту.
Наша повестка: собрать инстаграм.

Пройдено: имя, гест-лист.
Не сделано: инста, инста-приглашение, стол.

Сначала гость, потом повестка — в одном ответе.`,
    },
    {
        key: 'D — только факты, без повестки',
        tail: `Известно о госте: имя есть; инсты нет; в гест-листе на LYLO; приглашение в инсту не отправляли; стол не обсуждали.`,
    },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.ANTHROPIC_MODEL ?? '';

const tools: Anthropic.Tool[] = Agent.toolDefs.filter((t) =>
    ['send_message', 'get_parties', 'update_guest'].includes(t.name),
);

const fakeTool = (name: string): unknown => {
    if (name === 'get_parties') {
        return {
            parties: [
                {
                    party_id: 'lylo',
                    name: 'LYLO',
                    location: 'LYLO, Club Vista Mare, Palm Jumeirah',
                    notes: 'Закрытое помещение, прохладно, кондиционеры, комфортно. Deep house.',
                },
            ],
            assets: { instagram: ASSET_INSTAGRAM },
        };
    }
    return { ok: true };
};

const runOnce = async (tail: string): Promise<string[]> => {
    const replies: string[] = [];
    const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: 'привет, хочу на вечеринку' },
        { role: 'assistant', content: 'Привет! Рад что написал' },
        { role: 'user', content: 'Игорь Гордилов' },
        { role: 'assistant', content: 'Всё, добавил тебя. Вход бесплатный до 12:00' },
        { role: 'user', content: GUEST_QUESTION },
    ];

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
        const uses = response.content.filter((block) => block.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || !uses.length) {
            // как в Agent.do: текст мимо send_message тоже считается ответом
            if (!replies.length) {
                for (const block of response.content) {
                    if (block.type !== 'text') continue;
                    for (const line of block.text.split('\n')) {
                        const bubble = line.trim();
                        if (bubble) replies.push(bubble);
                    }
                }
            }
            break;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
            if (use.name === 'send_message') {
                const texts = (use.input as { texts?: string[] }).texts ?? [];
                replies.push(...texts);
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
    return replies;
};

const startedAt = process.hrtime();

for (const variant of VARIANTS) {
    const tally = { answered: 0, askedInsta: 0, sentFollowup: 0, bubbles: 0 };
    for (let rep = 0; rep < REPS; rep++) {
        const replies = await runOnce(variant.tail);
        const joined = replies.join(' | ').toLowerCase();
        if (/кондиционер|прохладн|комфортн|духот|не жарк/.test(joined)) tally.answered++;
        if (/инстаграм|инсту|instagram/.test(joined) && !joined.includes(ASSET_INSTAGRAM))
            tally.askedInsta++;
        if (joined.includes(ASSET_INSTAGRAM.toLowerCase())) tally.sentFollowup++;
        tally.bubbles += replies.length;
    }
    console.log(
        `${variant.key}\n  ответил на вопрос ${tally.answered}/${REPS} · спросил инсту ${tally.askedInsta}/${REPS} · слал приглашение ${tally.sentFollowup}/${REPS} · бабблов в среднем ${(tally.bubbles / REPS).toFixed(1)}`,
    );
}

const [sec, nano] = process.hrtime(startedAt);
console.log(
    `\n[probe6] ${VARIANTS.length} форм × ${REPS} прогонов, ${sec}s ${Math.round(nano / 1e6)}ms`,
);
