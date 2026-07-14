import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PARTIES, runDialog } from './nextstep/harness.ts';

const ONE_PARTY = { parties: PARTIES.slice(1) };

const semaText = (r: Awaited<ReturnType<typeof runDialog>>): string =>
    r.transcript
        .filter((t) => t.role === 'sema')
        .map((t) => t.text)
        .join('\n')
        .toLowerCase();

describe('e2e: venue — закрытый клуб, не терраса (не выдумывает)', () => {
    it('на вопрос «это терраса?» — отрицает и описывает закрытый клуб', {
        timeout: 90_000,
    }, async () => {
        const r = await runDialog(
            { lang: 'ru' },
            ['Привет! Хочу на LYLO', 'А что за заведение? Это терраса на воде с видом на залив?'],
            ONE_PARTY,
        );
        const out = semaText(r);
        // гость сам сказал «терраса на воде» — агент должен ОТРИЦАТЬ (эхо-отрицание не караем)
        assert.match(
            out,
            /не\s+терас|не\s+терра|закрыт|внутри рестор|скрыт/,
            `должен отрицать террасу: ${out}`,
        );
        assert.match(
            out,
            /закрыт|внутри|скрыт|speakeasy|спикизи|клуб/,
            `должен описать как клуб: ${out}`,
        );
    });

    it('описывает как закрытый клуб внутри ресторана', { timeout: 90_000 }, async () => {
        const r = await runDialog(
            { lang: 'ru' },
            ['Привет! Хочу на LYLO', 'Расскажи что за место'],
            ONE_PARTY,
        );
        const out = semaText(r);
        assert.match(
            out,
            /закрыт|внутри|скрыт|speakeasy|спикизи|танцпол|бар/,
            `нет признаков клуба: ${out}`,
        );
    });
});
