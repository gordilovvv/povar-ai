import { z } from 'zod';

export const environmentSchema = z.object({
    PORT: z.string(),
    DATABASE_URL: z.string(),
    WA_TOKEN: z.string(),
    WA_SECRET: z.string(),
    WA_PHONE_ID: z.string(),
    ANTHROPIC_API_KEY: z.string(),
    ANTHROPIC_MODEL: z.string(),
});

export type Environment = z.infer<typeof environmentSchema>;

declare global {
    namespace NodeJS {
        interface ProcessEnv extends Environment {}
    }
}

export const env: Environment = environmentSchema.parse(process.env);
