import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent, type TurnDeps } from '#Intelligence/Agent.js';
import type { ToolContext } from '#Intelligence/Tools/Types.js';

const reply = (
    content: Anthropic.ContentBlock[],
    stopReason: Anthropic.Message['stop_reason'],
    cache: { read: number; write: number } = { read: 0, write: 0 },
): Anthropic.Message => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: cache.read,
        cache_creation_input_tokens: cache.write,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
    },
});

const text = (value: string): Anthropic.ContentBlock => ({
    type: 'text',
    text: value,
    citations: null,
});

const toolUse = (name: string, input: unknown, id = 'tu_1'): Anthropic.ContentBlock => ({
    type: 'tool_use',
    id,
    name,
    input,
});

interface Harness {
    ctx: ToolContext;
    deps: TurnDeps;
    calls: { name: string; input: unknown }[];
    sent: Anthropic.MessageCreateParamsNonStreaming[];
}

const harness = (scripted: Anthropic.Message[], runTool?: TurnDeps['runTool']): Harness => {
    const calls: { name: string; input: unknown }[] = [];
    const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const ctx: ToolContext = { guestId: 'g1', phone: '10000000000', replies: [] };
    let step = 0;

    const deps: TurnDeps = {
        create: async (params) => {
            sent.push(structuredClone(params));
            const next = scripted[step];
            step++;
            assert.ok(next, `модель вызвана ${step} раз, а сценарий короче`);
            return next;
        },
        runTool: async (name, input, toolCtx) => {
            calls.push({ name, input });
            if (runTool) {
                return runTool(name, input, toolCtx);
            }
            if (name === 'send_message') {
                const texts = (input as { texts?: string[] }).texts ?? [];
                toolCtx.replies.push(...texts);
                return { ok: true, sent: texts.length };
            }
            return { ok: true };
        },
        toolDefs: [],
    };

    return { ctx, deps, calls, sent };
};

const run = (h: Harness) => Agent.runTurn([], [{ role: 'user', content: 'привет' }], h.ctx, h.deps);

