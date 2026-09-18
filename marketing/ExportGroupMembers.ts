import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';

import { BOLD, normalizePhone, RED, RESET, YELLOW } from './Utils.js';

const [outPath] = process.argv.slice(2);
if (!outPath) {
    console.error(
        `${RED}usage: pnpm exec tsx --conditions=development marketing/ExportGroupMembers.ts <out-file>  (e.g. marketing/db/whatsapp-group.txt)\n` +
            `open WhatsApp Web in chrome-devtools browser, group → "Поиск участников" dialog must be open${RESET}`,
    );
    process.exit(1);
}

// Список в диалоге виртуализирован: в DOM только видимые карточки, поэтому скроллим до конца и копим.
const browserScript = `async () => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error('dialog "Поиск участников" is not open');
    const scroller = [...dialog.querySelectorAll('*')].find(
        (el) => el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== 'visible',
    );
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const collect = (acc) => {
        for (const card of dialog.querySelectorAll('[role="button"]')) {
            const leaves = [...card.querySelectorAll('span,div')]
                .filter((el) => el.children.length === 0 && el.textContent.trim())
                .map((el) => el.textContent.trim());
            if (leaves.length) acc.set(leaves.join('\\t'), leaves);
        }
    };
    const acc = new Map();
    if (!scroller) { collect(acc); return [...acc.values()]; }
    scroller.scrollTop = 0;
    await sleep(300);
    let stale = 0;
    while (stale < 3) {
        const before = acc.size;
        collect(acc);
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        scroller.scrollTop += scroller.clientHeight * 0.8;
        await sleep(250);
        stale = acc.size === before && atBottom ? stale + 1 : 0;
    }
    return [...acc.values()];
}`;

const raw = execFileSync(
    'pnpm',
    ['exec', 'chrome-devtools', 'evaluate_script', browserScript, '--output-format=json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const { message } = z
    .object({ message: z.string() })
    .parse(JSON.parse(raw.trim().split('\n').at(-1) ?? ''));
const fenced = /```json\n([\s\S]*?)\n```/.exec(message)?.[1];
if (!fenced) {
    console.error(`${RED}fatal: unexpected chrome-devtools output:\n${message}${RESET}`);
    process.exit(1);
}
const cards = z.array(z.array(z.string())).parse(JSON.parse(fenced));

const rows: string[] = [];
const noPhone: string[] = [];
for (const leaves of cards) {
    const phoneIdx = leaves.findIndex((t) => /^\+[\d\s().-]+$/.test(t));
    if (phoneIdx === -1) {
        noPhone.push(leaves[0] ?? '?');
        continue;
    }
    const phone = normalizePhone(leaves[phoneIdx] ?? '');
    if (phone === null) {
        noPhone.push(leaves.join(' '));
        continue;
    }
    const name = leaves
        .filter((_, i) => i !== phoneIdx)
        .join(' ')
        .replace(/^~\s*/, '')
        .replace(/\s+На связи$/, '')
        .trim();
    rows.push(name ? `${phone}\t${name}` : phone);
}

writeFileSync(outPath, `${rows.join('\n')}\n`);
console.log(`${BOLD}${rows.length} members with phone → ${outPath}${RESET}`);
if (noPhone.length) {
    console.log(
        `${YELLOW}${noPhone.length} without visible phone (saved contacts), skipped:${RESET}`,
    );
    for (const n of noPhone) console.log(`  ${n}`);
}
