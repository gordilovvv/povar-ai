// Проба промпта: гоняет варианты и печатает одну плотную сигнатуру на вариант.
// Зелёный вариант = одна строка. Красный = строка + только отклонения, без транскриптов.
// Запуск: npx tsx --conditions=development --env-file=.env.dev tests/probes/arena/run.ts

import { createHash } from 'node:crypto';
import { RULES } from './Rules.ts';
import { type Run, runOnce, SCENARIOS, VARIANTS, type VariantName } from './Sut.ts';

const REPS = 3;

const main = async (): Promise<void> => {
    for (const variant of Object.keys(VARIANTS) as VariantName[]) {
        const startedAt = process.hrtime();

        const runs: Run[] = [];
        for (const scenario of SCENARIOS) {
            for (let rep = 0; rep < REPS; rep++) {
                runs.push(await runOnce(variant, scenario, rep));
            }
        }

        const [sec] = process.hrtime(startedAt);
        console.log(sign(variant, runs, sec));
    }
};

const sign = (variant: VariantName, runs: Run[], sec: number): string => {
    const hash = createHash('sha256').update(VARIANTS[variant]).digest('hex').slice(0, 6);

    const failures: string[] = [];
    const na: string[] = [];

    for (const rule of RULES) {
        const observed = runs.filter((run) => rule.observable(run));
        if (!observed.length) {
            na.push(rule.id);
            continue;
        }

        const bad = observed
            .map((run) => ({ run, result: rule.check(run) }))
            .filter((item) => !item.result.pass);
        if (!bad.length) {
            continue;
        }

        const where = bad.map((item) => `${item.run.scenario}#${item.run.rep}`).join(',');
        // одной улики хватает: три парафраза одного слома стоят токенов и не добавляют фактов
        const evidence = bad.find((item) => item.result.ev)?.result.ev ?? '';
        failures.push(
            `F ${rule.id}:${rule.tier} ${bad.length}/${observed.length} ${where} ${evidence}`,
        );
    }

    const naCount = na.length;
    const head = `${failures.length ? 'FAIL' : 'OK  '} ${variant} sys@${hash} r${REPS} ${RULES.length - naCount}rules(${naCount}na) ${sec}s`;
    if (!failures.length) {
        return head;
    }

    const traces = SCENARIOS.map((scenario) => {
        const routes = new Map<string, number>();
        for (const run of runs.filter((item) => item.scenario === scenario.id)) {
            const route = run.calls.length
                ? run.calls
                      .map((call) => `${call.name[0]}{${Object.values(call.input).join(' ')}}`)
                      .join(',')
                : '∅';
            routes.set(route, (routes.get(route) ?? 0) + 1);
        }
        const histogram = [...routes].map(([route, count]) => `${route}×${count}`).join(' | ');
        return `T ${scenario.id} ${histogram}`;
    });

    return [head, ...traces, ...failures, na.length ? `NA ${na.join(',')}` : '']
        .filter(Boolean)
        .join('\n');
};

await main();
