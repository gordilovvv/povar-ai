import { z } from 'zod';

const environmentSchema = z.object({
    PORT: z.string(),
    DATABASE_URL: z.string(),
    JWT_SECRET: z.string(),
    ADMIN_PHONE: z.string(),
    ADMIN_PASSWORD_HASH: z.string(),
    ACTIVE_PARTY_WINDOW_HOURS: z.string(),
});

export const env = environmentSchema.parse(process.env);
