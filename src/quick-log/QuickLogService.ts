import type { PoolClient } from 'pg';
import { logInfo } from '../lib/logger';
import { computeLocalDateFromNow, requireIanaTimezone } from '../lib/time';
import { sha256Canonical } from '../lib/hash';
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

export function resolveDefaults(payload: QuickLogPayload): {
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

export async function quickLogCore(
  client: PoolClient,
  params: { userId: number; payload: QuickLogPayload; writeSource?: string },
): Promise<{
  response: QuickLogResponse;
  resolvedRequestHash: string;
}> {
  const resolved = resolveDefaults(params.payload);
  const resolvedRequestHash = sha256Canonical({ requestVersion: REQUEST_VERSION, resolvedPayload: resolved });

  const entry = await SurveyRepo.insertSurveyEntry(client, {
    userId: params.userId,
    platformId: resolved.platformId,
    payoutCents: resolved.payoutCents,
    durationSeconds: resolved.durationSeconds,
    writeSource: params.writeSource ?? 'quick_log',
  });

  await StatsRepo.upsertPlatformStats(client, { userId: params.userId, platformId: entry.platform_id });
  await StatsRepo.upsertDailyActivity(client, {
    userId: params.userId,
    localDate: resolved.localDate,
    timezoneAtWrite: resolved.timezone,
  });

  const summary = await SummaryService.getAfterNewEntry(client, {
    userId: params.userId,
    localDate: resolved.localDate,
    timezone: resolved.timezone,
  });

  const response: QuickLogResponse = { entry, summary };

  logInfo({ event: 'quick_log_core_written', userId: params.userId, idempotencyId: null, attemptId: null }, { localDate: resolved.localDate });

  return { response, resolvedRequestHash };
}

