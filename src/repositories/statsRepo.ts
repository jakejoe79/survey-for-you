import type { PoolClient } from 'pg';

export async function upsertPlatformStats(
  client: PoolClient,
  params: { userId: number; platformId: number },
): Promise<void> {
  await client.query(
    `
    INSERT INTO user_platform_stats (user_id, platform_id, use_count, last_used_at_utc)
    VALUES ($1, $2, 1, NOW())
    ON CONFLICT (user_id, platform_id)
    DO UPDATE SET
      use_count = user_platform_stats.use_count + 1,
      last_used_at_utc = EXCLUDED.last_used_at_utc
    `,
    [params.userId, params.platformId],
  );
}

export async function upsertDailyActivity(
  client: PoolClient,
  params: { userId: number; localDate: string; timezoneAtWrite: string },
): Promise<void> {
  await client.query(
    `
    INSERT INTO user_daily_activity (user_id, local_date, timezone_at_write, entry_count)
    VALUES ($1, $2::date, $3, 1)
    ON CONFLICT (user_id, local_date)
    DO UPDATE SET
      entry_count = user_daily_activity.entry_count + 1,
      timezone_at_write = EXCLUDED.timezone_at_write
    `,
    [params.userId, params.localDate, params.timezoneAtWrite],
  );
}

