import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
    insertGuestlistEntry,
    selectGuestlistEntry,
    updateGuestlistFriends,
    updateGuestlistTableAnswer,
} from '#Db/Guestlist.js';
import { updateGuestProfile } from '#Db/Guests.js';
import { pool, UNIQUE_ERROR_CODE } from '#Db/Pool.js';
import pauseChat from '#Intelligence/Tools/PauseChat.js';
import { sendMessages } from '#Intelligence/Tools/SendMessage.js';
import { badInput } from '#Intelligence/Tools/Utils.js';
import { toDateTime } from '#Lib/Fmt.js';
import type { Lang } from '#Lib/Lang.js';
import type { AgentTool, ToolContext } from '#Lib/Tools.js';

const name = 'save_guest';
const description = `Put the guest on a party's guestlist and save what you have learned about them. Call it the moment you learn anything new — the name, the instagram, the companions they bring, the answer about a table, anything else the fields below cover — with party_id and only the fields you just learned; never hold the call back waiting for the rest, calling it again with the same party_id is safe and fills in what is new without erasing what is saved. This is the only tool that touches the guest's profile and the guestlist. Not for questions the party facts do not answer — money, discounts, exceptions, complaints, personal questions to Sema — that is pause_chat; the table answer is the one exception that belongs here, not there. party_id is the party the guest is going to, taken from get_party. first_name and last_name are the guest's own name. instagram is their instagram. insta_asked is true once you have asked for the instagram, whether or not they answered. friends is every companion the guest brings, one full name per entry, the whole current list every time, since each call replaces it. want_table is the guest's answer to the table offer: true if they want one, false if they refused — pass it only once they have actually answered, and leave it out otherwise; the first answer saved is final and a later different value will not change it. Without want_table nothing is sent to the guest: keep the conversation going and reply through send_message as usual. Passing want_table makes this tool the whole reply — it answers the guest itself, so never call send_message after it; read the result: if it says the chat stays open, keep answering about the party from your next turn on, and if it says the chat is closed, call no other tool and end your turn with no output.`;

const input = z.object({
    party_id: z.string().trim().min(1),
    first_name: z.string().trim().min(1).optional(),
    last_name: z.string().trim().min(1).optional(),
    instagram: z.string().trim().min(1).optional(),
    insta_asked: z.boolean().optional(),
    friends: z.array(z.string().trim().min(1)).optional(),
    want_table: z.boolean().optional(),
});

const TABLE_MESSAGES: Record<Lang, string> = {
    ru: 'Заглушка: гость хочет стол',
    en: 'Placeholder: the guest wants a table',
} as const;

const ONLY_GUESTLIST_MESSAGES: Record<Lang, string> = {
    ru: 'Заглушка: гость без стола',
    en: 'Placeholder: the guest wants no table',
} as const;

/**
 * Кладёт гостя в гест-лист вечеринки и обновляет его профиль.
 * Идемпотентен: повторный вызов дополняет запись, не затирая уже известное.
 * Ответ про стол терминальный: гостю отвечает код, при согласии чат уходит на паузу.
 */
const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return badInput(parsed.error);
    }

    const { party_id, want_table, insta_asked, friends, ...profile } = parsed.data;
    const now = toDateTime(Date.now());

    const client = await pool.connect();
    let lang: Lang;
    let answered = false;
    try {
        await ensureGuestlistEntry(client, party_id, ctx.guestId, now);
        if (friends) {
            await updateGuestlistFriends(client, party_id, ctx.guestId, friends);
        }
        if (want_table !== undefined) {
            const captured = await updateGuestlistTableAnswer(
                client,
                party_id,
                ctx.guestId,
                want_table,
                now,
            );
            answered = !!captured;
        }
        const guest = await updateGuestProfile(client, ctx.guestId, {
            ...profile,
            insta_asked_at: insta_asked ? now : undefined,
        });
        lang = guest?.lang ?? 'en';
    } finally {
        client.release();
    }

    console.log(`[save_guest] ${ctx.phone} on ${party_id}, table: ${want_table ?? 'not asked'}`);

    if (want_table === undefined) {
        return { ok: true, status: 'saved' };
    }

    if (!answered) {
        console.log(`[save_guest] ${ctx.phone} on ${party_id} already answered about the table`);
    }

    if (!want_table) {
        if (answered) {
            await sendMessages(ctx, [ONLY_GUESTLIST_MESSAGES[lang]]);
        }
        return {
            ok: true,
            status: 'saved',
            instruction:
                'The guest is on the list and has already been answered about the table. Do not call send_message. The chat stays open — keep answering about the party.',
        };
    }

    // Остановить чат (если нужен стол)
    if (answered) {
        await sendMessages(ctx, [TABLE_MESSAGES[lang]]);
    }
    return pauseChat.handler(ctx, { details: 'Гость хочет стол', language: lang });
};

const ensureGuestlistEntry = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
    joinedAt: string,
): Promise<void> => {
    if (await selectGuestlistEntry(client, partyId, guestId)) {
        return;
    }
    try {
        await insertGuestlistEntry(client, partyId, guestId, joinedAt);
    } catch (error) {
        if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
            throw error;
        }
        return ensureGuestlistEntry(client, partyId, guestId, joinedAt);
    }
};

export default { name, description, input, handler } satisfies AgentTool;
