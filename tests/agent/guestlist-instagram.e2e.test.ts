import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PARTIES, runDialog } from '../nextstep/harness.ts';

// одна активная вечеринка — убираем ветку выбора party, изолируем гейт по инсте
const ONE_PARTY = { parties: PARTIES.slice(1) };

const semaText = (r: Awaited<ReturnType<typeof runDialog>>): string =>
    r.transcript
        .filter((t) => t.role === 'sema')
        .map((t) => t.text)
        .join('\n')
        .toLowerCase();

const askedInsta = (out: string): boolean => /инст|insta/.test(out);

describe('e2e: guestlist — инстаграм обязателен для добавления', () => {
    it('имя без инсты → в гест-лист не попал, инсту спросили', { timeout: 90_000 }, async () => {
        const r = await runDialog({ lang: 'ru' }, ['Бро хочу на LYLO', 'Igor Gordilov'], ONE_PARTY);
        assert.equal(
            r.state.guestlist.length,
            0,
            `без инсты не должен быть в листе: ${semaText(r)}`,
        );
        assert.ok(askedInsta(semaText(r)), `должен спросить инсту: ${semaText(r)}`);
    });

    it('имя + инста → в гест-листе', { timeout: 90_000 }, async () => {
        const r = await runDialog(
            { lang: 'ru' },
            ['Бро хочу на LYLO', 'Igor Gordilov, инста @igor.g'],
            ONE_PARTY,
        );
        assert.ok(r.state.guestlist.length > 0, `должен попасть в гест-лист: ${semaText(r)}`);
        assert.ok(r.state.guest.instagram_url, 'инста должна сохраниться');
    });
});
