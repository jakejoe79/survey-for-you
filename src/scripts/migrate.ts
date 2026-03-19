import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

function listSqlFiles(): string[] {
  const dir = path.join(process.cwd(), 'sql');
  const entries = fs.readdirSync(dir);
  return entries
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => path.join(dir, f));
}

export async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for migration');

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const files = listSqlFiles();
    for (const file of files) {
      const sql = fs.readFileSync(file, 'utf8');
      await client.query(sql);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}

