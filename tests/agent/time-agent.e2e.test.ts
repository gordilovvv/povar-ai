import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDubai } from '#Lib/Time.js';
import { PARTIES, runDialog } from '../nextstep/harness.ts';

const RU_STEM: Record<string, string> = {
    Sunday: 'воскрес',
    Monday: 'понедельник',
    Tuesday: 'вторник',
    Wednesday: 'сред',
    Thursday: 'четверг',
    Friday: 'пятниц',
    Saturday: 'суббот',
};

const ruStem = (weekday: string): string => RU_STEM[weekday] ?? weekday;

const dubaiWeekday = (iso: string): string =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dubai', weekday: 'long' }).format(
        new Date(iso),
    );

// формат как у formatDubaiNow: "<Weekday> YYYY-MM-DD HH:mm:ss"
const dubaiNow = (iso: string): string => {
    const d = new Date(iso);
    const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
    const hms = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dubai',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(d);
    return `${dubaiWeekday(iso)} ${ymd} ${hms}`;
};

const semaText = (r: Awaited<ReturnType<typeof runDialog>>): string =>
    r.transcript
        .filter((t) => t.role === 'sema')
        .map((t) => t.text)
        .join('\n')
        .toLowerCase();

// "сегодня какой день" при разном времени суток: полночь, полдень, раннее утро
const TODAY_CASES = [
    { label: 'четверг в полночь 00:00', iso: '2026-07-15T20:00:00Z' },
    { label: 'среда в полдень 12:00', iso: '2026-07-15T08:00:00Z' },
    { label: 'пятница рано утром 06:00', iso: '2026-07-17T02:00:00Z' },
];

describe('e2e: agent — "какой сегодня день" при разном времени суток', () => {
    for (const c of TODAY_CASES) {
        it(c.label, { timeout: 60_000 }, async () => {
            const now = dubaiNow(c.iso);
            const r = await runDialog({ lang: 'ru' }, ['Слушай а какой сегодня день недели?'], {
                now,
            });
            const out = semaText(r);
            const stem = ruStem(dubaiWeekday(c.iso));
            assert.match(out, new RegExp(stem), `now="${now}" ждали "${stem}", получили: ${out}`);
        });
    }
});

// граница суток: тусовка в тот же календарный день, но день недели другой (частый источник ошибки)
const PARTY_CASES = [
    {
        label: 'тусовка в субботу 00:00 (ночь пятницы)',
        iso: '2026-07-17T20:00:00Z',
        forbid: 'Friday',
    },
    { label: 'тусовка в пятницу 23:00', iso: '2026-07-17T19:00:00Z', forbid: 'Saturday' },
    {
        label: 'тусовка в воскресенье 00:30 (ночь субботы)',
        iso: '2026-07-18T20:30:00Z',
        forbid: 'Saturday',
    },
];

describe('e2e: agent — день недели тусовки на границе суток', () => {
    for (const c of PARTY_CASES) {
        it(c.label, { timeout: 60_000 }, async () => {
            const lylo = PARTIES.slice(1).map((p) => ({
                ...p,
                when: [{ start: formatDubai(c.iso), free_entry_before: null }],
            }));
            const r = await runDialog(
                { lang: 'ru' },
                ['Хочу к вам на LYLO. А это в какой день недели?'],
                { parties: lylo },
            );
            const out = semaText(r);
            const want = ruStem(dubaiWeekday(c.iso));
            const forbid = ruStem(c.forbid);
            assert.match(
                out,
                new RegExp(want),
                `start="${formatDubai(c.iso)}" ждали "${want}": ${out}`,
            );
            assert.doesNotMatch(out, new RegExp(forbid), `не должно быть "${forbid}": ${out}`);
        });
    }
});
