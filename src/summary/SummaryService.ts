import type { PoolClient } from 'pg';
import { logError } from '../lib/logger';

export type Summary =
  | {
      status: 'ok';
      todayEarningsCents: number;
      todayTimeSeconds: number;
      todayRateCentsPerHour: number | null;
      historicalAvgRateCentsPerHour: number | null;
      streakDays: number;
    }
  | {
      status: 'degraded';
      message: string;
      todayEarningsCents: number | null;
      todayTimeSeconds: number | null;
      todayRateCentsPerHour: number | null;
      historicalAvgRateCentsPerHour: number | null;
      streakDays: number | null;
    };

function rateCentsPerHour(payoutCents: number, durationSeconds: number): number | null {
  if (durationSeconds <= 0) return null;
  return Math.floor((payoutCents * 3600) / durationSeconds);
}

export async function getAfterNewEntry(
  client: PoolClient,
  params: { userId: number; localDate: string; timezone: string },
): Promise<Summary> {
  try {
    const today = await client.query<{ payout: number; duration: number }>(
      `
      SELECT COALESCE(SUM(payout_cents), 0)::int AS payout,
             COALESCE(SUM(duration_seconds), 0)::int AS duration
      FROM survey_entries
      WHERE user_id = $1
        AND (completed_at_utc AT TIME ZONE $3)::date = $2::date
      `,
      [params.userId, params.localDate, params.timezone],
    );

    const todayEarningsCents = today.rows[0]!.payout;
    const todayTimeSeconds = today.rows[0]!.duration;

    const hist = await client.query<{ payout: number; duration: number }>(
      `
      SELECT COALESCE(SUM(payout_cents), 0)::int AS payout,
             COALESCE(SUM(duration_seconds), 0)::int AS duration
      FROM survey_entries
      WHERE user_id = $1
        AND (completed_at_utc AT TIME ZONE $3)::date >= ($2::date - 30)
      `,
      [params.userId, params.localDate, params.timezone],
    );
    const histRate = rateCentsPerHour(hist.rows[0]!.payout, hist.rows[0]!.duration);

    const streak = await computeStreakDays(client, { userId: params.userId, localDate: params.localDate });

    return {
      status: 'ok',
      todayEarningsCents,
      todayTimeSeconds,
      todayRateCentsPerHour: rateCentsPerHour(todayEarningsCents, todayTimeSeconds),
      historicalAvgRateCentsPerHour: histRate,
      streakDays: streak,
    };
  } catch (err) {
    logError({ event: 'summary_degraded', userId: params.userId, idempotencyId: null, attemptId: null }, { err: String(err) });
    return {
      status: 'degraded',
      message: 'Summary temporarily unavailable',
      todayEarningsCents: null,
      todayTimeSeconds: null,
      todayRateCentsPerHour: null,
      historicalAvgRateCentsPerHour: null,
      streakDays: null,
    };
  }
}

async function computeStreakDays(
  client: PoolClient,
  params: { userId: number; localDate: string },
): Promise<number> {
  // Scan backwards in user_daily_activity which is intentionally tiny.
  // This is a simple loop; optimize later if needed.
  let streak = 0;
  let cursor = params.localDate;

  // Hard cap to prevent pathological loops.
  for (let i = 0; i < 365; i++) {
    const res = await client.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM user_daily_activity
        WHERE user_id = $1
          AND local_date = $2::date
          AND entry_count >= 1
      ) AS exists
      `,
      [params.userId, cursor],
    );

    if (!res.rows[0]!.exists) break;
    streak += 1;

    const prev = await client.query<{ prev_date: string }>(`SELECT ($1::date - 1)::text AS prev_date`, [cursor]);
    cursor = prev.rows[0]!.prev_date;
  }

  return streak;
}

