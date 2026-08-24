import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
    insertGuestlistEntry,
    type PartyGuestlistStorage,
    selectGuestlistEntry,
    updateGuestlistFriends,
    updateGuestlistTableAnswer,
    updateGuestlistTableOffered,
} from '#Db/Guestlist.js';
import { updateGuestProfile } from '#Db/Guests.js';
import { FOREIGN_KEY_ERROR_CODE, pool, UNIQUE_ERROR_CODE } from '#Db/Pool.js';
import pauseChat from '#Intelligence/Tools/PauseChat.js';
import { sendMessages } from '#Intelligence/Tools/SendMessage.js';
import { badInput } from '#Intelligence/Tools/Utils.js';
import { toDateTime } from '#Lib/Fmt.js';
import type { Lang } from '#Lib/Lang.js';
import { Logger } from '#Lib/Logger.js';
import type { AgentTool, ToolContext } from '#Lib/Tools.js';

const name = 'save_guest';
const description = `Put the guest on a party's guestlist and save what you have learned about them. Call it the moment you learn anything new — the name, the instagram, the companions they bring, the answer about a table, anything else the fields below cover — with party_id and only the fields you just learned; never hold the call back waiting for the rest, calling it again with the same party_id is safe and fills in what is new without erasing what is saved. This is the only tool that touches the guest's profile and the guestlist. Not for questions the party facts do not answer — money, discounts, exceptions, complaints, personal questions to Sema — that is pause_chat; the table answer is the one exception that belongs here, not there. party_id is the party the guest is going to, taken from the <parties> block of the system prompt. first_name and last_name are the guest's own name. instagram is their instagram. insta_asked is true once you have asked for the instagram, whether or not they answered. table_offered is true the moment you have offered a table, whether or not they answered — pass it in the same turn as the offer so the offer is never repeated. friends is every companion the guest brings, one entry per person, each with a name AND a surname — never the guest themselves — the whole current list every time, since each call replaces it; never pass a count or a placeholder such as "+2", "нас трое", "2 people" or "friends" — it names nobody and the door has no one to check — ask the guest for the real names first and call this tool once they answer. want_table is the guest's answer to the table offer you made in this chat for this party: true if they want one, false if they refused — pass it only once they have actually answered that offer, never together with table_offered and never for a refusal that belongs to an earlier party, and leave it out otherwise; the first answer saved is final and a later different value will not change it. Without want_table nothing is sent to the guest: keep the conversation going and reply through send_message as usual. Passing want_table makes this tool the whole reply — it answers the guest itself, so never call send_message after it; read the result: if it says the chat stays open, keep answering about the party from your next turn on, and if it says the chat is closed, call no other tool and end your turn with no output.`;

const NOT_A_NAME =
    'This is a head count or a placeholder, not a name. Nothing was saved. Ask the guest for the name and surname of every companion and call this tool again with the full friends list once they answer.';
const NO_SURNAME =
    'A companion needs both a name and a surname — the door checks them. Nothing was saved. Ask the guest for the missing surname and call this tool again with the full friends list.';

const friendName = z
    .string()
    .trim()
    .min(1)
    .refine((value) => /\p{L}/u.test(value) && !/[\p{N}+?]/u.test(value), { error: NOT_A_NAME })
    .refine((value) => value.split(/\s+/).length >= 2, { error: NO_SURNAME });

const input = z.object({
    party_id: z.string().trim().min(1),
    first_name: z.string().trim().min(1).optional(),
    last_name: z.string().trim().min(1).optional(),
    instagram: z.string().trim().min(1).optional(),
    insta_asked: z.boolean().optional(),
    friends: z.array(friendName).optional(),
    table_offered: z.boolean().optional(),
    want_table: z.boolean().optional(),
});

const PARTY_FK_CONSTRAINT = 'party_guestlist_party_id_fkey';

const UNKNOWN_PARTY = {
    ok: false,
    error: 'unknown_party',
    field: 'party_id',
    instruction:
        'There is no party with this party_id and nothing was saved. Call this tool again with a party_id from the <parties> block of the system prompt.',
} as const;

const TABLE_NOT_OFFERED = {
    ok: false,
    error: 'table_not_offered',
    field: 'want_table',
    instruction:
        'Nothing was saved. This guest has not been offered a table for this party in this chat, so there is no answer of theirs to record, and a refusal from an earlier party is not an answer for this one. table_offered is not a fix for this error: pass it only in the turn where you actually send the guest the table offer, never to make want_table go through. If you have not offered a table here, save no table fields and just keep the conversation going.',
} as const;

