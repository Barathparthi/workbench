import { createPool } from './pool.js';
import { loadMigrations, migrate } from './migrator.js';

// Runs as the migrator role (DDL rights), never as the app role: MIGRATION_DATABASE_URL.
const url = process.env['MIGRATION_DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(78);
}
const pool = createPool(url, 1);
try {
  const applied = await migrate(pool, await loadMigrations());
  console.log(applied.length === 0 ? 'migrations: up to date' : `migrations: applied ${applied.join(', ')}`);
} catch (error) {
  console.error(`migrations: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
