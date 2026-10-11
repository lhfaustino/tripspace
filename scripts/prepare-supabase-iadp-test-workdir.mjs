import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const destinationRoot = '.iadp-analysis/supabase-hosted-test';
const destinationSupabase = `${destinationRoot}/supabase`;
const migrations = [
  '20260530000000_flight_upload_rls.sql',
  '20260609000000_roster_analytics_fields.sql',
  '20260929000000_replace_future_roster_flights.sql',
  '20261010000000_manual_iadp_import.sql',
];

await rm(`${destinationSupabase}/migrations`, { recursive: true, force: true });
await mkdir(`${destinationSupabase}/migrations`, { recursive: true });
await mkdir(`${destinationSupabase}/tests/database`, { recursive: true });
await cp('supabase/config.toml', `${destinationSupabase}/config.toml`);
for (const migration of migrations) {
  await cp(`supabase/migrations/${migration}`, `${destinationSupabase}/migrations/${migration}`);
}
await cp(
  'supabase/tests/database/iadp_import.test.sql',
  `${destinationSupabase}/tests/database/iadp_import.test.sql`
);
await writeFile(
  `${destinationSupabase}/seed.sql`,
  '-- Intentionally empty hosted IADP test seed.\n',
  'utf8'
);

console.log(`Workdir isolado preparado em ${destinationRoot}`);
console.log(`Migrações incluídas: ${migrations.join(', ')}`);
