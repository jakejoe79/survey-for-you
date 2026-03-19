import type { PoolClient } from 'pg';

export type IdempotencyRow = {
  id: number;
  user_id: number;
  key: string;
  status: 'processing' | 'completed' | 'failed';
  request_version: number;
  attempt_id: string | null;
  resolved_request_hash: string | null;
  response_version: number | null;
  response_json: unknown | null;
  expires_at: string;
  updated_at: string;
};

export async function tryClaim(
  client: PoolClient,
  params: { userId: number; key: string; requestVersion: number; attemptId: string },
): Promise<{ claimed: boolean; idempotencyId?: number }> {
  const res = await client.query<{ id: number }>(
    `
    INSERT INTO idempotency_keys (user_id, key, status, request_version, attempt_id, expires_at)
    VALUES ($1, $2, 'processing', $3, $4, NOW() + interval '24 hours')
    ON CONFLICT (user_id, key) DO NOTHING
    RETURNING id
    `,
    [params.userId, params.key, params.requestVersion, params.attemptId],
  );

  if (res.rowCount && res.rowCount > 0) {
    return { claimed: true, idempotencyId: res.rows[0]!.id };
  }
  return { claimed: false };
}

export async function getForUpdate(
  client: PoolClient,
  params: { userId: number; key: string },
): Promise<IdempotencyRow | null> {
  const res = await client.query<IdempotencyRow>(
    `
    SELECT
      id, user_id, key, status, request_version, attempt_id,
      resolved_request_hash, response_version, response_json,
      expires_at, updated_at
    FROM idempotency_keys
    WHERE user_id = $1 AND key = $2
    FOR UPDATE
    `,
    [params.userId, params.key],
  );
  return res.rows[0] ?? null;
}

export async function completeWithStub(
  client: PoolClient,
  params: {
    idempotencyId: number;
    resolvedRequestHash: string;
    responseVersion: number;
    responseJson: unknown;
  },
): Promise<void> {
  await client.query(
    `
    UPDATE idempotency_keys
    SET
      status = 'completed',
      resolved_request_hash = $2,
      response_version = $3,
      response_json = $4
    WHERE id = $1
    `,
    [params.idempotencyId, params.resolvedRequestHash, params.responseVersion, params.responseJson],
  );
}

export async function patchSummaryIfDegraded(
  client: PoolClient,
  params: { idempotencyId: number; responseVersion: number; summaryJson: unknown },
): Promise<boolean> {
  const res = await client.query<{ id: number }>(
    `
    UPDATE idempotency_keys
    SET response_version = $2,
        response_json = jsonb_set(response_json, '{summary}', $3::jsonb, true)
    WHERE id = $1
      AND (response_json->'summary'->>'status') = 'degraded'
    RETURNING id
    `,
    [params.idempotencyId, params.responseVersion, params.summaryJson],
  );
  return (res.rowCount ?? 0) > 0;
}

