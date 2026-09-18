import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import format from 'pg-format';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
    type GuestStorage,
    insertGuest,
    selectGuestByPhone,
    updateGuestMarketingEnableOff,
} from '#Db/Guests.js';
import { marketingMessageSchema, selectActivePartiesWithTimes } from '#Db/Party.js';
import { pool, UNIQUE_ERROR_CODE } from '#Db/Pool.js';
import { insertWaChat, updateWaChatLastSent } from '#Db/WaChats.js';
import {
    insertWaMessage,
    waMessageOwnerSchema,
    waMessageStatusSchema,
    waWorkerStatusSchema,
} from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { toDateTime } from '#Lib/Fmt.js';
import { downloadFromS3 } from '#Lib/S3.js';
import { sleep } from '#Lib/Sleep.js';
import { Progress } from './Progress.js';
import {
    appendCheckpoint,
    BOLD,
    CYAN,
    fmtMmSs,
    GRAY,
    GREEN,
    normalizePhone,
    RED,
    RESET,
    readCheckpoint,
    YELLOW,
} from './Utils.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const DUBAI_TZ = 'Asia/Dubai';
const LIVE_CHAT_WINDOW_HOURS = 24;
const SEND_INTERVAL_MS = 1000;
const SEND_LIMIT = 2000;
const MESSAGING_LIMIT_WINDOW_HOURS = 24;
const WA_API_VERSION = 'v21.0';
const TEMPLATE_NAME = 'party_invite';
const SEND_MAX_ATTEMPTS = 4;
const TEST_PHONE = '79287546885';
const TEST_PAUSE_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const NETWORK_RETRY_MS = 15_000;
const TEMPORARY_ERROR_CODES = new Set([80007, 130429, 131056]);
const SPAM_RESTRICTION_ERROR_CODE = 131048;
const MARKETING_OPT_OUT_ERROR_CODE = 131050;
const TMP_DIR = join(import.meta.dirname, 'tmp');

const sendResponseSchema = z.looseObject({
    messages: z.array(z.looseObject({ id: z.string() })).min(1),
});
const graphErrorSchema = z.looseObject({ error: z.looseObject({ code: z.number() }) });
const audienceRowSchema = z.object({ phone: z.string(), skip: z.string().nullable() });
const SKIP_LABELS: Record<string, string> = {
    'no marketing consent': 'отписались от рассылок',
    'in guestlist': 'уже в гест-листе',
    paused: 'чат на паузе',
    'live chat': `переписывались с ботом за последние ${LIVE_CHAT_WINDOW_HOURS} ч`,
    'in checkpoint': 'уже получили в прошлые запуски',
};

const [partyId, ...numbersPaths] = process.argv.slice(2);
if (!partyId) {
    console.error(
        `${RED}Как запускать: pnpm exec tsx --conditions=development --env-file=.env.prod marketing/StartMarketing.ts <party_id> [файл-с-номерами ...]${RESET}`,
    );
    process.exit(1);
}
for (const path of numbersPaths) {
    if (!existsSync(path)) {
        console.error(`${RED}Стоп: файл с номерами не найден — ${path}${RESET}`);
        process.exit(1);
    }
}
if (env.WA_SEND !== 'on') {
    console.error(`${RED}Стоп: отправка выключена (WA_SEND ≠ on) — рассылка не запущена${RESET}`);
    process.exit(1);
}

// 1. Party, marketing message and poster, 24h send budget.
const checkpointPath = join(TMP_DIR, `${partyId}.state`);
const audiencePath = join(TMP_DIR, `${partyId}.list.txt`);
const checkpoint = readCheckpoint(checkpointPath);

const client = await pool.connect();

const party = (await selectActivePartiesWithTimes(client)).find((row) => row.id === partyId);
if (!party) {
    console.error(
        `${RED}Стоп: активная вечеринка ${partyId} не найдена — проверь party_id и дату${RESET}`,
    );
    process.exit(1);
}
const marketingMessage = marketingMessageSchema.safeParse(party.marketing_message);
if (!marketingMessage.success) {
    console.error(
        `${RED}Стоп: у вечеринки ${partyId} не заполнен marketing_message (афиша + текст) — заполни его до рассылки${RESET}`,
    );
    console.error(marketingMessage.error.message);
    process.exit(1);
}
const marketingMedia =
    'video' in marketingMessage.data ? marketingMessage.data.video : marketingMessage.data.image;
