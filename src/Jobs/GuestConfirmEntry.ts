import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
import format from 'pg-format';
import { ulid } from 'ulid';
import { z } from 'zod';

// TODO: #-импорты в треде работают (tsx, tsx watch, dist) — падало на environment.ts без --env-file. Перевести на pool из #Db/Pool.js и env из #environment.js, убрать workerData и свой Pool.

export interface GuestConfirmJobConfig {
    databaseUrl: string;
    waToken: string;
    waPhoneId: string;
    waSend: 'on' | 'off';
}

interface DuePartyRow {
    party_id: string;
    party_date: string;
    due_at: Date;
}

interface ClaimedGuestRow {
    guest_id: string;
    wa_phone: string;
    first_name: string;
}

const TICK_INTERVAL_MS = 60_000;
const WA_API_VERSION = 'v21.0';
const TEMPLATE_NAME = 'event_rsvp_confirmation';
const sendResponse = z.looseObject({ messages: z.array(z.looseObject({ id: z.string() })).min(1) });

export const runTick = async (
    pool: pg.Pool,
    config: GuestConfirmJobConfig,
    now: string | null = null,
) => {
    const parties = await selectDueParties(pool, now);
    for (const party of parties) {
        const claimed = await claimGuests(pool, party.party_id, party.due_at);
        for (const guest of claimed) {
            const text = `Hi ${guest.first_name}, are you coming to the event tonight, ${party.party_date}? Let us know so we can get the venue ready for everyone.`;
            if (config.waSend !== 'on') {
                console.log(
                    `[jobs:guest-confirm:off] ${guest.wa_phone} ${party.party_id}: ${text}`,
                );
                continue;
            }
            try {
                const waMessageId = await sendTemplate(
                    config,
                    party.party_id,
                    guest,
                    party.party_date,
                );
                await insertSentMessage(pool, guest.wa_phone, waMessageId, text);
                console.log(`[jobs:guest-confirm] ${guest.wa_phone} ${party.party_id} sent`);
            } catch (error) {
                await markFailed(pool, party.party_id, guest.guest_id);
                console.error(
                    `[jobs] guest-confirm party ${party.party_id} guest ${guest.guest_id} failed`,
                    error,
                );
            }
        }
    }
};

// Порог = 19:00 по Дубаю календарного дня самой вечеринки; вечеринка ещё не началась.
// TODO: время переклички настраивать на каждую вечеринку отдельно
const selectDueParties = async (pool: pg.Pool, now: string | null) => {
    const result = await pool.query<DuePartyRow>(
        format(
            `with tick as (select coalesce(%L::timestamptz, now()) as now_at)
            select
                p.id as party_id,
                to_char(t.start_at at time zone 'Asia/Dubai', 'FMMonth FMDD') as party_date,
                t.due_at
            from party p
            join lateral (
                select
                    min(pt.party_start_at) as start_at,
                    (date_trunc('day', min(pt.party_start_at) at time zone 'Asia/Dubai') + interval '19 hours')
                        at time zone 'Asia/Dubai' as due_at
                from party_time pt
                where pt.party_id = p.id and pt.party_start_at > (select now_at from tick)
            ) t on true
            where t.start_at is not null
                and (select now_at from tick) >= t.due_at
                and exists(
                    select 1 from party_guestlist gl
                    join guests g on g.id = gl.guest_id
                    where gl.party_id = p.id
                        and gl.guest_confirm_answer is null
                        and gl.joined_at < t.due_at
                        and g.wa_phone is not null
                        and g.first_name is not null
                )
            order by p.id`,
            now,
        ),
    );
    return result.rows;
};

// Захват работы: помечаем строки ДО отправки — сам себе замок. Параллельный тик на ту же
// вечеринку получит 0 строк (их guest_confirm_answer уже не null) и не задвоит рассылку.
const claimGuests = async (pool: pg.Pool, partyId: string, dueAt: Date) => {
    const result = await pool.query<ClaimedGuestRow>(
        format(
            `update party_guestlist gl set guest_confirm_answer = 'pending'
            from guests g
            where gl.party_id = %L
                and gl.guest_id = g.id
                and gl.guest_confirm_answer is null
                and gl.joined_at < %L
                and g.wa_phone is not null
                and g.first_name is not null
            returning gl.guest_id, g.wa_phone, g.first_name`,
            partyId,
            dueAt.toISOString(),
        ),
    );
    return result.rows;
};

// Ошибка Meta терминальна: повтор каждый тик до старта вечеринки — сотни запросов на одного гостя.
const markFailed = async (pool: pg.Pool, partyId: string, guestId: string) => {
    await pool.query(
        format(
            `update party_guestlist set guest_confirm_answer = 'failed'
            where party_id = %L and guest_id = %L`,
            partyId,
            guestId,
        ),
    );
};

const sendTemplate = async (
    config: GuestConfirmJobConfig,
    partyId: string,
    guest: ClaimedGuestRow,
    partyDate: string,
) => {
    const response = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${config.waPhoneId}/messages`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${config.waToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: guest.wa_phone,
                type: 'template',
                template: {
                    name: TEMPLATE_NAME,
                    language: { code: 'en' },
                    components: [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: guest.first_name },
                                { type: 'text', text: partyDate },
                            ],
                        },
                        {
                            type: 'button',
                            sub_type: 'quick_reply',
                            index: '0',
                            parameters: [
                                { type: 'payload', payload: `guest_confirm:yes:${partyId}` },
                            ],
                        },
                        {
                            type: 'button',
                            sub_type: 'quick_reply',
                            index: '1',
                            parameters: [
                                { type: 'payload', payload: `guest_confirm:no:${partyId}` },
                            ],
                        },
                    ],
                },
            }),
        },
    );
    if (!response.ok) {
        throw new Error(
            `WhatsApp template send failed: ${response.status} ${await response.text()}`,
        );
    }
    const parsed = sendResponse.parse(await response.json());
    const waMessageId = parsed.messages[0]?.id;
    if (!waMessageId) {
        throw new Error('WhatsApp template send: unexpected response shape');
    }
    return waMessageId;
};

const insertSentMessage = async (
    pool: pg.Pool,
    phone: string,
    waMessageId: string,
    text: string,
) => {
    await pool.query(
        format(
            `insert into wa_messages
                (id, wa_message_id, wa_chat_phone, text, owner, status, worker_status, concurrency_version, sent_at)
            values
                (%L, %L, %L, %L, 'marketing', 'sent', 'skipped', 0, now())`,
            ulid(),
            waMessageId,
            phone,
            text,
        ),
    );
    await pool.query(
        format(
            `update wa_chats set last_sent_message_at = greatest(last_sent_message_at, now())
            where wa_phone = %L`,
            phone,
        ),
    );
};

if (parentPort) {
    const config = workerData as GuestConfirmJobConfig;
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    const tick = async () => {
        try {
            await runTick(pool, config);
        } catch (error) {
            console.error('[jobs] guest-confirm tick failed', error);
        }
    };
    void tick();
    setInterval(() => void tick(), TICK_INTERVAL_MS);
}
