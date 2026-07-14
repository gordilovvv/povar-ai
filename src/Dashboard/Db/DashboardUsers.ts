import type { PoolClient } from 'pg';
import format from 'pg-format';

export interface DashboardUserStorage {
    id: string;
    phone_number: string;
    created_at: string | null;
}

export const selectDashboardUser = async (client: PoolClient, id: string) => {
    const result = await client.query<DashboardUserStorage>(
        format('select * from dashboard_users where id = %L', id),
    );
    return result.rows.length ? result.rows[0] : null;
};
