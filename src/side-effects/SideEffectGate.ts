import type { PoolClient } from 'pg';
import { logInfo } from '../lib/logger';
import * as SideEffectsRepo from '../repositories/sideEffectsRepo';

export async function runOnce(
  client: PoolClient,
  params: {
    userId: number;
    idempotencyId: number;
    attemptId: string | null;
    effectType: string;
    fn: () => Promise<void>;
  },
): Promise<{ executed: boolean }> {
  const gate = await SideEffectsRepo.insertSideEffectOnce(client, {
    idempotencyId: params.idempotencyId,
    effectType: params.effectType,
  });

  if (!gate.inserted) {
    logInfo(
      { event: 'side_effect_skipped', userId: params.userId, idempotencyId: params.idempotencyId, attemptId: params.attemptId },
      { effectType: params.effectType },
    );
    return { executed: false };
  }

  await params.fn();
  logInfo(
    { event: 'side_effect_executed', userId: params.userId, idempotencyId: params.idempotencyId, attemptId: params.attemptId },
    { effectType: params.effectType },
  );
  return { executed: true };
}

