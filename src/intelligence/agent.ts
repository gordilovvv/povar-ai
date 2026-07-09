import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../../environment.ts';
import type { PartyGuestlistStorage } from '../db/guestlist.ts';
import type { GuestStorage } from '../db/guests.ts';
import type { WaMessageStorage } from '../db/wa-messages.ts';
import { toolsByName, tools as toolsList } from './tools/index.ts';
import sendMessage from './tools/sendMessage.ts';
import { IMAGE_PLACEHOLDER } from './tools/showTables.ts';
import type { ToolContext } from './tools/types.ts';

export interface ChatContext {
    guest: GuestStorage;
    messages: WaMessageStorage[];
    ownedGuestlist: PartyGuestlistStorage[];
    now: string;
}

export class Agent {
    static client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    static system = readFileSync(join(import.meta.dirname, 'system.md'), 'utf8');

    static toolDefs: Anthropic.Tool[] = toolsList.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: z.toJSONSchema(tool.input) as Anthropic.Tool.InputSchema,
    }));

    static MAX_STEPS = 12;
    static MAX_TOKENS = 1024;

    static async do(context: ChatContext): Promise<string[]> {
        const replies: string[] = [];
        const ctx: ToolContext = {
            guestId: context.guest.id,
            phone: context.guest.wa_phone ?? '',
            replies,
        };

        const startedAt = process.hrtime();
        const messages = Agent.buildMessages(context.messages);
        const system = Agent.buildSystem(context);

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let retriedEmptyReply = false;

        let steps = 0;

        for (let step = 0; step < Agent.MAX_STEPS; step++) {
            steps = step + 1;
            const response = await Agent.client.messages.create({
                model: env.ANTHROPIC_MODEL,
                max_tokens: Agent.MAX_TOKENS,
                system,
                tools: Agent.toolDefs,
                messages,
            });
            messages.push({ role: 'assistant', content: response.content });
            inputTokens += response.usage.input_tokens;
            outputTokens += response.usage.output_tokens;
            cacheRead += response.usage.cache_read_input_tokens ?? 0;
            cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

            const toolUses = response.content.filter((block) => block.type === 'tool_use');
            console.log(
                `[agent] ${ctx.phone} step ${step} stop=${response.stop_reason} tools=${toolUses.map((t) => t.name).join(',') || '-'} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
            );

            if (response.stop_reason !== 'tool_use' || !toolUses.length) {
                // картинка без текста ответом не считается
                const hasTextReply = replies.some((text) => text !== IMAGE_PLACEHOLDER);
                // модель ответила текстом мимо send_message, не теряем реплику — шлём сами
                if (!hasTextReply) {
                    const bubbles: string[] = [];
                    for (const block of response.content) {
                        if (block.type !== 'text') {
                            continue;
                        }
                        for (const line of block.text.split('\n')) {
                            const bubble = line.trim();
                            if (bubble) {
                                bubbles.push(bubble);
                            }
                        }
                    }
                    if (bubbles.length) {
                        await sendMessage.handler(ctx, { texts: bubbles });
                    }
                }
                // модель завершила ход, не написав гостю — один раз подталкиваем ответить
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
                const tool = toolsByName.get(toolUse.name);
                let output: unknown;
                try {
                    output = tool
                        ? await tool.handler(ctx, toolUse.input)
                        : { ok: false, error: 'unknown_tool' };
                } catch (error) {
                    console.error(`[agent] ${ctx.phone} tool ${toolUse.name} threw`, error);
                    output = { ok: false, error: 'tool_failed' };
                }
                console.log(
                    `[agent] ${ctx.phone} tool ${toolUse.name} → ${JSON.stringify(output)}`,
                );
                results.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(output),
                });
            }
            messages.push({ role: 'user', content: results });
        }

        const [sec, nano] = process.hrtime(startedAt);
        console.log(
            `[agent] ${ctx.phone} turn done: ${steps} steps, ${replies.length} replies, ${sec}s ${Math.round(nano / 1e6)}ms, tokens in=${inputTokens} cacheR=${cacheRead} cacheW=${cacheWrite} out=${outputTokens}`,
        );

        return replies;
    }

    static buildMessages(history: WaMessageStorage[]): Anthropic.MessageParam[] {
        const messages: Anthropic.MessageParam[] = [];
        for (const message of history) {
            if (!message.text) {
                continue;
            }
            messages.push({
                role: message.owner === 'guest' ? 'user' : 'assistant',
                content: message.text,
            });
        }
        const last = messages[messages.length - 1];
        if (last?.role !== 'user') {
            messages.push({
                role: 'user',
                content: '(the guest is silent — open the dialog with a warm greeting)',
            });
        }
        return messages;
    }

    static buildSystem = (context: ChatContext): Anthropic.TextBlockParam[] => {
        const lang = context.guest.lang || 'en';
        const langLine =
            lang === 'en'
                ? 'The guest writes in ENGLISH — reply ONLY in English, not a word of Russian.'
                : 'The guest writes in RUSSIAN — reply in Russian.';

        const known: string[] = [];
        if (context.guest.first_name) known.push(`first name: ${context.guest.first_name}`);
        if (context.guest.last_name) known.push(`last name: ${context.guest.last_name}`);
        if (context.guest.instagram_url) known.push(`instagram: ${context.guest.instagram_url}`);
        if (context.guest.came_from === 'ad') known.push('came from an ad');

        const onLists: string[] = [];
        for (const entry of context.ownedGuestlist) {
            const booked = entry.booked_table ? ' (table booked)' : '';
            onLists.push(`party ${entry.party_id}${booked}`);
        }

        const tail = [
            `Language: ${langLine}`,
            `Known about guest: ${known.length ? known.join('; ') : 'nothing yet — collect name and instagram'}`,
            `On guestlists: ${onLists.length ? onLists.join('; ') : 'none'}`,
            Agent.buildFlowState(context),
            `Dubai time now: ${context.now}.`,
        ].join('\n');

        return [
            { type: 'text', text: Agent.system, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: tail },
        ];
    };

    static buildFlowState = (context: ChatContext): string => {
        const semaTexts: string[] = [];
        const guestTexts: string[] = [];
        for (const message of context.messages) {
            if (!message.text) {
                continue;
            }
            if (message.owner === 'sema') {
                semaTexts.push(message.text);
            }
            if (message.owner === 'guest') {
                guestTexts.push(message.text);
            }
        }

        const nameDone = !!context.guest.first_name;
        const guestlistDone = context.ownedGuestlist.length > 0;
        const instaDone = !!context.guest.instagram_url;
        // вопрос про инсту гостя, но не follow-up с нашей ссылкой/подпиской
        const instaAsked = semaTexts.some(
            (t) => /инст|insta/i.test(t) && !/подпи|follow|instagram\.com/i.test(t),
        );
        const followupDone = semaTexts.some((t) => t.includes('instagram.com'));
        const tableBooked = context.ownedGuestlist.some((entry) => entry.booked_table);
        const tableAsked = guestTexts.some((t) => /стол|table/i.test(t));
        // стол считаем обсуждаемым по репликам гостя — свой безответный оффер не в счёт
        const tableTalk = tableBooked || tableAsked;

        const lines: string[] = [];
        if (tableBooked) {
            lines.push('[✓] table — booked');
        } else if (tableAsked) {
            lines.push(
                '[→] TABLE — the guest is asking about a table: acknowledge it in your VERY NEXT reply and drive to the booking. Name → guestlist are prerequisites for book_table — weave them into the table flow, never answer with the guestlist pitch alone. Instagram is NOT a prerequisite — never gate the booking on it. Once the guest agrees and the party + size are known from the chat — call book_table immediately, no extra clarifying questions.',
            );
        }
        lines.push(
            nameDone
                ? '[✓] name — collected'
                : '[→] collect first+last name ("пришли имя фамилию")',
        );
        if (guestlistDone) {
            lines.push('[✓] guestlist — added');
        } else if (nameDone) {
            lines.push(
                '[→] add to guestlist silently + confirm with entry conditions; if the party is unclear, fork: ask which party — nothing else',
            );
        } else {
            lines.push('[ ] guestlist — after the name');
        }
        if (instaDone) {
            lines.push('[✓] instagram — collected');
        } else if (instaAsked) {
            lines.push(
                '[…] instagram — ALREADY ASKED, awaiting answer. Do NOT repeat the question now. If the guest ignored it, move on; you may weave ONE soft re-ask into a later reply when the guest is engaged again.',
            );
        } else if (guestlistDone) {
            lines.push(
                "[→] ask for the guest's instagram; if the guest just asked a question, answer it AND ask in the SAME reply",
            );
        } else {
            lines.push('[ ] instagram — later');
        }
        if (tableTalk) {
            lines.push(
                '[✗] instagram follow-up — SKIP: a table is discussed/booked. Do NOT send the insta link.',
            );
        } else if (followupDone) {
            lines.push('[✓] instagram follow-up — sent');
        } else if (guestlistDone) {
            lines.push(
                '[→] after the guestlist confirm: send the instagram follow-up with the link, unprompted',
            );
        } else {
            lines.push('[ ] instagram follow-up — later');
        }

        const anyCurrent = lines.some((line) => line.startsWith('[→]'));
        const footer = anyCurrent
            ? 'Do the [→] steps (after handling what the guest just said). [✗] and […] are hard constraints — never violate them.'
            : 'Nothing pending. Fork: EITHER offer a table once (if not offered yet) OR just close warm.';
        return `Flow state (computed from the real saved state and chat — trust it over your own reading):\n${lines.join('\n')}\n${footer}`;
    };
}
