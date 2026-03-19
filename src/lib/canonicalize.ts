export function canonicalize(value: unknown): string {
  return JSON.stringify(sortAndStrip(value));
}

function sortAndStrip(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;

  if (Array.isArray(value)) {
    return value
      .map((v) => sortAndStrip(v))
      .filter((v) => v !== undefined);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = sortAndStrip(obj[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  return value;
}