const marketingFile = await downloadFromS3(marketingMedia).catch((error: Error) => error);
if (marketingFile instanceof Error) {
    console.error(
        `${RED}Стоп: афиша ${marketingMedia} не читается из S3 — ${marketingFile.message}${RESET}`,
    );
    process.exit(1);
}

const partyDate = dayjs(party.party_start_at).tz(DUBAI_TZ).format('MMMM D (dddd)');
const partyVenue = party.location.split(',')[0]?.trim() ?? party.location;
console.log(`\n${BOLD}${CYAN}═══ Рассылка приглашений: ${partyId} ═══${RESET}`);
console.log(`${BOLD}Вечеринка:${RESET} ${party.name} — ${partyDate}, ${partyVenue}`);
console.log(
    `${BOLD}Афиша:${RESET} ${marketingMedia} (${marketingFile.type}, ${Math.round(marketingFile.size / 1024)} КБ) — уйдёт по кнопке Info`,
);

const usage = await client.query(
    format(
        `select count(distinct wa_chat_phone)::int as recipients
        from wa_messages
        where owner = %L and sent_at > now() - make_interval(hours => %L::int)`,
        waMessageOwnerSchema.enum.marketing,
        MESSAGING_LIMIT_WINDOW_HOURS,
    ),
);
const recipientsLast24h = z.number().parse(usage.rows[0]?.recipients);
let sendBudget = Math.max(SEND_LIMIT - recipientsLast24h, 0);
console.log(
    `${BOLD}Лимит WhatsApp:${RESET} ${SEND_LIMIT} получателей за 24 ч, уже использовано ${recipientsLast24h} → по расчёту можно отправить ${GREEN}${sendBudget}${RESET}`,
);

const templateText = `Hi, it's Sam Povar ✌️\n\nI'm throwing a party this week — ${partyDate} at ${partyVenue}.\n\nI'd love to see you there! Sign up for the guest list below.`;
console.log(
    `${GRAY}Шаблон ${TEMPLATE_NAME}/en, подстановки: [${partyDate}] [${partyVenue}], кнопка Info → ${partyId}${RESET}`,
);

// 2. Audience: guests from DB not in this guestlist, plus numbers files, deduplicated.
const dbBase = await client.query(
    format(
        `select guests.wa_phone as phone
        from guests
        where guests.wa_phone is not null
          and guests.marketing_enable
          and not exists (
              select 1 from party_guestlist
              where party_guestlist.party_id = %L and party_guestlist.guest_id = guests.id
          )`,
        partyId,
    ),
);
const phones = new Set<string>(z.array(z.string()).parse(dbBase.rows.map((row) => row.phone)));
console.log(`\n${BOLD}${CYAN}── Собираю аудиторию ──${RESET}`);
console.log(
    `  Из базы: ${GREEN}${phones.size}${RESET} гостей с согласием на рассылку, которых ещё нет в гест-листе ${partyId}`,
);
for (const path of numbersPaths) {
    let fresh = 0;
    let duplicates = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        // Берём только номер в начале строки; имя и всё после него отбрасываем
        const raw = line.replace(/[^\d\s+().-].*$/u, '').trim();
        if (raw === '') {
            continue;
        }
        const phone = normalizePhone(raw);
        if (phone === null) {
            console.error(
                `${RED}Стоп: в файле ${path} строка не похожа на номер — «${line}»${RESET}`,
            );
            process.exit(1);
        }
        if (phones.has(phone)) {
            duplicates++;
        } else {
            phones.add(phone);
            fresh++;
        }
    }
    console.log(
        `  Файл ${path}: ${GREEN}+${fresh}${RESET} новых номеров, ${YELLOW}${duplicates}${RESET} дублей отброшено`,
    );
}

