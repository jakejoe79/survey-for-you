import express from 'express';
import type { Pool } from 'pg';
import { withTx } from './db/tx';
import { claimOrReplay } from './idempotency/IdempotencyService';
import { computeResolvedHashForLoggingOnly } from './idempotency/IdempotencyService';
import { logInfo, logWarn } from './lib/logger';
import { completeWithStub, getForUpdate } from './repositories/idempotencyRepo';
import { runOnce } from './side-effects/SideEffectGate';
import { quickLogCore, resolveDefaults } from './quick-log/QuickLogService';

export function createApp(pool: Pool) {
  const app = express();
  app.use(express.json());

  // Minimal auth stub for now: tests set X-User-Id.
  app.use((req, res, next) => {
    const raw = req.header('x-user-id');
    const userId = raw ? Number(raw) : NaN;
    if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
    (req as any).userId = userId;
    next();
  });

  app.post('/surveys/quick', async (req, res) => {
    const userId = (req as any).userId as number;
    const idempotencyKey = (req.header('idempotency-key') ?? req.body?.key) as string | undefined;
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      return res.status(400).json({ error: 'Idempotency key required' });
    }

    const payload = req.body?.payload ?? req.body;

    try {
      const result = await withTx(pool, async (client) => {
        const gate = await claimOrReplay(client, { userId, key: idempotencyKey });

        if (gate.type === 'expired') {
          return { statusCode: 409 as const, body: { error: 'Idempotency key expired — generate a new key' } };
        }

        if (gate.type === 'processing') {
          return { statusCode: 202 as const, body: { status: 'processing', retryAfterMs: gate.retryAfterMs } };
        }

        if (gate.type === 'replay') {
          // Replay is always boring: return stored response.
          // But we can log mismatches for debugging.
          try {
            const resolved = resolveDefaults(payload);
            const incomingHash = computeResolvedHashForLoggingOnly(resolved);
            const row = await getForUpdate(client, { userId, key: idempotencyKey });
            const storedHash = row?.resolved_request_hash;
            if (storedHash && storedHash !== incomingHash) {
              logWarn(
                { event: 'idempotency_mismatch', userId, idempotencyId: gate.idempotencyId, attemptId: gate.attemptId },
                { key: idempotencyKey, stored_hash: storedHash, incoming_hash: incomingHash, request_version: row?.request_version },
              );
            }
          } catch {
            // ignore
          }
          return { statusCode: 200 as const, body: gate.response };
        }

        // claimed
        const core = await quickLogCore(client, { userId, payload, writeSource: 'quick_log' });

        // Example gated side effect (no-op body): proves once-only behavior.
        await runOnce(client, {
          userId,
          idempotencyId: gate.idempotencyId,
          attemptId: gate.attemptId,
          effectType: 'quick_log_analytics',
          fn: async () => undefined,
        });

        await completeWithStub(client, {
          idempotencyId: gate.idempotencyId,
          resolvedRequestHash: core.resolvedRequestHash,
          responseVersion: 1,
          responseJson: core.response,
        });

        logInfo(
          { event: 'quick_log_completed', userId, idempotencyId: gate.idempotencyId, attemptId: gate.attemptId },
          { key: idempotencyKey },
        );

        return { statusCode: 200 as const, body: core.response };
      });

      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      return res.status(400).json({ error: String(err) });
    }
  });

  return app;
}

