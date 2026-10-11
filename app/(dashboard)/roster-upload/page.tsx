import { FlightMenuUploadWorkspace } from '@/components/features/flight-menu/FlightMenuUploadWorkspace';
import { ADMIN_EMAIL } from '@/lib/admin-access';
import { fetchFlightMenuRows } from '@/lib/flight-menu-processing';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export default async function RosterUploadPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let currentMealPlanUpdatedAt: string | null = null;
  let userMealPlanRefreshedAt: string | null = null;

  if (user) {
    const adminClient = createAdminClient();
    const { data: profile } = await adminClient
      .from('profiles')
      .select('last_meal_plan_refreshed_at')
      .eq('id', user.id)
      .maybeSingle();

    userMealPlanRefreshedAt = profile?.last_meal_plan_refreshed_at ?? null;

    const { data: adminProfile } = await adminClient
      .from('profiles')
      .select('id')
      .eq('email', ADMIN_EMAIL)
      .maybeSingle();

    if (adminProfile?.id) {
      const { data: latestRule } = await adminClient
        .from('catering_rules')
        .select('updated_at, created_at')
        .eq('user_id', adminProfile.id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      currentMealPlanUpdatedAt = latestRule?.updated_at ?? latestRule?.created_at ?? null;
    }
  }

  const initialRows = user ? await fetchFlightMenuRows(supabase, user.id) : [];

  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Planilha de Serviços</h1>
          <p className="mt-2 text-gray-600">Envie sua escala para aplicar os serviços de bordo cadastrados.</p>
        </div>
        
        <FlightMenuUploadWorkspace
          currentMealPlanUpdatedAt={currentMealPlanUpdatedAt}
          userMealPlanRefreshedAt={userMealPlanRefreshedAt}
          currentUserId={user?.id ?? null}
          initialRows={initialRows}
          manualIadpImportEnabled={process.env.NODE_ENV !== 'production'}
        />
      </div>
    </div>
  );
}
