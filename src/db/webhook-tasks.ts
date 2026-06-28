import type { PoolClient } from 'pg';
import format from 'pg-format';

type WebhookPlatform = 'whatsapp' | 'instagram';

export interface WebhookTaskStorage {
    id: string;
    platform: WebhookPlatform;
    data: unknown;
    retry: number;
}

export const insertWebhookTask = async (
    client: PoolClient,
    id: string,
    platform: WebhookPlatform,
    data: unknown,
) => {
    await client.query(
        format(
            'insert into webhook_tasks (id, platform, data) values (%L, %L, %L::jsonb)',
            id,
            platform,
            JSON.stringify(data),
        ),
    );
};

export const selectPendingWebhookTasks = async (client: PoolClient, limit: number) => {
    const result = await client.query<WebhookTaskStorage>(
        format('select * from webhook_tasks where retry < 3 order by id limit %L', limit),
    );
    return result.rows;
};

export const deleteWebhookTask = async (client: PoolClient, id: string) => {
    await client.query(format('delete from webhook_tasks where id = %L', id));
};

export const incrementWebhookTaskRetry = async (client: PoolClient, id: string) => {
    await client.query(format('update webhook_tasks set retry = retry + 1 where id = %L', id));
};
