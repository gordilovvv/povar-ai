import { z } from 'zod';
import { pool } from '../../db/db.ts';
import { updateGuestProfile } from '../../db/guests.ts';
import type { AgentTool, ToolContext } from './types.ts';

const name = 'update_guest';
const description = `Сохранить собранные данные гостя (имя/фамилия/инстаграм) по мере того как он их называет в чате. Вызывай каждый раз, когда узнал новое поле. Повторный вызов безопасен. Возвращает missing — какие поля ещё не собраны; продолжай спрашивать, пока не пусто.`;

const input = z.object({
    first_name: z.string().min(1).optional(),
    last_name: z.string().min(1).optional(),
    instagram_url: z.string().optional(),
});

const COLLECTABLE = ['first_name', 'instagram_url'] as const;

const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, error: 'bad_input' };
    }

    const client = await pool.connect();
    try {
        const guest = await updateGuestProfile(client, ctx.guestId, parsed.data);
        if (!guest) {
            return { ok: false, error: 'guest_not_found' };
        }
        return {
            ok: true,
            saved: Object.keys(parsed.data),
            missing: COLLECTABLE.filter((k) => !guest[k]),
        };
    } finally {
        client.release();
    }
};

export default { name, description, input, handler } satisfies AgentTool;
