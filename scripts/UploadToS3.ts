// Заливка одного файла в S3.
//   pnpm exec tsx --conditions=development --env-file=.env.prod scripts/UploadToS3.ts /absolute/path/poster.jpg
// Печатает s3://<key> — это значение и кладём в party.marketing_message.image.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { uploadToS3 } from '#Lib/S3.js';

const CONTENT_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
};

const args = process.argv.slice(2);
if (args.length !== 1) {
    console.error('usage: UploadToS3.ts <absolute-path-to-file>  (ровно один файл)');
    process.exit(1);
}

const [path] = args;
if (!path || !isAbsolute(path)) {
    console.error(`✗ нужен полный путь, получен: ${path}`);
    process.exit(1);
}

if (!existsSync(path)) {
    console.error(`✗ файл не найден: ${path}`);
    process.exit(1);
}

if (!statSync(path).isFile()) {
    console.error(`✗ не файл: ${path}`);
    process.exit(1);
}

const type = CONTENT_TYPES[extname(path).toLowerCase()];
if (!type) {
    console.error(
        `✗ неизвестный тип ${extname(path)}, поддерживаются: ${Object.keys(CONTENT_TYPES).join(', ')}`,
    );
    process.exit(1);
}

const reference = await uploadToS3(new Blob([readFileSync(path)], { type }));
console.log(reference);