// 3. Skip rules in one query: consent, guestlist, paused, live chat; then checkpoint.
const audience = await client.query(
    format(
        `select
            numbers.phone,
            case
                when guests.marketing_enable = false then 'no marketing consent'
                when party_guestlist.guest_id is not null then 'in guestlist'
                when wa_chats.paused_at is not null then 'paused'
                when wa_chats.last_received_message_at > now() - make_interval(hours => %L::int)
                    then 'live chat'
            end as skip
        from unnest(array[%L]::text[]) as numbers(phone)
        left join guests on guests.wa_phone = numbers.phone
        left join party_guestlist
            on party_guestlist.party_id = %L and party_guestlist.guest_id = guests.id
        left join wa_chats on wa_chats.wa_phone = numbers.phone`,
        LIVE_CHAT_WINDOW_HOURS,
        [...phones],
        partyId,
    ),
);
const audienceRows = z
    .array(audienceRowSchema)
    .parse(audience.rows)
    .map((row) => ({
        ...row,
        skip: row.skip ?? (checkpoint.has(row.phone) ? 'in checkpoint' : null),
    }));
const groups = Object.groupBy(audienceRows, (row) => row.skip ?? 'send');
const toSend = (groups.send ?? []).map((row) => row.phone).filter((phone) => phone !== TEST_PHONE);
writeFileSync(
    audiencePath,
    `${audienceRows.map((row) => `${row.phone}\t${row.skip ?? 'send'}`).join('\n')}\n`,
);
console.log(`  Итого уникальных номеров: ${BOLD}${phones.size}${RESET}`);
console.log(`  Полный список с пометками записан в ${GRAY}${audiencePath}${RESET}`);
for (const [reason, rows] of Object.entries(groups)) {
    if (reason !== 'send') {
        console.log(
            `  ${YELLOW}Пропускаю${RESET} ${SKIP_LABELS[reason] ?? reason}: ${YELLOW}${rows?.length ?? 0}${RESET}`,
        );
    }
}
console.log(
    `\n${BOLD}План:${RESET} к отправке ${GREEN}${toSend.length}${RESET}, лимит на сегодня ${sendBudget} → ${BOLD}в этот запуск уйдёт ${Math.min(toSend.length, sendBudget)}${RESET}`,
);
if (toSend.length === 0) {
    console.log(
        `${YELLOW}Отправлять некого — всем либо уже отправлено, либо они пропущены${RESET}`,
    );
    process.exit(0);
}

// 4. Summary is on screen and in tmp/<party>.list.txt — nothing is sent without "yes".
const readline = createInterface({ input: process.stdin, output: process.stdout });
readline.on('SIGINT', () => {
    console.log(`\n${YELLOW}Отменено (Ctrl+C), ничего не отправлено${RESET}`);
    process.exit(0);
});
const answer = await readline.question(
    `\n${BOLD}Начать рассылку? Введи ${GREEN}yes${RESET}${BOLD}, всё остальное = отмена: ${RESET}`,
);
if (answer.trim() !== 'yes') {
    readline.close();
    console.log(`${YELLOW}Отменено, ничего не отправлено${RESET}`);
    process.exit(0);
}
if (recipientsLast24h > 0) {
    const override = await readline.question(
        `${YELLOW}За последние ${MESSAGING_LIMIT_WINDOW_HOURS} ч уже отправлено ${recipientsLast24h} — по расчёту доступно ${sendBudget}. Возможно, окно WhatsApp уже сброшено.${RESET}\n${BOLD}Снять ограничение и слать до ${SEND_LIMIT}? Введи ${GREEN}yes${RESET}${BOLD}, всё остальное = оставить расчётный лимит: ${RESET}`,
    );
    if (override.trim() === 'yes') {
        sendBudget = SEND_LIMIT;
        console.log(`${YELLOW}Лимит снят: в этот запуск уйдёт до ${sendBudget}${RESET}`);
    }
}
readline.close();
if (sendBudget <= 0) {
    console.error(
        `${RED}Стоп: суточный лимит исчерпан (${recipientsLast24h}/${SEND_LIMIT}) — запусти позже${RESET}`,
    );
    process.exit(1);
}

