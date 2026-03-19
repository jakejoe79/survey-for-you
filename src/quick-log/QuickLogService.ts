import type { Pool, PoolClient } from 'pg';
import { withTx } from '../db/tx';
import { logInfo, logWarn } from '../lib/logger';
import { computeLocalDateFromNow, requireIanaTimezone } from '../lib/time';
import { sha256Canonical } from '../lib/hash';
import * as IdempotencyService from '../idempotency/IdempotencyService';
import * as IdempotencyRepo from '../repositories/idempotencyRepo';
import * as SurveyRepo from '../repositories/surveyRepo';
import * as StatsRepo from '../repositories/statsRepo';
import * as SummaryService from '../summary/SummaryService';

export type QuickLogPayload = {
  platformId: number;
  payoutCents: number;
  durationSeconds: number;
  timezone: string;
};

export type QuickLogResponse = {
  entry: SurveyRepo.SurveyEntry;
  summary: SummaryService.Summary;
};

const RESPONSE_VERSION = 1;
const REQUEST_VERSION = 1;

function resolveDefaults(payload: QuickLogPayload): {
  platformId: number;
  payoutCents: number;
  durationSeconds: number;
  timezone: string;
  localDate: string;
} {
  const platformId = payload.platformId;
  const payoutCents = payload.payoutCents;
  const durationSeconds = payload.durationSeconds;
  if (!Number.isInteger(platformId) || platformId <= 0) throw new Error('platformId must be a positive integer');
  if (!Number.isInteger(payoutCents) || payoutCents <= 0) throw new Error('payoutCents must be a positive integer');
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) throw new Error('durationSeconds must be a positive integer');

  const timezone = requireIanaTimezone(payload.timezone);
  const localDate = computeLocalDateFromNow(timezone);
  return { platformId, payoutCents, durationSeconds, timezone, localDate };
}

export async function execute(
  pool: Pool,
  params: { userId: number; idempotencyKey: string; payload: QuickLogPayload },
): Promise<
  | { type: 'ok'; statusCode: 200; response: QuickLogResponse }
  | { type: 'processing'; statusCode: 202; response: { status: 'processing'; retryAfterMs: number } }
  | { type: 'expired'; statusCode: 409; response: { error: string } }
> {
  // Phase 1: transactional write + deterministic stub completion.
  const txResult = await withTx(pool, async (client) => {
    const gate = await IdempotencyService.claimOrReplay(client, {
      userId: params.userId,
      key: params.idempotencyKey,
    });

    if (gate.type === 'replay') {
      // Optional mismatch logging: compute resolved hash and compare to stored hash.
      // We never block replay on mismatch.
      try {
        const resolved = resolveDefaults(params.payload);
        const incomingHash = sha256Canonical({ requestVersion: REQUEST_VERSION, resolvedPayload: resolved });
        const row = await IdempotencyRepo.getForUpdate(client, { userId: params.userId, key: params.idempotencyKey });
        const storedHash = row?.resolved_request_hash;
        if (storedHash && storedHash !== incomingHash) {
          logWarn(
            { event: 'idempotency_mismatch', userId: params.userId, idempotencyId: gate.idempotencyId, attemptId: gate.attemptId },
            { key: params.idempotencyKey, stored_hash: storedHash, incoming_hash: incomingHash, request_version: REQUEST_VERSION },
          );
        }
      } catch {
        // Ignore: replay must remain boring even if payload is bad.
      }
      return { kind: 'replay' as const, gate };
    }

    if (gate.type === 'processing') return { kind: 'processing' as const, gate };
    if (gate.type === 'expired') return { kind: 'expired' as const, gate };

    const resolved = resolveDefaults(params.payload);
    const resolvedHash = sha256Canonical({ requestVersion: REQUEST_VERSION, resolvedPayload: resolved });

    const entry = await SurveyRepo.insertSurveyEntry(client, {
      userId: params.userId,
      platformId: resolved.platformId,
      payoutCents: resolved.payoutCents,
      durationSeconds: resolved.durationSeconds,
      writeSource: 'quick_log',
    });

    await StatsRepo.upsertPlatformStats(client, { userId: params.userId, platformId: entry.platform_id });
    await StatsRepo.upsertDailyActivity(client, { userId: params.userId, localDate: resolved.localDate, timezoneAtWrite: resolved.timezone });

    const stub: QuickLogResponse = {
      entry,
      summary: {
        status: 'degraded',
        message: 'Calculating...',
        todayEarningsCents: null,
        todayTimeSeconds: null,
        todayRateCentsPerHour: null,
        historicalAvgRateCentsPerHour: null,
        streakDays: null,
      },
    };

    await IdempotencyRepo.completeWithStub(client, {
      idempotencyId: gate.idempotencyId,
      resolvedRequestHash: resolvedHash,
      responseVersion: RESPONSE_VERSION,
      responseJson: stub,
    });

    logInfo(
      { event: 'quick_log_completed_stub', userId: params.userId, idempotencyId: gate.idempotencyId, attemptId: gate.attemptId },
      { localDate: resolved.localDate },
    );

    return { kind: 'created' as const, gate, stub, localDate: resolved.localDate };
  });

  // Phase 2: map txResult to API behavior; patch summary best-effort after commit.
  if (txResult.kind === 'processing') {
    return { type: 'processing', statusCode: 202, response: { status: 'processing', retryAfterMs: txResult.gate.retryAfterMs } };
  }

  if (txResult.kind === 'expired') {
    return { type: 'expired', statusCode: 409, response: { error: 'Idempotency key expired — generate a new key' } };
  }

  if (txResult.kind === 'replay') {
    return { type: 'ok', statusCode: 200, response: txResult.gate.response as QuickLogResponse };
  }

  // created stub: schedule patch but don't block response.
  void patchSummary(pool, {
    userId: params.userId,
    idempotencyId: txResult.gate.idempotencyId,
    attemptId: txResult.gate.attemptId,
    localDate: txResult.localDate,
  });

  return { type: 'ok', statusCode: 200, response: txResult.stub };
}

async function patchSummary(
  pool: Pool,
  params: { userId: number; idempotencyId: number; attemptId: string; localDate: string },
): Promise<void> {
  try {
    const summary = await withTx(pool, async (client) => SummaryService.getAfterNewEntry(client, { userId: params.userId, localDate: params.localDate }));
    const patched = await withTx(pool, async (client) =>
      IdempotencyRepo.patchSummaryIfDegraded(client, {
        idempotencyId: params.idempotencyId,
        responseVersion: RESPONSE_VERSION,
        summaryJson: summary,
      }),
    );

    logInfo(
      { event: 'quick_log_summary_patch_attempt', userId: params.userId, idempotencyId: params.idempotencyId, attemptId: params.attemptId },
      { patched },
    );
  } catch (err) {
    logWarn(
      { event: 'quick_log_summary_patch_failed', userId: params.userId, idempotencyId: params.idempotencyId, attemptId: params.attemptId },
      { err: String(err) },
    );
  }
}

