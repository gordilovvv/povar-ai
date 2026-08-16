import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { insertWaChat, selectWaChat, updateWaChatLastSent } from '#Db/WaChats.js';
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
    fmtMmSs,
    GRAY,
    normalizePhone,
    RED,
    RESET,
    readCheckpoint,
    YELLOW,
} from './Utils.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const DUBAI_TZ = 'Asia/Dubai';
const LIVE_CHAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEND_INTERVAL_MS = 1000;
const SEND_LIMIT = 250;
const MESSAGING_LIMIT_WINDOW_HOURS = 24;
const WA_API_VERSION = 'v21.0';
const TEMPLATE_NAME = 'party_invite';
const SEND_MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 5_000;
const TEMPORARY_ERROR_CODES = new Set([80007, 130429, 131056]);
const SPAM_RESTRICTION_ERROR_CODE = 131048;
const MARKETING_OPT_OUT_ERROR_CODE = 131050;

const sendResponseSchema = z.looseObject({
    messages: z.array(z.looseObject({ id: z.string() })).min(1),
});
const graphErrorSchema = z.looseObject({ error: z.looseObject({ code: z.number() }) });

const [partyId, numbersPath] = process.argv.slice(2);
if (!partyId || !numbersPath) {
    console.error(
        `${RED}usage: pnpm exec tsx --conditions=development --env-file=.env.prod marketing/StartMarketing.ts <party_id> <numbers-file>${RESET}`,
    );
    process.exit(1);
}
if (!existsSync(numbersPath)) {
    console.error(`${RED}fatal: numbers file not found: ${numbersPath}${RESET}`);
    process.exit(1);
}
if (env.WA_SEND !== 'on') {
    console.error(`${RED}fatal: WA_SEND is off, refusing to run${RESET}`);
    process.exit(1);
}

const checkpointPath = join(import.meta.dirname, `.marketing-${partyId}.state`);
const checkpoint = readCheckpoint(checkpointPath);

const client = await pool.connect();

const party = (await selectActivePartiesWithTimes(client)).find((row) => row.id === partyId);
if (!party) {
    console.error(`${RED}fatal: active party not found: ${partyId}${RESET}`);
    process.exit(1);
}
const marketingMessage = marketingMessageSchema.safeParse(party.marketing_message);
if (!marketingMessage.success) {
    console.error(
        `${RED}fatal: party.marketing_message is missing or invalid for ${partyId} — fill it before the broadcast${RESET}`,
    );
    console.error(marketingMessage.error.message);
    process.exit(1);
}
const marketingImage = await downloadFromS3(marketingMessage.data.image).catch(
    (error: Error) => error,
);
if (marketingImage instanceof Error) {
    console.error(
        `${RED}fatal: marketing image ${marketingMessage.data.image} is not readable — ${marketingImage.message}${RESET}`,
    );
    process.exit(1);
}

const partyDate = dayjs(party.party_start_at).tz(DUBAI_TZ).format('MMMM D (dddd)');
const partyVenue = party.location.split(',')[0]?.trim() ?? party.location;
console.log(`${BOLD}broadcast ${partyId}${RESET}`);
console.log(`party: ${party.name} | ${partyDate} | ${partyVenue}`);
console.log(
    `marketing image: ${marketingMessage.data.image} ${marketingImage.type} ${Math.round(marketingImage.size / 1024)}KB`,
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
const sendBudget = SEND_LIMIT - recipientsLast24h;
console.log(
    `messaging tier: ${SEND_LIMIT}/24h (hardcoded), used ${recipientsLast24h}, budget ${sendBudget}`,
);
if (sendBudget <= 0) {
    console.error(
        `${RED}fatal: 24h messaging limit spent (${recipientsLast24h}/${SEND_LIMIT})${RESET}`,
    );
    process.exit(1);
}

const templateText = `Hi, it's Sam Povar ✌️\n\nI'm throwing a party this week — ${partyDate} at ${partyVenue}.\n\nI'd love to see you there! Sign up for the guest list below.`;
console.log(
    `${GRAY}template ${TEMPLATE_NAME}/en, params: [${partyDate}] [${partyVenue}], button payload ${partyId}${RESET}`,
);

const phones = readFileSync(numbersPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
        const phone = normalizePhone(line);
        if (phone === null) {
            console.error(`${RED}fatal: broken phone line in ${numbersPath}: ${line}${RESET}`);
            process.exit(1);
        }
        return phone;
    });

const skipped = new Set<string>();
let sentCount = 0;
let failedCount = 0;

