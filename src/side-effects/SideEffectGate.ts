import crypto from 'crypto';
import type { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { withTx } from '../db/tx';
import { logError, logInfo } from '../lib/logger';
import * as SideEffectsRepo from '../repositories/sideEffectsRepo';

export async function prepare(
  client: PoolClient,
  params: {
    userId: number;
    idempotencyId: number;
    attemptId: string | null;
    effectType: string;
  },
): Promise<{ shouldRun: boolean }> {
  const gate = await SideEffectsRepo.insertSideEffectOnce(client, {
    idempotencyId: params.idempotencyId,
    effectType: params.effectType,
  });

  if (!gate.inserted) {
    logInfo(
      { event: 'side_effect_skipped', userId: params.userId, idempotencyId: params.idempotencyId, attemptId: params.attemptId },
      { effectType: params.effectType },
    );
    return { shouldRun: false };
  }

  logInfo(
    { event: 'side_effect_prepared', userId: params.userId, idempotencyId: params.idempotencyId, attemptId: params.attemptId },
    { effectType: params.effectType },
  );
  return { shouldRun: true };
}

export async function runPostCommit(
  pool: Pool,
  params: {
    userId: number;
    idempotencyId: number;
    effectType: string;
    fn: () => Promise<void>;
  },
): Promise<{ executed: boolean }> {
  const attemptId = crypto.randomUUID();

  const claimed = await withTx(pool, async (client) =>
    SideEffectsRepo.tryClaimForRunning(client, {
      idempotencyId: params.idempotencyId,
      effectType: params.effectType,
      attemptId,
    }),
  );

  if (!claimed.claimed) {
    logInfo({ event: 'side_effect_not_claimed', userId: params.userId, idempotencyId: params.idempotencyId, attemptId }, { effectType: params.effectType });
    return { executed: false };
  }

  try {
    await params.fn();
    await withTx(pool, async (client) => SideEffectsRepo.markExecuted(client, { idempotencyId: params.idempotencyId, effectType: params.effectType }));
    logInfo({ event: 'side_effect_executed', userId: params.userId, idempotencyId: params.idempotencyId, attemptId }, { effectType: params.effectType });
    return { executed: true };
  } catch (err) {
    await withTx(pool, async (client) => SideEffectsRepo.resetToPending(client, { idempotencyId: params.idempotencyId, effectType: params.effectType }));
    logError({ event: 'side_effect_failed', userId: params.userId, idempotencyId: params.idempotencyId, attemptId }, { effectType: params.effectType, err: String(err) });
    return { executed: false };
  }
}

