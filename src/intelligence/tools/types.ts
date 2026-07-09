import type { z } from 'zod';

export interface ToolContext {
    guestId: string;
    phone: string;
    replies: string[];
}

export interface AgentTool {
    name: string;
    description: string;
    input: z.ZodType;
    handler: (ctx: ToolContext, raw: unknown) => Promise<unknown>;
}
