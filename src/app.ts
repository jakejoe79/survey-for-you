import express from 'express';
import type { Pool } from 'pg';
import { execute as quickLogExecute } from './quick-log/QuickLogService';

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
      const result = await quickLogExecute(pool, { userId, idempotencyKey, payload });
      return res.status(result.statusCode).json(result.response);
    } catch (err) {
      return res.status(400).json({ error: String(err) });
    }
  });

  return app;
}

