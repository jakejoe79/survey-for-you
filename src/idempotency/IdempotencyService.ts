import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { sha256Canonical } from '../lib/hash';
import { logWarn } from '../lib/logger';
import * as IdempotencyRepo from '../repositories/idempotencyRepo';

export type ClaimResult =
  | { type: 'claimed'; idempotencyId: number; attemptId: string; requestVersion: number }
  | { type: 'replay'; response: unknown; idempotencyId: number; attemptId: string | null }
  | { type: 'processing'; retryAfterMs: number; idempotencyId: number; attemptId: string | null }
  | { type: 'expired'; idempotencyId: number; attemptId: string | null };

const REQUEST_VERSION = 1;
const RETRY_AFTER_MS = 250;

export function computeResolvedHashForLoggingOnly(resolvedPayload: unknown): string {
  return sha256Canonical({ requestVersion: REQUEST_VERSION, resolvedPayload });
}

export async function claimOrReplay(
  client: PoolClient,
  params: { userId: number; key: string },
): Promise<ClaimResult> {
  const attemptId = crypto.randomUUID();

  await IdempotencyRepo.tryClaim(client, {
    userId: params.userId,
    key: params.key,
    requestVersion: REQUEST_VERSION,
    attemptId,
  });

  const row = await IdempotencyRepo.getForUpdate(client, {
    userId: params.userId,
    key: params.key,
  });

  if (!row) {
    // Extremely rare timing/visibility issue; treat as processing and let client retry.
    return { type: 'processing', retryAfterMs: RETRY_AFTER_MS, idempotencyId: -1, attemptId: null };
  }

  // Expiry check comes first.
  const expired = await client.query<{ is_expired: boolean }>(
    `SELECT (expires_at < NOW()) AS is_expired FROM idempotency_keys WHERE id = $1`,
    [row.id],
  );
  if (expired.rows[0]?.is_expired) {
    return { type: 'expired', idempotencyId: row.id, attemptId: row.attempt_id };
  }

  if (row.status === 'completed') {
    return { type: 'replay', response: row.response_json, idempotencyId: row.id, attemptId: row.attempt_id };
  }

  // Final locked behavior: failed is still "owned" until expiry -> return processing.
  if (row.status === 'processing' || row.status === 'failed') {
    return { type: 'processing', retryAfterMs: RETRY_AFTER_MS, idempotencyId: row.id, attemptId: row.attempt_id };
  }

  // Should be unreachable due to ENUM; keep safe fallback.
  logWarn(
    { event: 'idempotency_unknown_status', userId: params.userId, idempotencyId: row.id, attemptId: row.attempt_id },
    { status: row.status },
  );
  return { type: 'processing', retryAfterMs: RETRY_AFTER_MS, idempotencyId: row.id, attemptId: row.attempt_id };
}

