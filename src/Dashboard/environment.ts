import { z } from 'zod';

const environmentSchema = z.object({
    PORT: z.string(),
    DATABASE_URL: z.string(),
    JWT_SECRET: z.string(),
});

export const env = environmentSchema.parse(process.env);
