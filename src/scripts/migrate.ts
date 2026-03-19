import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

export async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for migration');

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const sqlPath = path.join(process.cwd(), 'sql', '001_init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
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

