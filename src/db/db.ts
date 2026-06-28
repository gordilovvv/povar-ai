import { Pool } from 'pg';
import { env } from '../../environment.ts';

export const pool = new Pool({
    connectionString: env.DATABASE_URL,
    min: 0,
    max: 3,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
});

export const UNIQUE_ERROR_CODE = '23505';
