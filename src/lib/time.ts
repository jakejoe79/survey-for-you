export function requireIanaTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.trim() === '') {
    throw new Error('timezone is required');
  }
  // Minimal validation: Intl throws on unknown zones.
  // eslint-disable-next-line no-new
  new Intl.DateTimeFormat('en-US', { timeZone: tz });
  return tz;
}

export function computeLocalDateFromNow(tz: string, nowUtc: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(nowUtc);

  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  if (!y || !m || !d) throw new Error('Failed to compute local_date');
  return `${y}-${m}-${d}`; // YYYY-MM-DD
}

