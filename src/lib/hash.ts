import crypto from 'crypto';
import { canonicalize } from './canonicalize';

export function sha256Canonical(value: unknown): string {
  const canonical = canonicalize(value);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

