import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../src/app';

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

    // Side effects table isn't used in this minimal endpoint yet; ensure it's empty for now.
    const effectsCount = await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM side_effects');
    expect(effectsCount.rows[0]!.c).toBe('0');
  });
});

