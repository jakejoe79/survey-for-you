import type { PoolClient } from 'pg';

export type SurveyEntry = {
  id: number;
  user_id: number;
  platform_id: number;
  payout_cents: number;
  duration_seconds: number;
  completed_at_utc: string;
  write_source: string;
  created_at: string;
};

export async function insertSurveyEntry(
  client: PoolClient,
  params: {
    userId: number;
    platformId: number;
    payoutCents: number;
    durationSeconds: number;
    writeSource: string;
  },
): Promise<SurveyEntry> {
  const res = await client.query<SurveyEntry>(
    `
    INSERT INTO survey_entries (user_id, platform_id, payout_cents, duration_seconds, write_source)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING
      id, user_id, platform_id, payout_cents, duration_seconds,
      completed_at_utc, write_source, created_at
    `,
    [params.userId, params.platformId, params.payoutCents, params.durationSeconds, params.writeSource],
  );
  return res.rows[0]!;
}

