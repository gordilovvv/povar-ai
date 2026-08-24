import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import pauseChat from '#Intelligence/Tools/PauseChat.js';
import saveGuest from '#Intelligence/Tools/SaveGuest.js';
import sendMessage from '#Intelligence/Tools/SendMessage.js';
import type { AgentTool, ToolContext } from '#Lib/Tools.js';

export class Tools {
    private static readonly BUILTIN: AgentTool[] = [sendMessage, pauseChat, saveGuest];

    private readonly byName: Map<string, AgentTool>;
    private readonly toolDefs: Anthropic.Tool[];

    constructor(tools: AgentTool[] = Tools.BUILTIN) {
        this.byName = new Map(tools.map((tool) => [tool.name, tool]));
        if (this.byName.size !== tools.length) {
            throw new Error('Duplicate tool name');
        }
        this.toolDefs = tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: z.toJSONSchema(tool.input) as Anthropic.Tool.InputSchema,
        }));
    }

    defs(): Anthropic.Tool[] {
        return [...this.toolDefs];
    }

    async run(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
        const tool = this.byName.get(name);
        if (!tool) {
            return { ok: false, error: 'unknown_tool' };
        }
        return await tool.handler(ctx, input);
    }
}
