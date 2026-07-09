import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Agent } from '../../src/intelligence/agent.ts';
import type { DialogResult } from './harness.ts';
import { runDialog } from './harness.ts';
import type { Scenario } from './scenarios.ts';
import { scenarios } from './scenarios.ts';

const OUTPUT_DIR = join(process.cwd(), 'tests', 'output', 'nextstep');
const CONCURRENCY = 4;

interface RunResult {
    scenario: string;
    rep: number;
    checks: Record<string, boolean>;
    error?: string;
}

const parseArgs = () => {
    const args = process.argv.slice(2);
    const repsIndex = args.indexOf('--reps');
    const reps = repsIndex >= 0 ? parseInt(args[repsIndex + 1], 10) || 1 : 3;
    const scenariosIndex = args.indexOf('--scenarios');
    const scenarioKeys = scenariosIndex >= 0 ? args[scenariosIndex + 1].split(',') : null;
    const systemIndex = args.indexOf('--system');
    const systemPath = systemIndex >= 0 ? args[systemIndex + 1] : null;
    return { reps, scenarioKeys, systemPath };
};

const saveTranscript = async (
    label: string,
    scenario: Scenario,
    rep: number,
    result: DialogResult,
    checks: Record<string, boolean>,
) => {
    const lines = [
        `# ${label} / ${scenario.key} / rep ${rep}`,
        '',
        '## Checks',
        ...Object.entries(checks).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'} ${k}`),
        '',
        '## Transcript',
        ...result.transcript.map((t) => `**${t.role}:** ${t.text}`),
        '',
        '## Tool calls',
        ...result.state.toolCalls.map((c) => `- ${c.name} ${JSON.stringify(c.input)}`),
        '',
        '## Final state',
        '```json',
        JSON.stringify(
            {
                guest: result.state.guest,
                guestlist: result.state.guestlist,
                bookedTables: result.state.bookedTables,
            },
            null,
            2,
        ),
        '```',
    ];
    await writeFile(join(OUTPUT_DIR, `${label}--${scenario.key}--r${rep}.md`), lines.join('\n'));
};

const runOne = async (label: string, scenario: Scenario, rep: number): Promise<RunResult> => {
    const started = process.hrtime();
    try {
        const result = await runDialog(scenario.guest, scenario.turns);
        const checks: Record<string, boolean> = {};
        for (const [name, check] of Object.entries(scenario.checks)) {
            checks[name] = check(result);
        }
        await saveTranscript(label, scenario, rep, result, checks);
        const [sec, nano] = process.hrtime(started);
        const passed = Object.values(checks).filter(Boolean).length;
        console.log(
            `[nextstep] ${scenario.key} r${rep} — ${passed}/${Object.keys(checks).length} — ${sec}s ${Math.round(nano / 1e6)}ms`,
        );
        return { scenario: scenario.key, rep, checks };
    } catch (error) {
        console.error(`[nextstep] ${scenario.key} r${rep} FAILED`, error);
        return { scenario: scenario.key, rep, checks: {}, error: String(error) };
    }
};

const main = async () => {
    const { reps, scenarioKeys, systemPath } = parseArgs();
    const selectedScenarios = scenarioKeys
        ? scenarios.filter((s) => scenarioKeys.includes(s.key))
        : scenarios;

    const label = systemPath ? basename(systemPath, extname(systemPath)) : 'prod';
    if (systemPath) {
        Agent.system = readFileSync(systemPath, 'utf8');
    }

    await mkdir(OUTPUT_DIR, { recursive: true });

    const jobs: (() => Promise<RunResult>)[] = [];
    for (const scenario of selectedScenarios) {
        for (let rep = 1; rep <= reps; rep++) {
            jobs.push(() => runOne(label, scenario, rep));
        }
    }
    console.log(`[nextstep] running ${jobs.length} dialogs (concurrency ${CONCURRENCY})`);

    const results: RunResult[] = [];
    let cursor = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++];
            results.push(await job());
        }
    });
    await Promise.all(workers);

    console.log('\n=== SUMMARY ===');
    let passed = 0;
    let total = 0;
    for (const r of results) {
        for (const ok of Object.values(r.checks)) {
            total++;
            if (ok) passed++;
        }
    }
    const errored = results.filter((r) => r.error).length;
    const rate = total ? Math.round((passed / total) * 100) : 0;
    console.log(`${label}: ${passed}/${total} (${rate}%)${errored ? ` errors=${errored}` : ''}`);
    for (const scenario of selectedScenarios) {
        const runs = results.filter((r) => r.scenario === scenario.key);
        const byCheck: Record<string, string> = {};
        for (const name of Object.keys(scenario.checks)) {
            const ok = runs.filter((r) => r.checks[name]).length;
            byCheck[name] = `${ok}/${runs.length}`;
        }
        console.log(
            `  ${scenario.key}: ${Object.entries(byCheck)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')}`,
        );
    }

    const resultsPath = join(OUTPUT_DIR, `results-${Date.now()}.json`);
    await writeFile(
        resultsPath,
        JSON.stringify({ model: process.env.ANTHROPIC_MODEL, results }, null, 2),
    );
    console.log(`\n[nextstep] results → ${resultsPath}`);
};

await main();
