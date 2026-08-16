import { fmtMmSs, RESET } from './Utils.js';

export type ProgressStats = { sent: number; failed: number; skipped: number };

export class Progress {
    private static readonly BAR_WIDTH = 30;
    private static readonly NON_TTY_PROGRESS_EVERY = 25;
    private static readonly IS_TTY = process.stdout.isTTY === true;

    private readonly total: number;
    private readonly budget: number;
    private readonly startedAtMs: number;
    private readonly stats: () => ProgressStats;
    private barPending = false;
    private lastNonTtyProgress = -1;

    constructor(total: number, budget: number, startedAtMs: number, stats: () => ProgressStats) {
        this.total = total;
        this.budget = budget;
        this.startedAtMs = startedAtMs;
        this.stats = stats;
        process.on('exit', () => {
            if (this.barPending) {
                process.stdout.write(`\n${RESET}`);
            }
        });
    }

    draw() {
        const { sent, failed, skipped } = this.stats();
        const processed = sent + failed + skipped;
        if (!Progress.IS_TTY) {
            if (
                processed > 0 &&
                processed % Progress.NON_TTY_PROGRESS_EVERY === 0 &&
                processed !== this.lastNonTtyProgress
            ) {
                this.lastNonTtyProgress = processed;
                console.log(
                    `progress ${processed}/${this.total} sent ${sent}/${this.budget} fail ${failed} skip ${skipped}`,
                );
            }
            return;
        }
        const elapsedSec = (Date.now() - this.startedAtMs) / 1000;
        const rate = processed > 0 && elapsedSec > 0 ? processed / elapsedSec : 0;
        const rateLabel = rate > 0 ? rate.toFixed(1) : '0.0';
        const eta = rate > 0 ? fmtMmSs(Math.round((this.total - processed) / rate)) : '--:--';
        const filled =
            this.total > 0
                ? Math.min(
                      Progress.BAR_WIDTH,
                      Math.round((processed / this.total) * Progress.BAR_WIDTH),
                  )
                : Progress.BAR_WIDTH;
        const bar = '█'.repeat(filled) + '░'.repeat(Progress.BAR_WIDTH - filled);
        const pad = String(this.total).length;
        process.stdout.write(
            `\r\x1b[2K[${bar}] ${String(processed).padStart(pad)}/${this.total}  sent ${sent}/${this.budget}  fail ${failed}  skip ${skipped}  ${rateLabel}/s  eta ${eta}`,
        );
        this.barPending = true;
    }

    event(line: string, log: (line: string) => void = console.log) {
        this.clearLine();
        log(line);
        this.draw();
    }

    clearLine() {
        if (Progress.IS_TTY && this.barPending) {
            process.stdout.write('\r\x1b[2K');
            this.barPending = false;
        }
    }

    finish() {
        this.draw();
        if (Progress.IS_TTY && this.barPending) {
            process.stdout.write('\n');
            this.barPending = false;
        }
    }
}