console.log(`\n${BOLD}${CYAN}── Тестовое сообщение на ${TEST_PHONE} ──${RESET}`);
const testGuest = await selectOrCreateGuest(TEST_PHONE);
try {
    await insertWaChat(client, TEST_PHONE, testGuest.id);
} catch (error) {
    if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
        throw error;
    }
}
const testMessageId = await sendTemplate(TEST_PHONE);
if (!testMessageId) {
    console.error(`${RED}Стоп: тестовое сообщение не ушло — рассылка не запущена${RESET}`);
    process.exit(1);
}
console.log(
    `${GREEN}✓${RESET} ${GRAY}тест отправлен (${testMessageId}), пауза ${TEST_PAUSE_MS / 1000} с${RESET}`,
);
await sleep(TEST_PAUSE_MS);

console.log(`\n${BOLD}${CYAN}── Отправляю ──${RESET}`);
console.log(
    `${GRAY}Прогресс пишу в ${checkpointPath} — при повторном запуске продолжу с места остановки${RESET}`,
);
console.log(
    `${GRAY}Пауза между сообщениями ${SEND_INTERVAL_MS} мс, до ${SEND_MAX_ATTEMPTS} попыток на номер${RESET}`,
);

// 5. Send loop: checkpoint before each send, so a rerun continues where it stopped.
let sentCount = 0;
let failedCount = 0;
const loopStartedAtMs = Date.now();
const progress = new Progress(toSend.length, sendBudget, loopStartedAtMs, () => ({
    sent: sentCount,
    failed: failedCount,
    skipped: 0,
}));
progress.draw();

for (const phone of toSend) {
    if (sentCount >= sendBudget) {
        progress.event(
            `${YELLOW}Суточный лимит достигнут: отправлено ${sentCount}/${sendBudget}, останавливаюсь${RESET}`,
        );
        break;
    }

    const guest = await selectOrCreateGuest(phone);
    try {
        await insertWaChat(client, phone, guest.id);
    } catch (error) {
        if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
            throw error;
        }
    }

    checkpoint.add(phone);
    appendCheckpoint(checkpointPath, phone, 'sending');

    const sendStartedAt = process.hrtime();
    const waMessageId = await sendTemplate(phone);
    const [sendSec, sendNs] = process.hrtime(sendStartedAt);
    const sendMs = Math.round(sendSec * 1000 + sendNs / 1e6);
    if (!waMessageId) {
        failedCount++;
        appendCheckpoint(checkpointPath, phone, 'failed');
        progress.event(`${RED}✗ ${phone} — WhatsApp отклонил, подробности выше${RESET}`);
        await sleep(SEND_INTERVAL_MS);
        continue;
    }

    const sentAt = new Date();
    await client.query('begin');
    await insertWaMessage(client, {
        id: ulid(),
        wa_message_id: waMessageId,
        wa_chat_phone: phone,
        text: templateText,
        owner: waMessageOwnerSchema.enum.marketing,
        status: waMessageStatusSchema.enum.sent,
        worker_status: waWorkerStatusSchema.enum.skipped,
        concurrency_version: 0,
        sent_at: sentAt,
    });
    await updateWaChatLastSent(client, phone, sentAt);
    await client.query('commit');

    sentCount++;
    appendCheckpoint(checkpointPath, phone, 'sent');
    progress.event(
        `${GREEN}✓${RESET} ${GRAY}${phone} отправлено за ${sendMs} мс (${waMessageId})${RESET}`,
    );
    await sleep(SEND_INTERVAL_MS);
}

progress.finish();

const untouched = toSend.length - sentCount - failedCount;
const elapsedSec = Math.round((Date.now() - loopStartedAtMs) / 1000);
console.log(`\n${BOLD}${CYAN}═══ Готово: ${partyId}, ${fmtMmSs(elapsedSec)} ═══${RESET}`);
console.log(
    `Отправлено ${GREEN}${sentCount}${RESET}, отклонено ${RED}${failedCount}${RESET}, не дошла очередь ${YELLOW}${untouched}${RESET}`,
);
console.log(`Остаток суточного лимита: ${sendBudget - sentCount} из ${sendBudget}`);
if (sentCount === 0) {
    console.log(`${RED}Ни одно сообщение не доставлено${RESET}`);
} else if (failedCount > 0) {
    console.log(
        `${YELLOW}Часть не ушла: ${failedCount} номеров отклонил WhatsApp — смотри ошибки выше${RESET}`,
    );
} else {
    console.log(`${GREEN}Все сообщения ушли без ошибок${RESET}`);
}
if (untouched > 0) {
    console.log(
        `${YELLOW}Осталось ${untouched} номеров — запусти ту же команду позже, продолжу с места остановки${RESET}`,
    );
}
client.release();
await pool.end();

