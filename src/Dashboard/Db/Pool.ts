import { Pool } from 'pg';
import { env } from '#Dashboard/environment.js';

export const pool = new Pool({
    connectionString: env.DATABASE_URL,
    min: 0,
    max: 3,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
});
