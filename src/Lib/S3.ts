import { randomBytes } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '#environment.js';

const S3_DIR = 'povar-s3';
const S3_SCHEME = 's3://';

const s3Client = new S3Client({
    credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
    },
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
});

export const downloadFromS3 = async (reference: string): Promise<Blob> => {
    if (!reference.startsWith(S3_SCHEME)) {
        throw new Error(`not an s3 reference: ${reference}`);
    }
    const key = reference.slice(S3_SCHEME.length);
    const url = `${env.S3_PUBLIC_URL}/${S3_DIR}/${key}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`s3 download failed: ${response.status} ${url}`);
    }
    return response.blob();
};

export const uploadToS3 = async (file: Blob): Promise<string> => {
    const key = randomBytes(12).toString('hex');
    await s3Client.send(
        new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: `${S3_DIR}/${key}`,
            Body: Buffer.from(await file.arrayBuffer()),
            ContentType: file.type,
        }),
    );
    return `${S3_SCHEME}${key}`;
};
