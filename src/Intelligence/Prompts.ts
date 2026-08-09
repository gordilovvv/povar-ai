import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Промт-ассеты из Prompts/. Читаются один раз при старте процесса:
 * пропавший файл роняет приложение сразу, а не на первом ходе агента.
 */
export class Prompts {
    private static readonly DIR = join(import.meta.dirname, 'Prompts');

    static readonly system = Prompts.read('system.md');
    static readonly newGuest = Prompts.read('new-guest.md');
    static readonly knownGuest = Prompts.read('known-guest.md');
    static readonly tools = Prompts.read('tools.md');

    private static read(file: string) {
        return readFileSync(join(Prompts.DIR, file), 'utf8');
    }
}
