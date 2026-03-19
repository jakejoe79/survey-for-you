import type { PoolClient } from 'pg';

export async function insertSideEffectOnce(
  client: PoolClient,
  params: { idempotencyId: number; effectType: string },
): Promise<{ inserted: boolean; sideEffectId?: number }> {
  const res = await client.query<{ id: number }>(
    `
    INSERT INTO side_effects (idempotency_id, effect_type)
    VALUES ($1, $2)
    ON CONFLICT (idempotency_id, effect_type) DO NOTHING
    RETURNING id
    `,
    [params.idempotencyId, params.effectType],
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