async function sendTemplate(to: string): Promise<string | null> {
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
        const response = await waitForNetwork(() =>
            fetch(`https://graph.facebook.com/${WA_API_VERSION}/${env.WA_PHONE_ID}/messages`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${env.WA_TOKEN}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'template',
                    template: {
                        name: TEMPLATE_NAME,
                        language: { code: 'en' },
                        components: [
                            {
                                type: 'body',
                                parameters: [
                                    { type: 'text', text: partyDate },
                                    { type: 'text', text: partyVenue },
                                ],
                            },
                            {
                                type: 'button',
                                sub_type: 'quick_reply',
                                index: '0',
                                parameters: [{ type: 'payload', payload: partyId }],
                            },
                        ],
                    },
                }),
            }),
        );

        if (response.ok) {
            const parsed = sendResponseSchema.safeParse(await response.json());
            const waMessageId = parsed.success ? parsed.data.messages[0]?.id : undefined;
            if (!waMessageId) {
                throw new Error('WhatsApp template send: unexpected response shape');
            }
            return waMessageId;
        }

        const body = await response.json().catch(() => null);
        const graphError = graphErrorSchema.safeParse(body);
        const errorCode = graphError.success ? graphError.data.error.code : null;
        progress.event(
            `${RED}Ошибка WhatsApp API для ${to}: http ${response.status}, код ${errorCode ?? 'n/a'} — ${JSON.stringify(body)}${RESET}`,
            console.error,
        );
        if (errorCode === MARKETING_OPT_OUT_ERROR_CODE) {
            await updateGuestMarketingEnableOff(client, to);
            progress.event(
                `${YELLOW}${to} отписался от рассылок (код ${MARKETING_OPT_OUT_ERROR_CODE}) — согласие снято в базе${RESET}`,
            );
            return null;
        }
        if (errorCode === SPAM_RESTRICTION_ERROR_CODE) {
            progress.clearLine();
            console.error(
                `${RED}Стоп: наш номер ограничен за спам (код ${SPAM_RESTRICTION_ERROR_CODE}) — проверь качество в WhatsApp Manager${RESET}`,
            );
            process.exit(1);
        }
        if (
            response.status < 500 &&
            (errorCode === null || !TEMPORARY_ERROR_CODES.has(errorCode))
        ) {
            return null;
        }
        if (attempt < SEND_MAX_ATTEMPTS) {
            const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
            progress.event(
                `${YELLOW}Повтор ${attempt}/${SEND_MAX_ATTEMPTS} для ${to} через ${delayMs} мс${RESET}`,
            );
            await sleep(delayMs);
        }
    }
    progress.clearLine();
    console.error(
        `${RED}Стоп: WhatsApp троттлит — ${to} не ушёл за ${SEND_MAX_ATTEMPTS} попытки${RESET}`,
    );
    process.exit(1);
}

async function selectOrCreateGuest(waPhone: string): Promise<GuestStorage> {
    const existing = await selectGuestByPhone(client, waPhone);
    if (existing) {
        return existing;
    }
    try {
        await insertGuest(client, {
            id: ulid(),
            wa_phone: waPhone,
            first_name: null,
            last_name: null,
            instagram: null,
            came_from: 'party_invite',
            came_at: toDateTime(new Date()),
            lang: null,
            instagram_asked_at: null,
            marketing_enable: true,
        });
    } catch (error) {
        if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
            throw error;
        }
    }
    return selectOrCreateGuest(waPhone);
}

// Сеть (VPN) может пропасть посреди рассылки: ждём её возврата, а не падаем — иначе номер зависнет в чекпоинте как «sending».
async function waitForNetwork(request: () => Promise<Response>): Promise<Response> {
    for (;;) {
        try {
            return await request();
        } catch (error) {
            progress.event(
                `${YELLOW}Сеть недоступна (${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)}) — жду ${NETWORK_RETRY_MS / 1000} с и пробую снова${RESET}`,
                console.error,
            );
            await sleep(NETWORK_RETRY_MS);
        }
    }
}
