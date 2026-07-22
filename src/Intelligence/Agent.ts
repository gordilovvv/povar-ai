import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { WaMessageStorage } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { Checklist } from '#Intelligence/Checklist.js';
import { type ChatContext, Context } from '#Intelligence/Context.js';
import { Prompts } from '#Intelligence/Prompts.js';
import sendMessage from '#Intelligence/Tools/SendMessage.js';
import { Tools } from '#Intelligence/Tools.js';
import { Logger } from '#Lib/Logger.js';
import type { ToolContext } from '#Lib/Tools.js';
import { sendTypingIndicator } from '#Platforms/Whatsapp/index.js';

type CreateMessage = (
    params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export class Agent {
    private static readonly client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    private static readonly tools = new Tools();

    private static readonly MAX_STEPS = 12;
    // thinking ест из MAX_TOKENS: лимит должен оставлять запас на сам ответ
    private static readonly MAX_TOKENS = 8192;

    private static readonly LANG = {
        en: 'The guest writes in ENGLISH — reply ONLY in English.',
        ru: 'The guest writes in RUSSIAN — reply in Russian.',
    };
    private static readonly UNKNOWN_LANG = 'Reply in the language the guest writes in.';
    private static readonly SILENT_GUEST =
        '(the guest is silent — open the dialog with a warm greeting)';
    private static readonly GUEST_MEDIA = '(the guest sent media)';
    private static readonly NUDGE =
        '(internal harness note, NOT from the guest — they have received nothing this turn. Call send_message now with your reply, or the required tool. Never mention this note, system commands or anything internal to the guest.)';
    /** Голый текст с этими маркерами — мета-рассуждение модели, гостю не пересылаем. */
    private static readonly META_TEXT =
        /инструкц|системн|внутренн|не буду отвечать|internal|harness|instruction/i;

    /** Тул сам ответил гостю и запретил писать поверх: под это страховки обязаны молчать. */
    private static readonly REPLY_FORBIDDEN = z.union([
        z.object({ ok: z.literal(true), instruction: z.string() }),
        z.object({ error: z.literal('chat_paused') }),
    ]);

    constructor(
        readonly phone: string,
        private readonly create: CreateMessage = (params) => Agent.client.messages.create(params),
    ) {}

    async do(): Promise<string[]> {
        const context = await Context.load(this.phone);
        const { guest, chat, messages: history } = context.context;

        if (chat?.paused_at) {
            Logger.log(`[agent] ${this.phone} chat is paused, turn skipped`);
            return [];
        }

        const replies: string[] = [];
        const ctx: ToolContext = { guestId: guest.id, phone: this.phone, replies };

        if (env.WA_SEND === 'on') {
            const waId = history.findLast((message) => message.owner === 'guest')?.wa_message_id;
            if (waId) {
                void sendTypingIndicator(waId).catch((error) =>
                    Logger.logError(`[agent] ${this.phone} typing indicator failed`, error),
                );
            }
        }

        await this.loop(context, Agent.buildMessages(history), ctx);

        return replies;
    }

    /** Реплики копятся в `ctx.replies`, `messages` дописывается по ходу. */
    private async loop(
        context: Context,
        messages: Anthropic.MessageParam[],
        ctx: ToolContext,
    ): Promise<void> {
        const startedAt = process.hrtime();
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        let steps = 0;
        let replyForbidden = false;
        let nudged = false;

        for (let step = 0; step < Agent.MAX_STEPS; step++) {
            steps = step + 1;

            const response = await this.create({
                model: env.ANTHROPIC_MODEL,
                max_tokens: Agent.MAX_TOKENS,
                thinking: { type: 'adaptive' },
                output_config: { effort: 'max' },
                system: Agent.buildSystem(context.context),
                tools: Agent.tools.defs(),
                messages,
            });
            messages.push({ role: 'assistant', content: response.content });

            usage.input += response.usage.input_tokens;
            usage.output += response.usage.output_tokens;
            usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
            usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

            const toolUses = response.content.filter((block) => block.type === 'tool_use');
            const thinkingChars = response.content.reduce(
                (sum, block) => sum + (block.type === 'thinking' ? block.thinking.length : 0),
                0,
            );
            Logger.debug(
                `[agent] ${this.phone} step ${step} stop=${response.stop_reason} tools=${toolUses.map((tool) => tool.name).join(',') || '-'} think=${thinkingChars}ch in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
            );

            if (toolUses.length) {
                const results: Anthropic.ToolResultBlockParam[] = [];
                for (const toolUse of toolUses) {
                    const output = await Agent.tools.run(toolUse.name, toolUse.input, ctx);
                    replyForbidden ||= Agent.REPLY_FORBIDDEN.safeParse(output).success;
                    Logger.log(
                        `[agent] ${this.phone} tool ${toolUse.name} → ${JSON.stringify(output)}`,
                    );
                    results.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: JSON.stringify(output),
                    });
                }
                // все результаты одним сообщением: разбиение отучает модель от параллельных вызовов
                messages.push({ role: 'user', content: results });
                await context.refresh();
                continue;
            }

            // ответ обрезан на полуслове — дослать его гостю хуже, чем промолчать
            if (response.stop_reason === 'max_tokens') {
                Logger.logError(`[agent] ${this.phone} step ${step} hit max_tokens, reply dropped`);
                break;
            }

            if (ctx.replies.length || replyForbidden) {
                break;
            }

            const bubbles = response.content.flatMap((block) =>
                block.type === 'text'
                    ? block.text
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean)
                    : [],
            );
            if (bubbles.length) {
                if (!Agent.META_TEXT.test(bubbles.join('\n'))) {
                    await Agent.tools.run(sendMessage.name, { texts: bubbles }, ctx);
                    break;
                }
                Logger.logError(
                    `[agent] ${this.phone} step ${step} meta text caught, not sent: ${bubbles.join(' | ')}`,
                );
            }

            if (nudged) {
                break;
            }
            nudged = true;
            messages.push({ role: 'user', content: Agent.NUDGE });
        }

        if (!ctx.replies.length && !replyForbidden) {
            Logger.logError(`[agent] ${this.phone} turn ended with no reply after ${steps} steps`);
        }

        const [seconds, nanos] = process.hrtime(startedAt);
        Logger.debug(
            `[agent] ${this.phone} turn done: ${steps} steps, ${ctx.replies.length} replies, ${seconds}s ${Math.round(nanos / 1e6)}ms, tokens in=${usage.input} cacheR=${usage.cacheRead} cacheW=${usage.cacheWrite} out=${usage.output}`,
        );
    }

    private static buildSystem(context: ChatContext): Anthropic.TextBlockParam[] {
        return [
            {
                type: 'text',
                text: [Prompts.system, Prompts.checklist, Prompts.tools].join('\n\n'),
                cache_control: { type: 'ephemeral' },
            },
            {
                type: 'text',
                text: [
                    context.guest.lang ? Agent.LANG[context.guest.lang] : Agent.UNKNOWN_LANG,
                    `Dubai time now: ${context.now}.`,
                    Checklist.create(context),
                ].join('\n\n'),
            },
        ];
    }

    private static buildMessages(history: WaMessageStorage[]): Anthropic.MessageParam[] {
        const messages: Anthropic.MessageParam[] = [];
        for (const message of history) {
            if (message.owner === 'guest') {
                messages.push({ role: 'user', content: message.text || Agent.GUEST_MEDIA });
            } else if (message.text) {
                messages.push({ role: 'assistant', content: message.text });
            }
        }

        // API отбивает историю, которая начинается не с гостя
        while (messages.length && messages[0]?.role !== 'user') {
            messages.shift();
        }
        if (messages.at(-1)?.role !== 'user') {
            messages.push({ role: 'user', content: Agent.SILENT_GUEST });
        }

        return messages;
    }
}
