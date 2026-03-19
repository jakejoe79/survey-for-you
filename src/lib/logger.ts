export type LogEnvelope = {
  event: string;
  userId: number;
  idempotencyId: number | null;
  attemptId: string | null;
};

export function logInfo(envelope: LogEnvelope, extra?: Record<string, unknown>) {
  const payload = { level: 'info', ...envelope, ...(extra ?? {}) };
  // Structured logs only. Keep this boring and machine-readable.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

export function logWarn(envelope: LogEnvelope, extra?: Record<string, unknown>) {
  const payload = { level: 'warn', ...envelope, ...(extra ?? {}) };
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify(payload));
}

export function logError(envelope: LogEnvelope, extra?: Record<string, unknown>) {
  const payload = { level: 'error', ...envelope, ...(extra ?? {}) };
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(payload));
}

