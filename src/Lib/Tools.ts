import type { z } from 'zod';

export interface ToolContext {
    guestId: string;
    phone: string;
    replies: string[];
    /**
     * Отметки «спросил / предложил» из save_guest: в базу их пишет send_message, когда текст дошёл до гостя.
     */
    unsent: { instaAsked?: true; tableOfferedPartyId?: string };
}

export interface AgentTool {
    name: string;
    description: string;
    input: z.ZodType;
    handler: (ctx: ToolContext, raw: unknown) => Promise<unknown>;
}
