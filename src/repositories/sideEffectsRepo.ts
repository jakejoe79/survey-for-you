import type { PoolClient } from 'pg';

export type SideEffectRow = {
  id: number;
  idempotency_id: number;
  effect_type: string;
  status: 'pending' | 'running' | 'executed';
  attempt_id: string | null;
  payload: unknown;
  attempt_count: number;
  next_run_at: string;
  updated_at: string;
};

export async function insertSideEffectOnce(
  client: PoolClient,
  params: { idempotencyId: number; effectType: string; payload?: unknown },
): Promise<{ inserted: boolean; sideEffectId?: number }> {
  const res = await client.query<{ id: number }>(
    `
    INSERT INTO side_effects (idempotency_id, effect_type, payload)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (idempotency_id, effect_type) DO NOTHING
    RETURNING id
    `,
    [params.idempotencyId, params.effectType, JSON.stringify(params.payload ?? {})],
  );

  if ((res.rowCount ?? 0) > 0) return { inserted: true, sideEffectId: res.rows[0]!.id };
  return { inserted: false };
}

export async function tryClaimForRunning(
  client: PoolClient,
  params: { idempotencyId: number; effectType: string; attemptId: string },
): Promise<{ claimed: boolean }> {
  const res = await client.query<{ id: number }>(
    `
    UPDATE side_effects
    SET status = 'running',
        attempt_id = $3
    WHERE idempotency_id = $1
      AND effect_type = $2
      AND status = 'pending'
    RETURNING id
    `,
    [params.idempotencyId, params.effectType, params.attemptId],
  );
  return { claimed: (res.rowCount ?? 0) > 0 };
}

export async function claimNextPending(
  client: PoolClient,
  params: { attemptId: string },
): Promise<SideEffectRow | null> {
  const res = await client.query<SideEffectRow>(
    `
    UPDATE side_effects
    SET status = 'running',
        attempt_id = $1,
        attempt_count = attempt_count + 1
    WHERE id = (
      SELECT id
      FROM side_effects
      WHERE status = 'pending'
        AND next_run_at <= NOW()
      ORDER BY next_run_at ASC, updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, idempotency_id, effect_type, status, attempt_id, payload, attempt_count, next_run_at, updated_at
    `,
    [params.attemptId],
  );
  return res.rows[0] ?? null;
}

export async function recoverStuckRunning(
  client: PoolClient,
  params: { olderThanSeconds: number },
): Promise<{ recovered: number }> {
  const res = await client.query<{ recovered: number }>(
    `
    WITH updated AS (
      UPDATE side_effects
      SET status = 'pending',
          attempt_id = NULL
      WHERE status = 'running'
        AND updated_at < NOW() - make_interval(secs => $1)
      RETURNING 1
    )
    SELECT COUNT(*)::int AS recovered FROM updated
    `,
    [params.olderThanSeconds],
  );
  return { recovered: res.rows[0]?.recovered ?? 0 };
}

export async function markExecuted(
  client: PoolClient,
  params: { idempotencyId: number; effectType: string },
): Promise<void> {
  await client.query(
    `
    UPDATE side_effects
    SET status = 'executed',
        executed_at = NOW()
    WHERE idempotency_id = $1
      AND effect_type = $2
    `,
    [params.idempotencyId, params.effectType],
  );
}

export async function resetToPending(
  client: PoolClient,
  params: { idempotencyId: number; effectType: string },
): Promise<void> {
  await client.query(
    `
    UPDATE side_effects
    SET status = 'pending'
    WHERE idempotency_id = $1
      AND effect_type = $2
      AND status = 'running'
    `,
    [params.idempotencyId, params.effectType],
  );
}

export async function scheduleRetry(
  client: PoolClient,
  params: { idempotencyId: number; effectType: string; delaySeconds: number },
): Promise<void> {
  await client.query(
    `
    UPDATE side_effects
    SET status = 'pending',
        next_run_at = NOW() + make_interval(secs => $3)
    WHERE idempotency_id = $1
      AND effect_type = $2
      AND status = 'running'
    `,
    [params.idempotencyId, params.effectType, params.delaySeconds],
  );
}