const inCheckpoint = phones.filter((phone) => checkpoint.has(phone)).length;
const toProcess = Math.min(phones.length - inCheckpoint, sendBudget);
console.log(
    `${BOLD}plan: ${phones.length} numbers in file, ${inCheckpoint} already in checkpoint, ${toProcess} to process, budget ${sendBudget}${RESET}`,
);
console.log(`${GRAY}checkpoint: ${checkpointPath}${RESET}`);
console.log(
    `${GRAY}pacing ${SEND_INTERVAL_MS}ms, retries ${SEND_MAX_ATTEMPTS}, backoff base ${BACKOFF_BASE_MS}ms${RESET}`,
);

const loopStartedAtMs = Date.now();
const progress = new Progress(phones.length - inCheckpoint, sendBudget, loopStartedAtMs, () => ({
    sent: sentCount,
    failed: failedCount,
    skipped: skipped.size,
}));
progress.draw();

for (const phone of phones) {
    if (sentCount >= sendBudget) {
        progress.event(
            `${YELLOW}budget limit reached: ${sentCount}/${sendBudget} sent, stopping${RESET}`,
        );
        break;
    }
    if (checkpoint.has(phone) || skipped.has(phone)) {
        continue;
    }

    const guest = await selectOrCreateGuest(phone);
    if (!guest.marketing_enable) {
        skipped.add(phone);
        progress.event(`${GRAY}skip ${phone} — no marketing consent${RESET}`);
        continue;
    }
    const chat = await selectWaChat(client, phone);
    if (chat) {
        const liveChatBoundary = toDateTime(Date.now() - LIVE_CHAT_WINDOW_MS);
        if (
            chat.paused_at !== null ||
            (chat.last_received_message_at !== null &&
                toDateTime(chat.last_received_message_at) > liveChatBoundary)
        ) {
            skipped.add(phone);
            const reason = chat.paused_at !== null ? 'paused' : 'live chat <24h';
            progress.event(`${GRAY}skip ${phone} — ${reason}${RESET}`);
            continue;
        }
    } else {
        try {
            await insertWaChat(client, phone, guest.id);
        } catch (error) {
            if ((error as { code?: string }).code !== UNIQUE_ERROR_CODE) {
                throw error;
            }
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
        progress.event(`${RED}fail ${phone} — send rejected, see error above${RESET}`);
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
    progress.event(`${GRAY}sent ${phone} ${waMessageId} ${sendMs}ms${RESET}`);
    await sleep(SEND_INTERVAL_MS);
}

progress.finish();

const untouched = phones.filter((phone) => !checkpoint.has(phone) && !skipped.has(phone)).length;
const elapsedSec = Math.round((Date.now() - loopStartedAtMs) / 1000);
console.log(`${BOLD}done ${partyId} in ${fmtMmSs(elapsedSec)}${RESET}`);
console.log(
    `${BOLD}sent ${sentCount}  failed ${failedCount}  skipped ${skipped.size}  untouched ${untouched}${RESET}`,
);
console.log(`${BOLD}budget left ${sendBudget - sentCount}/${sendBudget}${RESET}`);
if (sentCount === 0) {
    console.log(`${RED}nothing delivered${RESET}`);
} else if (failedCount > 0) {
    console.log(`${YELLOW}delivery degraded: ${failedCount} rejected by Meta${RESET}`);
} else {
    console.log('delivery ok: no send errors');
}
if (untouched > 0) {
    console.log(
        `${YELLOW}${untouched} numbers left — rerun the same command to continue from checkpoint${RESET}`,
    );
}
client.release();
await pool.end();

async function sendTemplate(to: string): Promise<string | null> {
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
        const response = await fetch(
            `https://graph.facebook.com/${WA_API_VERSION}/${env.WA_PHONE_ID}/messages`,
            {
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
            },
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
            `${RED}http ${response.status} code ${errorCode ?? 'n/a'} ${to} ${JSON.stringify(body)}${RESET}`,
            console.error,
        );
        if (errorCode === MARKETING_OPT_OUT_ERROR_CODE) {
            await updateGuestMarketingEnableOff(client, to);
            progress.event(
                `${YELLOW}${to} opted out of marketing (${MARKETING_OPT_OUT_ERROR_CODE}), consent revoked${RESET}`,
            );
            return null;
        }
        if (errorCode === SPAM_RESTRICTION_ERROR_CODE) {
            progress.clearLine();
            console.error(
                `${RED}fatal: number is spam-restricted (${SPAM_RESTRICTION_ERROR_CODE}) — check quality in WhatsApp Manager${RESET}`,
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
                `${YELLOW}retry ${attempt}/${SEND_MAX_ATTEMPTS} ${to} in ${delayMs}ms${RESET}`,
            );
            await sleep(delayMs);
        }
    }
    progress.clearLine();
    console.error(`${RED}fatal: throttled — ${to} not sent in ${SEND_MAX_ATTEMPTS} tries${RESET}`);
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
