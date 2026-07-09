import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PoolClient } from 'pg';
import pg from 'pg';

const OUTPUT_DIR = join(process.cwd(), 'tests', 'output');

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`[e2e] missing env ${name} — запусти через node --env-file-if-exists=.env`);
    }
    return value;
}

let poolRef: pg.Pool | null = null;

function pool(): pg.Pool {
    if (!poolRef) {
        poolRef = new pg.Pool({ connectionString: requiredEnv('DATABASE_URL') });
    }
    return poolRef;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool().connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
}

export async function dbQuery<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
): Promise<T[]> {
    const result = await pool().query(sql, params);
    return result.rows as T[];
}

export async function dbOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
): Promise<T | null> {
    const rows = await dbQuery<T>(sql, params);
    return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
    if (poolRef) {
        await poolRef.end();
        poolRef = null;
    }
}

export function fmt(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const millis = Math.round(ms - seconds * 1000);
    return `${seconds}s ${millis}ms`;
}

export async function measure<T>(
    label: string,
    fn: () => Promise<T>,
): Promise<{ result: T; ms: number }> {
    const start = process.hrtime.bigint();
    const result = await fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`[e2e] ${label} — ${fmt(ms)}`);
    return { result, ms };
}

export function assertBudget(actualMs: number, budgetMs: number, label: string): void {
    if (actualMs > budgetMs) {
        throw new Error(`[e2e] budget exceeded: ${label} took ${fmt(actualMs)} > ${fmt(budgetMs)}`);
    }
}

export async function saveArtifact(name: string, data: Buffer | string): Promise<string> {
    const path = join(OUTPUT_DIR, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    console.log(`[e2e] artifact → ${path}`);
    return path;
}
