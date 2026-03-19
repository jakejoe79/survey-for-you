import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../src/app';
import { withTx } from '../src/db/tx';

const TEST_DB_URL = process.env.DATABASE_URL_TEST;
const hasTestDb = Boolean(TEST_DB_URL);

function requireTestDbUrl(): string {
  if (!TEST_DB_URL) throw new Error('DATABASE_URL_TEST is required to run integration tests');
  return TEST_DB_URL;
}

async function migrate(pool: Pool) {
  const sql = await (await import('fs')).promises.readFile('sql/001_init.sql', 'utf8');
  await pool.query(sql);
}

async function reset(pool: Pool) {
  await pool.query('TRUNCATE side_effects RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE idempotency_keys RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE user_daily_activity');
  await pool.query('TRUNCATE user_platform_stats');
  await pool.query('TRUNCATE survey_entries RESTART IDENTITY CASCADE');
}

const maybeDescribe = hasTestDb ? describe : describe.skip;

maybeDescribe('POST /surveys/quick idempotency canary', () => {
  const userId = 123;
  const pool = new Pool({ connectionString: requireTestDbUrl() });
  const app = createApp(pool);

  beforeAll(async () => {
    await migrate(pool);
  });

  beforeEach(async () => {
    await reset(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('replays without duplication and keeps response identical', async () => {
    const key = 'test-key-123';

    const payload = {
      platformId: 1,
      payoutCents: 150,
      durationSeconds: 600,
      timezone: 'UTC',
    };

    const first = await request(app)
      .post('/surveys/quick')
      .set('X-User-Id', String(userId))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    const second = await request(app)
      .post('/surveys/quick')
      .set('X-User-Id', String(userId))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    expect(second.body).toEqual(first.body);

    const entryCount = await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM survey_entries WHERE user_id = $1', [userId]);
    expect(entryCount.rows[0]!.c).toBe('1');

    const effectsCount = await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM side_effects');
    expect(effectsCount.rows[0]!.c).toBe('1');
  });

  it('rolls back on failure (transaction core canary)', async () => {
    await expect(
      withTx(pool, async (client) => {
        await client.query(
          `
          INSERT INTO survey_entries (user_id, platform_id, payout_cents, duration_seconds)
          VALUES ($1, 1, 100, 60)
          `,
          [userId],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const res = await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM survey_entries WHERE user_id = $1', [userId]);
    expect(res.rows[0]!.c).toBe('0');
  });

  it('handles concurrent same-key requests safely', async () => {
    const key = 'concurrent-key';
    const payload = {
      platformId: 1,
      payoutCents: 150,
      durationSeconds: 600,
      timezone: 'UTC',
    };

    const [a, b] = await Promise.all([
      request(app).post('/surveys/quick').set('X-User-Id', String(userId)).set('Idempotency-Key', key).send(payload),
      request(app).post('/surveys/quick').set('X-User-Id', String(userId)).set('Idempotency-Key', key).send(payload),
    ]);

    // One may legitimately get 202 if it lands during the processing window.
    expect([200, 202]).toContain(a.status);
    expect([200, 202]).toContain(b.status);

    const ok = [a, b].find((r) => r.status === 200);
    expect(ok).toBeTruthy();

    // Ensure replay eventually returns the canonical response.
    const replay = await request(app)
      .post('/surveys/quick')
      .set('X-User-Id', String(userId))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    expect(replay.body).toEqual(ok!.body);

    const entryCount = await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM survey_entries WHERE user_id = $1', [userId]);
    expect(entryCount.rows[0]!.c).toBe('1');

    const effectsCount = await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM side_effects');
    expect(effectsCount.rows[0]!.c).toBe('1');
  });
});

