import { z } from 'zod';

export const environmentSchema = z.object({
    PORT: z.string(),
    DATABASE_URL: z.string(),
    WA_TOKEN: z.string(),
    WA_SECRET: z.string(),
});

export type Environment = z.infer<typeof environmentSchema>;

declare global {
    namespace NodeJS {
        interface ProcessEnv extends Environment {}
    }
}

export const env: Environment = environmentSchema.parse(process.env);
