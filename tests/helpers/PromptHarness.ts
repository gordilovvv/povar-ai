import type Anthropic from '@anthropic-ai/sdk';
import { pool } from '#Db/Pool.js';
import { env } from '#environment.js';
import { Agent } from '#Intelligence/Agent.js';
import { Checklist } from '#Intelligence/Checklist.js';
import type { Lang } from '#Lib/Lang.js';
import type { ToolContext } from '#Lib/Tools.js';

export const GUEST_ID = 'E2E_prompts_guest';
export const PHONE = 'E2E_prompts_71000000009';

export interface Party {
    party_id: string;
    name: string;
    location: string;
    google_map_link: string;
    price: string;
    reels_url: string | null;
    notes: string;
    /** UTC-строки стартов; Dubai = UTC+4. */
    starts: { start: string; free_entry_before: string | null }[];
}

export const LYLO: Party = {
    party_id: 'e2e_lylo',
    name: 'LYLO',
    location: 'Club Vista Mare, Palm Jumeirah',
    google_map_link: 'https://maps.app.goo.gl/e2elylo',
    price: '150',
    reels_url: 'https://instagram.com/reel/e2elylo',
    notes: 'LYLO — скрытый клуб-speakeasy ВНУТРИ ресторана на Canary Beach (Club Vista Mare, Palm Jumeirah). Закрытое помещение: бар-зона с диванчиками и танцпол. Вайб интимный, красный ретро-свет, deep house / minimal techno. Прохладно, кондиционеры. Бар: авторские коктейли 85–110 AED, вино бокал 65–85 AED. Кухня ресторана работает до 23:00 — на самой вечеринке только напитки. Кальяна нет. Вход бесплатный до полуночи, после — 150 AED.',
    starts: [{ start: '2026-07-25 18:00:00+00', free_entry_before: '2026-07-25 20:00:00+00' }],
};

export const SIRENE: Party = {
    party_id: 'e2e_sirene',
    name: 'SIRENE',
    location: 'FIVE JBR rooftop, 16 этаж',
    google_map_link: 'https://maps.app.goo.gl/e2esirene',
    price: '150',
    reels_url: null,
    notes: 'SIRENE — открытая rooftop-вечеринка на крыше FIVE JBR. Вид на море. Тент только над баром. Музыка: afro house и melodic techno, живой саксофон в полночь. Бар: коктейли 90–120 AED, безалкогольные 45 AED. Еды нет, только снеки. Кальян есть, 250 AED. Вход по гест-листу свободен до 22:30, позже — 150 AED.',
    starts: [{ start: '2026-07-31 17:00:00+00', free_entry_before: '2026-07-31 18:30:00+00' }],
};

export interface Scenario {
    /** Реплики диалога по порядку; последняя должна быть от гостя. */
    history: { role: 'user' | 'assistant'; text: string }[];
    /** Вечеринки, которые будут в базе на время хода — их и вернёт get_party. */
    parties: Party[];
    /** Строки блока `State:` — что известно о госте. */
    state: string[];
    /** Шаги воронки, уже сделанные. */
    done: string[];
    /** Единственный шаг этого хода. */
    now: string;
    lang?: Lang;
    /** Dubai-время хода, 24h. */
    nowTime?: string;
}

export interface TurnResult {
    replies: string[];
    calls: { name: string; input: Record<string, unknown> }[];
    /** Все бабблы одной строкой — для поиска по тексту. */
    text: string;
    called: (name: string) => boolean;
    inputOf: (name: string) => Record<string, unknown> | undefined;
}

/**
 * Прогоняет один ход агента на реальной модели с промтами из `Prompts/`.
 * Тулы настоящие и ходят в базу — сценарные вечеринки и гость сидятся тут же.
 */
