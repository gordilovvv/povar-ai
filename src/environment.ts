import { z } from 'zod';

export const environmentSchema = z.object({
    PORT: z.string(),
    DATABASE_URL: z.string(),
    WA_TOKEN: z.string(),
    WA_SECRET: z.string(),
    WA_APP_SECRET: z.string(),
    WA_PHONE_ID: z.string(),
    ANTHROPIC_API_KEY: z.string(),
    ANTHROPIC_MODEL: z.string(),
    WA_SEND: z.enum(['on', 'off']),
    TEXT_AFTER_PAUSE_CHAT: z.enum(['on', 'off']),
    TELEGRAM_BOT_TOKEN: z.string(),
    TELEGRAM_GROUP_ID: z.string(),
    S3_ACCESS_KEY: z.string(),
    S3_SECRET_KEY: z.string(),
    S3_BUCKET: z.string(),
    S3_REGION: z.string(),
    S3_ENDPOINT: z.string(),
    S3_PUBLIC_URL: z.string(),
});

export type Environment = z.infer<typeof environmentSchema>;

declare global {
    namespace NodeJS {
        interface ProcessEnv extends Environment {}
    }
}

export const env: Environment = environmentSchema.parse(process.env);
