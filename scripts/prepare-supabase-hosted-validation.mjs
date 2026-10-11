import { cp, mkdir } from 'node:fs/promises';

const destination =
  '.iadp-analysis/supabase-hosted-test/supabase/migrations/20990101000000_iadp_hosted_validation.sql';

await mkdir('.iadp-analysis/supabase-hosted-test/supabase/migrations', { recursive: true });
await cp('supabase/tests/hosted/iadp_hosted_validation.sql', destination);
console.log(`Validação hospedada preparada em ${destination}`);
