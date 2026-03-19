import crypto from 'crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/client';
import { withTx } from '../db/tx';
import { logError, logInfo } from '../lib/logger';
import * as SideEffectsRepo from '../repositories/sideEffectsRepo';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelaySeconds(attemptCount: number): number {
  // attempt_count increments on claim. So attemptCount=1 means first attempt.
  // Backoff schedule: 1->5s, 2->30s, 3->120s, 4->300s, 5+->900s
  if (attemptCount <= 1) return 5;
  if (attemptCount === 2) return 30;
  if (attemptCount === 3) return 120;
  if (attemptCount === 4) return 300;
  return 900;
}

const counters = {
  executedTotal: 0,
  failedTotal: 0,
  retriedTotal: 0,
  stuckRecoveredTotal: 0,
};

async function executeEffect(effect: SideEffectsRepo.SideEffectRow): Promise<void> {
  // External boundary idempotency / correlation id:
  // use effect.id (stable) as the idempotency key/correlation id for external systems.
  const externalId = String(effect.id);

  switch (effect.effect_type) {
    case 'quick_log_analytics':
      // placeholder no-op effect
      logInfo(
        { event: 'effect_external_boundary', userId: 0, idempotencyId: effect.idempotency_id, attemptId: effect.attempt_id },
        { effect_id: effect.id, effect_type: effect.effect_type, external_id: externalId, payload: effect.payload },
      );
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
      counters.stuckRecoveredTotal += recovered;
      logInfo({ event: 'side_effects_recovered', userId: 0, idempotencyId: null, attemptId }, { recovered });
    }
  });

  const job = await withTx(pool, async (client) => SideEffectsRepo.claimNextPending(client, { attemptId }));
  if (!job) return false;

  try {
    await executeEffect(job);
    await withTx(pool, async (client) => SideEffectsRepo.markExecuted(client, { idempotencyId: job.idempotency_id, effectType: job.effect_type }));
    counters.executedTotal += 1;
    logInfo({ event: 'side_effect_worker_executed', userId: 0, idempotencyId: job.idempotency_id, attemptId }, { effectType: job.effect_type });
    return true;
  } catch (err) {
    const delay = retryDelaySeconds(job.attempt_count);
    await withTx(pool, async (client) =>
      SideEffectsRepo.scheduleRetry(client, { idempotencyId: job.idempotency_id, effectType: job.effect_type, delaySeconds: delay }),
    );
    counters.failedTotal += 1;
    counters.retriedTotal += 1;
    logError(
      { event: 'side_effect_worker_failed', userId: 0, idempotencyId: job.idempotency_id, attemptId },
      { effect_id: job.id, effectType: job.effect_type, attempt: job.attempt_count, next_retry_seconds: delay, err: String(err) },
    );
    return true; // consumed a job (even though it failed)
  }
}

export async function runWorkerForever(pool: Pool) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const didWork = await runWorkerOnce(pool);
    // Lightweight observability heartbeat.
    if (didWork) {
      logInfo(
        { event: 'side_effect_worker_counters', userId: 0, idempotencyId: null, attemptId: null },
        {
          side_effects_executed_total: counters.executedTotal,
          side_effects_failed_total: counters.failedTotal,
          side_effects_retried_total: counters.retriedTotal,
          side_effects_stuck_recovered_total: counters.stuckRecoveredTotal,
        },
      );
    }
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

