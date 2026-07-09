import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../../src/intelligence/agent.ts';
import { type DialogResult, runDialog } from '../nextstep/harness.ts';
import { type Scenario, scenarios } from '../nextstep/scenarios.ts';
import { variants } from './variants.ts';

const OUTPUT_DIR = join(process.cwd(), 'tests', 'output', 'venue');
const VENUE_KEYS = ['s9-venue-real', 's10-venue-en'];

const saveTranscript = async (
    variantKey: string,
    scenario: Scenario,
    rep: number,
    result: DialogResult,
    checks: Record<string, boolean>,
) => {
    const lines = [
        `# ${variantKey} / ${scenario.key} / rep ${rep}`,
        '',
        '## Checks',
        ...Object.entries(checks).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'} ${k}`),
        '',
        '## Transcript',
        ...result.transcript.map((t) => `**${t.role}:** ${t.text}`),
    ];
    await writeFile(
        join(OUTPUT_DIR, `${variantKey}--${scenario.key}--r${rep}.md`),
        lines.join('\n'),
    );
};

const main = async () => {
    const repsArg = process.argv[process.argv.indexOf('--reps') + 1];
    const reps = parseInt(repsArg ?? '', 10) || 2;
    const selected = scenarios.filter((s) => VENUE_KEYS.includes(s.key));
    await mkdir(OUTPUT_DIR, { recursive: true });

    for (const variant of variants) {
        Agent.system = variant.system;
        const tally: Record<string, [number, number]> = {};
        const jobs: Promise<void>[] = [];
        for (const scenario of selected) {
            for (let rep = 1; rep <= reps; rep++) {
                jobs.push(
                    (async () => {
                        const result = await runDialog(scenario.guest, scenario.turns);
                        const checks: Record<string, boolean> = {};
                        for (const [name, check] of Object.entries(scenario.checks)) {
                            checks[name] = check(result);
                            const key = `${scenario.key}.${name}`;
                            const [ok, total] = tally[key] ?? [0, 0];
                            tally[key] = [ok + (checks[name] ? 1 : 0), total + 1];
                        }
                        await saveTranscript(variant.key, scenario, rep, result, checks);
                    })(),
                );
            }
        }
        await Promise.all(jobs);
        console.log(`\n=== ${variant.key} (${variant.label}) ===`);
        for (const [key, [ok, total]] of Object.entries(tally)) {
            console.log(`  ${ok === total ? 'PASS' : 'FAIL'} ${key} ${ok}/${total}`);
        }
    }
    console.log(`\n[venue] transcripts → ${OUTPUT_DIR}`);
};

await main();