// const ONLY_GUESTLIST_MESSAGES: Record<Lang, string> = {
//     ru: 'Подписывайся на наш инстаграм — там первыми выходят анонсы вечеринок, атмосфера событий и основная информация в развёрнутом формате:\n\nhttps://www.instagram.com/weare.wrld/\n\nЕсли ты хочешь более краткий формат получения информации, без лишней воды, а также попадать в гостевые списки на дружественные события подписывайся на Whatsapp-канал:\n\nhttps://chat.whatsapp.com/GZ2IIBdkm4W78CoqNtxayu?mode=gi_t',
//     en: 'Follow our Instagram — party announcements, event vibes and the main info in full format drop there first:\n\nhttps://www.instagram.com/weare.wrld/\n\nIf you prefer a shorter format without the fluff — and want to get on guest lists for friendly events — join our WhatsApp channel:\n\nhttps://chat.whatsapp.com/GZ2IIBdkm4W78CoqNtxayu?mode=gi_t',
// } as const;

const ONLY_GUESTLIST_MESSAGES: Record<Lang, string> = {
    ru: 'Подписывайся на наш инстаграм — там первыми выходят анонсы вечеринок, атмосфера событий и основная информация в развёрнутом формате:\n\nhttps://www.instagram.com/weare.wrld/\n\nКстати, у меня вышел новый сингл на лейбле Yulia Niko, уверен тебе понравится, послушать можешь по ссылке на удобной для тебя платформе:\n\nhttps://www.submithub.com/link/domino-axept\n\nПриятного прослушивания и до встречи!',
    en: "Follow our Instagram — party announcements, event vibes and the main info in full format drop there first:\n\nhttps://www.instagram.com/weare.wrld/\n\nBy the way, my new single is out on Yulia Niko's label — I'm sure you'll like it. Listen on whichever platform suits you:\n\nhttps://www.submithub.com/link/domino-axept\n\nEnjoy, and see you soon!",
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

    const { party_id, want_table, insta_asked, friends, table_offered, ...profile } = parsed.data;
    const now = toDateTime(Date.now());

    const client = await pool.connect();
    let lang: Lang;
    let answered = false;
    try {
        const entry = await ensureGuestlistEntry(client, party_id, ctx.guestId, now);
        if (entry === 'unknown_party') {
            Logger.log(`[save_guest] ${ctx.phone} unknown party_id ${party_id}`);
            return UNKNOWN_PARTY;
        }
        if (want_table !== undefined && (table_offered || !entry.table_offered_at)) {
            Logger.log(`[save_guest] ${ctx.phone} want_table without an offer on ${party_id}`);
            return TABLE_NOT_OFFERED;
        }
        if (friends) {
            await updateGuestlistFriends(client, party_id, ctx.guestId, friends);
        }
        if (table_offered) {
            await updateGuestlistTableOffered(client, party_id, ctx.guestId, now);
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
            instagram_asked_at: insta_asked ? now : undefined,
        });
        lang = guest?.lang ?? 'en';
    } finally {
        client.release();
    }

    Logger.log(`[save_guest] ${ctx.phone} on ${party_id}, table: ${want_table ?? 'not asked'}`);

    if (want_table === undefined) {
        return { ok: true, status: 'saved' };
    }

    if (!answered) {
        Logger.log(`[save_guest] ${ctx.phone} on ${party_id} already answered about the table`);
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

    // Остановить чат (если нужен стол) — гостю отвечает сам pause_chat
    return pauseChat.handler(ctx, { details: 'Гость хочет стол', language: lang });
};

const ensureGuestlistEntry = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
    joinedAt: string,
): Promise<PartyGuestlistStorage | 'unknown_party'> => {
    const existing = await selectGuestlistEntry(client, partyId, guestId);
    if (existing) {
        return existing;
    }
    try {
        await insertGuestlistEntry(client, partyId, guestId, joinedAt);
        return ensureGuestlistEntry(client, partyId, guestId, joinedAt);
    } catch (error) {
        const { code, constraint } = error as { code?: string; constraint?: string };
        if (code === UNIQUE_ERROR_CODE) {
            return ensureGuestlistEntry(client, partyId, guestId, joinedAt);
        }
        if (code === FOREIGN_KEY_ERROR_CODE && constraint === PARTY_FK_CONSTRAINT) {
            return 'unknown_party';
        }
        throw error;
    }
};

export default { name, description, input, handler } satisfies AgentTool;
