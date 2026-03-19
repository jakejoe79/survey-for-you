import crypto from 'crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/client';
import { withTx } from '../db/tx';
import { logError, logInfo } from '../lib/logger';
import * as SideEffectsRepo from '../repositories/sideEffectsRepo';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function executeEffect(effect: SideEffectsRepo.SideEffectRow): Promise<void> {
  switch (effect.effect_type) {
    case 'quick_log_analytics':
      // placeholder no-op effect
      return;
    default:
      throw new Error(`Unknown effect_type: ${effect.effect_type}`);
  }
}

export async function runWorkerOnce(pool: Pool): Promise<boolean> {
  const attemptId = crypto.randomUUID();

  await withTx(pool, async (client) => {
    const { recovered } = await SideEffectsRepo.recoverStuckRunning(client, { olderThanSeconds: 120 });
    if (recovered > 0) {
      logInfo({ event: 'side_effects_recovered', userId: 0, idempotencyId: null, attemptId }, { recovered });
    }
  });

  const job = await withTx(pool, async (client) => SideEffectsRepo.claimNextPending(client, { attemptId }));
  if (!job) return false;

  try {
    await executeEffect(job);
    await withTx(pool, async (client) => SideEffectsRepo.markExecuted(client, { idempotencyId: job.idempotency_id, effectType: job.effect_type }));
    logInfo({ event: 'side_effect_worker_executed', userId: 0, idempotencyId: job.idempotency_id, attemptId }, { effectType: job.effect_type });
    return true;
  } catch (err) {
    await withTx(pool, async (client) => SideEffectsRepo.resetToPending(client, { idempotencyId: job.idempotency_id, effectType: job.effect_type }));
    logError({ event: 'side_effect_worker_failed', userId: 0, idempotencyId: job.idempotency_id, attemptId }, { effectType: job.effect_type, err: String(err) });
    return true; // consumed a job (even though it failed)
  }
}

export async function runWorkerForever(pool: Pool) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const didWork = await runWorkerOnce(pool);
    if (!didWork) await sleep(500);
  }
}

if (require.main === module) {
  runWorkerForever(defaultPool).catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}

