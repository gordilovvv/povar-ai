import { parentPort, workerData } from 'node:worker_threads';
import cyrillicToTranslit from 'cyrillic-to-translit-js';
import pg from 'pg';
import format from 'pg-format';
import { z } from 'zod';

// TODO: #-импорты в треде работают (tsx, tsx watch, dist) — падало на environment.ts без --env-file. Перевести на pool из #Db/Pool.js и env из #environment.js, убрать workerData и свой Pool.

export interface GuestlistJobConfig {
    databaseUrl: string;
    telegramBotToken: string;
    telegramGroupId: string;
}

interface DuePartyRow {
    party_id: string;
    party_name: string;
    already_alerted: boolean;
}

interface ClaimedGuestRow {
    guest_id: string;
    joined_at: Date | null;
    first_name: string | null;
    last_name: string | null;
    friends: string[] | null;
}

const TICK_INTERVAL_MS = 60_000;
const telegramResponse = z.object({ ok: z.boolean(), description: z.string().optional() });

const selectDueParties = async (pool: pg.Pool, now: string | null) => {
    // now === null в проде -> шлюз считается от now(); тесты подставляют фиксированное время.
    // Порог = 18:00 по Дубаю календарного дня самой вечеринки; вечеринка ещё не началась.
    const result = await pool.query<DuePartyRow>(
        format(
            `with tick as (select coalesce(%L::timestamptz, now()) as now_at)
            select
                p.id as party_id,
                p.name as party_name,
                exists(
                    select 1 from party_guestlist a
                    where a.party_id = p.id and a.telegram_alert_at is not null
                ) as already_alerted
            from party p
            join lateral (
                select min(pt.party_start_at) as start_at
                from party_time pt
                where pt.party_id = p.id and pt.party_start_at > (select now_at from tick)
            ) t on true
            where t.start_at is not null
                and (select now_at from tick) >= (
                    date_trunc('day', t.start_at at time zone 'Asia/Dubai') + interval '18 hours'
                ) at time zone 'Asia/Dubai'
                and exists(
                    select 1 from party_guestlist n
                    where n.party_id = p.id and n.telegram_alert_at is null
                )
            order by p.id`,
            now,
        ),
    );
    return result.rows;
};

// Захват работы: помечаем строки ДО отправки — сам себе замок. Параллельный тик на ту же
// вечеринку получит 0 строк (their telegram_alert_at уже не null) и не задвоит рассылку.
const claimGuests = async (pool: pg.Pool, partyId: string) => {
    const result = await pool.query<ClaimedGuestRow>(
        format(
            `update party_guestlist gl set telegram_alert_at = now()
            from guests g
            where gl.party_id = %L and gl.guest_id = g.id and gl.telegram_alert_at is null
            returning gl.guest_id, gl.joined_at, g.first_name, g.last_name, gl.friends`,
            partyId,
        ),
    );
    return result.rows.sort((a, b) => {
        const ta = a.joined_at ? a.joined_at.getTime() : Number.POSITIVE_INFINITY;
        const tb = b.joined_at ? b.joined_at.getTime() : Number.POSITIVE_INFINITY;
        return ta !== tb ? ta - tb : a.guest_id.localeCompare(b.guest_id);
    });
};

const releaseGuests = async (pool: pg.Pool, partyId: string, guestIds: string[]) => {
    await pool.query(
        format(
            `update party_guestlist set telegram_alert_at = null
            where party_id = %L and guest_id in (%L)`,
            partyId,
            guestIds,
        ),
    );
};

// MarkdownV2: эти символы в обычном тексте Telegram требует экранировать, иначе 400 «can't parse entities».
const MD_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const escapeMd = (value: string) => value.replace(MD_SPECIAL, '\\$&');
// Внутри ``` code ``` экранируются только ` и \ — остальной текст (список копируется тапом по блоку).
const escapeCode = (value: string) => value.replace(/[`\\]/g, '\\$&');

const HEADER_BROADCAST = 'Гест-лист';
const HEADER_ADDED = 'Добавился в гест-лист';

// Пакет CJS с `export default`-фабрикой — под nodenext tsc видит неймспейс, каст возвращает вызываемость.
const translit = (cyrillicToTranslit as unknown as () => { transform(input: string): string })();

const guestNames = (guests: Pick<ClaimedGuestRow, 'first_name' | 'last_name' | 'friends'>[]) => {
    const names: string[] = [];
    for (const guest of guests) {
        const fullName = [guest.first_name, guest.last_name].filter(Boolean).join(' ').trim();
        if (fullName) {
            names.push(translit.transform(fullName));
        }
        for (const friend of guest.friends ?? []) {
            const trimmed = friend.trim();
            if (trimmed) {
                names.push(translit.transform(trimmed));
            }
        }
    }
    return names;
};

export const buildMessage = (
    partyName: string,
    header: string,
    guests: Pick<ClaimedGuestRow, 'first_name' | 'last_name' | 'friends'>[],
) => {
    const list = guestNames(guests)
        .map((name) => escapeCode(name))
        .join('\n');
    return `*${escapeMd(partyName)}*\n${escapeMd(header)}\n\n\`\`\`\n${list}\n\`\`\``;
};

const sendTelegram = async (config: GuestlistJobConfig, text: string) => {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            chat_id: config.telegramGroupId,
            text,
            parse_mode: 'MarkdownV2',
        }),
    });
    const json = telegramResponse.parse(await res.json());
    if (!json.ok) {
        throw new Error(`Telegram sendMessage failed: ${json.description ?? 'unknown'}`);
    }
};

export const runTick = async (
    pool: pg.Pool,
    config: GuestlistJobConfig,
    now: string | null = null,
) => {
    const parties = await selectDueParties(pool, now);
    for (const party of parties) {
        const claimed = await claimGuests(pool, party.party_id);
        if (!claimed.length) {
            continue;
        }
        if (party.already_alerted) {
            for (const guest of claimed) {
                try {
                    await sendTelegram(
                        config,
                        buildMessage(party.party_name, HEADER_ADDED, [guest]),
                    );
                } catch (error) {
                    await releaseGuests(pool, party.party_id, [guest.guest_id]);
                    console.error(`[jobs] guestlist party ${party.party_id} guest failed`, error);
                }
            }
        } else {
            try {
                await sendTelegram(
                    config,
                    buildMessage(party.party_name, HEADER_BROADCAST, claimed),
                );
            } catch (error) {
                await releaseGuests(
                    pool,
                    party.party_id,
                    claimed.map((guest) => guest.guest_id),
                );
                console.error(`[jobs] guestlist party ${party.party_id} failed`, error);
            }
        }
    }
};

if (parentPort) {
    const config = workerData as GuestlistJobConfig;
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    const tick = async () => {
        try {
            await runTick(pool, config);
        } catch (error) {
            console.error('[jobs] guestlist tick failed', error);
        }
    };
    void tick();
    setInterval(() => void tick(), TICK_INTERVAL_MS);
}
