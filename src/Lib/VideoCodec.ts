import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const videoCodec = async (video: Blob): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'video-codec-'));
    try {
        const path = join(dir, 'video.mp4');
        writeFileSync(path, Buffer.from(await video.arrayBuffer()));
        return execFileSync(
            'ffprobe',
            [
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=codec_name',
                '-of',
                'csv=p=0',
                path,
            ],
            { encoding: 'utf8' },
        ).trim();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};
