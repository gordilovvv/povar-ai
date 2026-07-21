import type { z } from 'zod';

export const badInput = (error: z.ZodError) => ({
    ok: false,
    error: 'bad_input',
    issues: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        problem: issue.message,
    })),
});