export const runScenario = async (scenario: Scenario): Promise<TurnResult> => {
    if (env.WA_SEND === 'on') {
        throw new Error('PromptHarness: WA_SEND=on — тест писал бы живым гостям, отменяю');
    }

    const lang = scenario.lang ?? 'ru';
    await seed(scenario.parties, lang);

    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const ctx: ToolContext = { guestId: GUEST_ID, phone: PHONE, replies: [] };

    const deps = {
        ...Agent.liveDeps,
        toolDefs: Agent.toolDefs,
        runTool: (name: string, input: unknown, context: ToolContext) => {
            calls.push({ name, input: (input ?? {}) as Record<string, unknown> });
            return Agent.liveDeps.runTool(name, input, context);
        },
    };

    const messages: Anthropic.MessageParam[] = scenario.history.map((m) => ({
        role: m.role,
        content: m.text,
    }));

    const system = Checklist.buildSystem({
        state: scenario.state,
        done: scenario.done,
        now: scenario.now,
        lang,
        nowTime: scenario.nowTime ?? '2026-07-21 18:00',
    });

    await Agent.runTurn(system, messages, ctx, deps);

    return {
        replies: ctx.replies,
        calls,
        text: ctx.replies.join('\n'),
        called: (name) => calls.some((c) => c.name === name),
        inputOf: (name) => calls.find((c) => c.name === name)?.input,
    };
};

/** Чистит следы прошлого хода и кладёт в базу ровно сценарные вечеринки, гостя и чат. */
const seed = async (parties: Party[], lang: Lang): Promise<void> => {
    await cleanup();

    for (const party of parties) {
        await pool.query(
            `insert into party (id, name, location, google_map_link, price, reels_url, notes, type)
             values ($1, $2, $3, $4, $5, $6, $7, 'owned')`,
            [
                party.party_id,
                party.name,
                party.location,
                party.google_map_link,
                party.price,
                party.reels_url,
                party.notes,
            ],
        );
        for (const time of party.starts) {
            await pool.query(
                `insert into party_time (party_id, party_start_at, free_entry_before)
                 values ($1, $2, $3)`,
                [party.party_id, time.start, time.free_entry_before],
            );
        }
    }

    await pool.query('insert into guests (id, wa_phone, lang) values ($1, $2, $3)', [
        GUEST_ID,
        PHONE,
        lang,
    ]);
    await pool.query('insert into wa_chats (wa_phone, guest_id) values ($1, $2)', [
        PHONE,
        GUEST_ID,
    ]);

    const foreign = await pool.query<{ id: string }>(
        `select party.id from party
         join party_time on party_time.party_id = party.id
         where party_time.party_start_at >= now() - make_interval(hours => $1::int)
           and party.id not like 'E2E_%' and party.id not like 'e2e_%'`,
        [env.PARTY_ACTIVE_HOURS],
    );
    if (foreign.rowCount) {
        throw new Error(
            `PromptHarness: в базе есть посторонние активные вечеринки ${foreign.rows.map((r) => r.id).join(', ')} — get_party отдал бы их модели`,
        );
    }
};

export const cleanup = async (): Promise<void> => {
    await pool.query('delete from party_guestlist where guest_id = $1', [GUEST_ID]);
    await pool.query('delete from wa_messages where wa_chat_phone = $1', [PHONE]);
    await pool.query('delete from wa_chats where wa_phone = $1', [PHONE]);
    await pool.query('delete from guests where id = $1', [GUEST_ID]);
    await pool.query(`delete from party_guestlist where party_id like 'e2e\\_%'`);
    await pool.query(`delete from party_time where party_id like 'e2e\\_%'`);
    await pool.query(`delete from party where id like 'e2e\\_%'`);
};

export const selectGuestlist = async () => {
    const result = await pool.query(
        `select party_id, friends, booked_table, table_offered_at
         from party_guestlist where guest_id = $1 order by party_id`,
        [GUEST_ID],
    );
    return result.rows as {
        party_id: string;
        friends: string[] | null;
        booked_table: boolean | null;
        table_offered_at: Date | null;
    }[];
};

export const selectGuest = async () => {
    const result = await pool.query(
        `select first_name, last_name, instagram, instagram_asked_at from guests where id = $1`,
        [GUEST_ID],
    );
    return result.rows[0] as
        | {
              first_name: string | null;
              last_name: string | null;
              instagram: string | null;
              instagram_asked_at: Date | null;
          }
        | undefined;
};
