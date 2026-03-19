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

