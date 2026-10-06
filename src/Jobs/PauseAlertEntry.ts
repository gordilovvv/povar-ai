import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
import { z } from 'zod';

// TODO: #-импорты в треде работают (tsx, tsx watch, dist) — падало на environment.ts без --env-file. Перевести на pool из #Db/Pool.js и env из #environment.js, убрать workerData и свой Pool.

export interface PauseAlertJobConfig {
    databaseUrl: string;
    telegramBotToken: string;
    telegramGroupId: string;
}

interface PausedChatRow {
    wa_phone: string;
    pause_details: string | null;
    first_name: string | null;
    last_name: string | null;
}

const TICK_INTERVAL_MS = 60_000;
// Потолок отправок за тик — защита от flood-лимита Telegram (~20 сообщений/мин в группу).
// Остаток паузнутых чатов уедет следующими тиками.
export const CLAIM_LIMIT = 20;
const telegramResponse = z.object({ ok: z.boolean(), description: z.string().optional() });

// MarkdownV2: эти символы в обычном тексте Telegram требует экранировать, иначе 400 «can't parse entities».
const MD_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const escapeMd = (value: string) => value.replace(MD_SPECIAL, '\\$&');

// Захват ДО отправки — сам себе замок: параллельный тик пропустит залоченные строки (skip locked).
// Ре-пауза после снятия: paused_at обновляется на свежее время > старого pause_alerted_at → алерт повторится.
const claimPausedChats = async (pool: pg.Pool) => {
    const result = await pool.query<PausedChatRow>(
        `update wa_chats gc set pause_alerted_at = now()
        where gc.wa_phone in (
            select wa_phone from wa_chats
            where paused_at is not null
                and (pause_alerted_at is null or pause_alerted_at < paused_at)
            order by paused_at
            limit ${CLAIM_LIMIT}
            for update skip locked
        )
        returning
            gc.wa_phone,
            gc.pause_details,
            (select g.first_name from guests g where g.id = gc.guest_id) as first_name,
            (select g.last_name from guests g where g.id = gc.guest_id) as last_name`,
    );
    return result.rows;
};

export const buildAlert = (name: string | null, phone: string, reason: string) => {
    const guest = name ? `${escapeMd(phone)} \\(${escapeMd(name)}\\)` : escapeMd(phone);
    return `🙋 *Нужен ответ*\n*Гость:* ${guest}\n*Причина:* ${escapeMd(reason)}`;
};

const sendTelegram = async (config: PauseAlertJobConfig, text: string) => {
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

export const runTick = async (pool: pg.Pool, config: PauseAlertJobConfig) => {
    const chats = await claimPausedChats(pool);
    for (const chat of chats) {
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim() || null;
        try {
            await sendTelegram(config, buildAlert(name, chat.wa_phone, chat.pause_details ?? '—'));
        } catch (error) {
            // Откат маркера — досыл на следующем тике (at-least-once).
            await pool.query('update wa_chats set pause_alerted_at = null where wa_phone = $1', [
                chat.wa_phone,
            ]);
            console.error(`[jobs] pause-alert ${chat.wa_phone} failed`, error);
        }
    }
};

if (parentPort) {
    const config = workerData as PauseAlertJobConfig;
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    const tick = async () => {
        try {
            await runTick(pool, config);
        } catch (error) {
            console.error('[jobs] pause-alert tick failed', error);
        }
    };
    void tick();
    setInterval(() => void tick(), TICK_INTERVAL_MS);
}
