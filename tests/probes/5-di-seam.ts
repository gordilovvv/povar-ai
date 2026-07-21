/**
 * Проба 5: шов вместо чёрной коробки.
 * runTurn(ctx, deps) — тот же цикл, но клиент и тулы приходят снаружи.
 * Гоняем офлайн на скриптованном клиенте: логика ретрая и текста мимо
 * send_message сегодня не покрыта ничем, потому что подменить нечего.
 */
import type Anthropic from '@anthropic-ai/sdk';

const IMAGE_PLACEHOLDER = '[table map image]';
const MAX_STEPS = 12;

interface Deps {
    /** ровно то, что дёргает прод: messages.create */
    createMessage: (messages: Anthropic.MessageParam[]) => Promise<Anthropic.Message>;
    runTool: (name: string, input: unknown, replies: string[]) => Promise<unknown>;
}

interface TurnResult {
    replies: string[];
    steps: number;
    retriedEmptyReply: boolean;
    toolCalls: string[];
}

/** Предлагаемая форма: цикл ничего не импортирует сам, всё приходит в deps. */
const runTurn = async (messages: Anthropic.MessageParam[], deps: Deps): Promise<TurnResult> => {
    const replies: string[] = [];
    const toolCalls: string[] = [];
    let retriedEmptyReply = false;
    let steps = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
        steps = step + 1;
        const response = await deps.createMessage(messages);
        messages.push({ role: 'assistant', content: response.content });

        const toolUses = response.content.filter((block) => block.type === 'tool_use');

        if (response.stop_reason !== 'tool_use' || !toolUses.length) {
            const hasTextReply = replies.some((text) => text !== IMAGE_PLACEHOLDER);
            if (!hasTextReply) {
                const bubbles: string[] = [];
                for (const block of response.content) {
                    if (block.type !== 'text') continue;
                    for (const line of block.text.split('\n')) {
                        const bubble = line.trim();
                        if (bubble) bubbles.push(bubble);
                    }
                }
                if (bubbles.length) {
                    await deps.runTool('send_message', { texts: bubbles }, replies);
                }
            }
            if (!replies.some((text) => text !== IMAGE_PLACEHOLDER) && !retriedEmptyReply) {
                retriedEmptyReply = true;
                messages.push({
                    role: 'user',
                    content: '(You did not message the guest. Reply now via send_message.)',
                });
                continue;
            }
            break;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
            toolCalls.push(toolUse.name);
            const output = await deps.runTool(toolUse.name, toolUse.input, replies);
            results.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(output),
            });
        }
        messages.push({ role: 'user', content: results });
    }

    return { replies, steps, retriedEmptyReply, toolCalls };
};

const say = (blocks: Anthropic.ContentBlock[], stop: Anthropic.Message['stop_reason']) =>
    ({ content: blocks, stop_reason: stop, usage: {} }) as Anthropic.Message;

const text = (value: string) => ({ type: 'text', text: value }) as Anthropic.ContentBlock;
const toolUse = (name: string, input: unknown, id = name) =>
    ({ type: 'tool_use', id, name, input }) as Anthropic.ContentBlock;

const fakeTools: Deps['runTool'] = async (name, input, replies) => {
    if (name === 'send_message') {
        const texts = (input as { texts?: string[] }).texts ?? [];
        replies.push(...texts);
        return { ok: true, sent: texts.length };
    }
    if (name === 'show_tables') {
        replies.push(IMAGE_PLACEHOLDER);
        return { ok: true, image_sent: true };
    }
    return { ok: true };
};

const scripted = (script: Anthropic.Message[]): Deps['createMessage'] => {
    let index = 0;
    return async () => script[Math.min(index++, script.length - 1)];
};

interface Check {
    name: string;
    script: Anthropic.Message[];
    assert: (result: TurnResult) => string | null;
}

const CHECKS: Check[] = [
    {
        name: 'обычный ответ через send_message',
        script: [
            say([toolUse('send_message', { texts: ['Привет'] })], 'tool_use'),
            say([text('')], 'end_turn'),
        ],
        assert: (r) =>
            r.replies.join() === 'Привет'
                ? null
                : `ждали ["Привет"], получили ${JSON.stringify(r.replies)}`,
    },
    {
        name: 'текст мимо send_message не теряется',
        script: [say([text('Привет\nКак ты?')], 'end_turn')],
        assert: (r) =>
            r.replies.length === 2 && r.replies[0] === 'Привет'
                ? null
                : `ждали 2 баббла, получили ${JSON.stringify(r.replies)}`,
    },
    {
        name: 'пустой ход — ровно один ретрай, потом сдаёмся',
        script: [say([], 'end_turn')],
        assert: (r) =>
            r.retriedEmptyReply && r.steps === 2
                ? null
                : `ждали retried=true steps=2, получили retried=${r.retriedEmptyReply} steps=${r.steps}`,
    },
    {
        name: 'картинка без текста ответом не считается — ретрай срабатывает',
        script: [
            say([toolUse('show_tables', {})], 'tool_use'),
            say([], 'end_turn'),
            say([toolUse('send_message', { texts: ['Вот карта'] }, 'x')], 'tool_use'),
            say([], 'end_turn'),
        ],
        assert: (r) =>
            r.retriedEmptyReply && r.replies.includes('Вот карта')
                ? null
                : `ждали ретрай и текст после картинки, получили ${JSON.stringify(r.replies)}`,
    },
    {
        name: 'зацикливание обрезается по MAX_STEPS',
        script: [say([toolUse('get_parties', {})], 'tool_use')],
        assert: (r) =>
            r.steps === MAX_STEPS ? null : `ждали ${MAX_STEPS} шагов, получили ${r.steps}`,
    },
];

const startedAt = process.hrtime();
let failures = 0;

for (const check of CHECKS) {
    const result = await runTurn([{ role: 'user', content: 'привет' }], {
        createMessage: scripted(check.script),
        runTool: fakeTools,
    });
    const problem = check.assert(result);
    if (problem) {
        failures++;
        console.log(`❌ ${check.name}\n     ${problem}`);
    } else {
        console.log(`✅ ${check.name}`);
    }
}

const [sec, nano] = process.hrtime(startedAt);
console.log(
    `\n[probe5] ${CHECKS.length - failures}/${CHECKS.length} прошли, 0 запросов к API, ${sec}s ${Math.round(nano / 1e6)}ms`,
);
