import { Pool } from 'pg';

export function createPoolFromEnv(envVarName: string = 'DATABASE_URL'): Pool {
  const connectionString = process.env[envVarName];
  if (!connectionString) {
    throw new Error(`${envVarName} is required`);
  }
  return new Pool({ connectionString });
}

export const pool = createPoolFromEnv('DATABASE_URL');