describe('Agent.runTurn', () => {
    it('гоняет тул и возвращает результат модели следующим шагом', async () => {
        const h = harness([
            reply([toolUse('send_message', { texts: ['привет!'] })], 'tool_use'),
            reply([text('')], 'end_turn'),
        ]);

        const stats = await run(h);

        assert.deepEqual(h.ctx.replies, ['привет!']);
        assert.equal(h.calls.length, 1);
        assert.equal(stats.steps, 2);

        // история должна прирасти целиком: ход модели + результат тула
        const second = h.sent[1];
        assert.ok(second, 'второй запрос к модели не ушёл');
        assert.equal(second.messages.length, 3, 'ход ассистента потерян в истории');
        assert.equal(second.messages[0]?.role, 'user');
        assert.equal(second.messages[1]?.role, 'assistant');
        assert.equal(second.messages[2]?.role, 'user');

        const assistant = second.messages[1]?.content as Anthropic.ContentBlock[];
        assert.equal(assistant[0]?.type, 'tool_use');

        const blocks = second.messages[2]?.content as Anthropic.ToolResultBlockParam[];
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0]?.type, 'tool_result');
        assert.equal(blocks[0]?.tool_use_id, 'tu_1');
        assert.deepEqual(JSON.parse(String(blocks[0]?.content)), { ok: true, sent: 1 });
    });

    it('передаёт модели system и инвентарь тулов', async () => {
        const h = harness([
            reply([toolUse('send_message', { texts: ['ок'] })], 'tool_use'),
            reply([text('')], 'end_turn'),
        ]);
        const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: 'ты Сёма' }];
        const defs: Anthropic.Tool[] = [
            { name: 'send_message', description: 'шлёт', input_schema: { type: 'object' } },
        ];
        h.deps.toolDefs = defs;

        await Agent.runTurn(system, [{ role: 'user', content: 'привет' }], h.ctx, h.deps);

        const first = h.sent[0];
        assert.deepEqual(first?.system, system, 'system не доехал до модели');
        assert.deepEqual(first?.tools, defs, 'инвентарь тулов не доехал до модели');
        assert.equal(first?.max_tokens, Agent.MAX_TOKENS);
    });

    it('обрыв по max_tokens с недописанным tool_use — тулы НЕ исполняются', async () => {
        const h = harness([
            reply([toolUse('book_table', { party_id: 'lylo' })], 'max_tokens'),
            reply([toolUse('send_message', { texts: ['секунду'] })], 'tool_use'),
            reply([text('')], 'end_turn'),
        ]);

        await run(h);

        assert.ok(
            !h.calls.some((c) => c.name === 'book_table'),
            'тул с оборванного хода исполнять нельзя — аргументы могут быть недописаны',
        );
    });

    it('несколько тулов в одном ходе — все исполнены, все результаты одним сообщением', async () => {
        const h = harness([
            reply(
                [
                    toolUse('get_parties', {}, 'tu_a'),
                    toolUse('send_message', { texts: ['вот вечеринки'] }, 'tu_b'),
                ],
                'tool_use',
            ),
            reply([text('')], 'end_turn'),
        ]);

        await run(h);

        assert.deepEqual(
            h.calls.map((c) => c.name),
            ['get_parties', 'send_message'],
        );
        const blocks = h.sent[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
        assert.equal(blocks.length, 2, 'результаты обоих тулов должны уйти одним сообщением');
        assert.deepEqual(
            blocks.map((b) => b.tool_use_id),
            ['tu_a', 'tu_b'],
        );
    });

    it('неизвестный тул не роняет ход — liveDeps отвечает unknown_tool', async () => {
        const ctx: ToolContext = { guestId: 'g1', phone: '1', replies: [] };
        const output = await Agent.liveDeps.runTool('нет_такого_тула', {}, ctx);

        assert.deepEqual(output, { ok: false, error: 'unknown_tool' });
    });

    it('падение похода в модель летит наверх — ход не глушится', async () => {
        const h = harness([]);
        h.deps.create = async () => {
            throw new Error('anthropic 500');
        };

        await assert.rejects(() => run(h), /anthropic 500/);
    });

    it('подхватывает текст мимо send_message и шлёт его сам', async () => {
        const h = harness([reply([text('строка одна\n\nстрока два')], 'end_turn')]);

        await run(h);

        assert.deepEqual(h.calls, [
            { name: 'send_message', input: { texts: ['строка одна', 'строка два'] } },
        ]);
        assert.deepEqual(h.ctx.replies, ['строка одна', 'строка два']);
    });

    it('пустой ход — один раз подталкивает и не зацикливается', async () => {
        const h = harness([reply([], 'end_turn'), reply([], 'end_turn')]);

        const stats = await run(h);

        assert.equal(stats.steps, 2, 'подталкивание должно случиться ровно один раз');
        assert.deepEqual(h.ctx.replies, []);
        assert.deepEqual(h.calls, [], 'на пустом ходе send_message дёргать нечем');

        const nudge = h.sent[1]?.messages.at(-1);
        assert.equal(nudge?.role, 'user');
        assert.match(String(nudge?.content), /did not message the guest/i);
    });

    it('упавший тул роняет ход — ошибка летит наверх, а не пересказывается модели', async () => {
        const h = harness(
            [
                reply([toolUse('save_guest', { party_id: 'lylo' })], 'tool_use'),
                reply([toolUse('send_message', { texts: ['извини, не вышло'] })], 'tool_use'),
                reply([text('')], 'end_turn'),
            ],
            async (name, _input, toolCtx) => {
                if (name === 'save_guest') {
                    throw new Error('db is down');
                }
                toolCtx.replies.push('извини, не вышло');
                return { ok: true };
            },
        );

        await assert.rejects(
            run(h),
            /db is down/,
            'сломанная инфраструктура должна ронять процесс, а не превращаться в вежливый ответ гостю',
        );
        assert.deepEqual(h.ctx.replies, [], 'после броска гостю ничего не уходит');
    });

    it('не крутится дольше MAX_STEPS, если модель зациклилась на тулах', async () => {
        const loop = Array.from({ length: Agent.MAX_STEPS + 5 }, () =>
            reply([toolUse('get_parties', {})], 'tool_use'),
        );
        const h = harness(loop);

        const stats = await run(h);

        assert.equal(stats.steps, Agent.MAX_STEPS);
        assert.equal(h.calls.length, Agent.MAX_STEPS);
    });

    it('складывает токены со всех шагов, включая кеш', async () => {
        const h = harness([
            reply([toolUse('get_parties', {})], 'tool_use', { read: 100, write: 7 }),
            reply([toolUse('send_message', { texts: ['ок'] })], 'tool_use', {
                read: 200,
                write: 3,
            }),
            reply([text('')], 'end_turn', { read: 400, write: 0 }),
        ]);

        const stats = await run(h);

        assert.equal(stats.steps, 3);
        assert.equal(stats.inputTokens, 30);
        assert.equal(stats.outputTokens, 15);
        assert.equal(stats.cacheRead, 700);
        assert.equal(stats.cacheWrite, 10);
    });
});
