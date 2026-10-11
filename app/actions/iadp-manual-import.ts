'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import {
  buildManualIadpImportPreview,
  type ManualIadpPreviewEntry,
  type PersistedRosterRow,
} from '@/lib/iadp/manual-import';
import {
  normalizeIadpRosterEvents,
  type IadpRosterEventsResponse,
} from '@/lib/iadp/normalize-roster-events';
import { fetchFlightMenuRows } from '@/lib/flight-menu-processing';
import { createClient } from '@/lib/supabase/server';

const MAX_JSON_BYTES = 5 * 1024 * 1024;

export type IadpPreviewItem = {
  sourceEventId: string;
  kind: 'flight' | 'activity';
  code: string;
  route: string;
  departureTime: string;
  arrivalTime: string;
  previousDepartureTime: string | null;
  reconcilesPdf: boolean;
};

export type IadpManualPreviewResult = {
  success: boolean;
  error?: string;
  digest?: string;
  fileName?: string;
  period?: { from: string | null; to: string | null };
  snapshot?: {
    completeAndValid: boolean;
    removalSafe: false;
    reasons: string[];
    removalBlockers: string[];
  };
  counts?: {
    insertions: number;
    updates: number;
    unchanged: number;
    removalCandidates: number;
  };
  insertions?: IadpPreviewItem[];
  updates?: IadpPreviewItem[];
  unchanged?: IadpPreviewItem[];
  removalCandidates?: IadpPreviewItem[];
};

export async function previewManualIadpImport(formData: FormData): Promise<IadpManualPreviewResult> {
  try {
    assertManualImportEnabled();
    const { supabase, userId } = await getAuthenticatedContext();
    const parsed = await parseFixture(formData);
    const preview = await buildPreviewFromDatabase(supabase, userId, parsed.payload);
    return serializePreview(
      preview,
      buildConfirmationDigest(parsed.digest, preview),
      parsed.file.name
    );
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function saveManualIadpImport(formData: FormData) {
  try {
    assertManualImportEnabled();
    if (formData.get('confirmed') !== 'true') {
      throw new Error('Confirme explicitamente a prévia antes de salvar.');
    }

    const expectedDigest = String(formData.get('expectedDigest') ?? '');
    const { supabase, userId } = await getAuthenticatedContext();
    const parsed = await parseFixture(formData);
    const preview = await buildPreviewFromDatabase(supabase, userId, parsed.payload);
    const currentConfirmationDigest = buildConfirmationDigest(parsed.digest, preview);
    if (!expectedDigest || currentConfirmationDigest !== expectedDigest) {
      throw new Error('O JSON ou a escala atual mudou depois da prévia. Gere uma nova prévia antes de salvar.');
    }
    if (!preview.snapshot.completeAndValid || !preview.period.from || !preview.period.to) {
      throw new Error('O snapshot não passou pela validação estrutural e não pode ser salvo.');
    }

    const items = [
      ...preview.insertions.map((entry) => entry.item),
      ...preview.updates.map((entry) => entry.item),
    ];
    let persisted = { inserted: 0, updated: 0, unchanged: preview.unchanged.length, reconciledPdf: 0 };

    if (items.length > 0) {
      const { data, error } = await supabase.rpc('import_current_user_iadp_roster', {
        p_snapshot_digest: parsed.digest,
        p_source_ref_timestamp: preview.sourceRefTimestamp,
        p_period_from: preview.period.from,
        p_period_to: preview.period.to,
        p_items: items,
      });
      if (error) throw new Error(`Não foi possível salvar a escala IADP: ${error.message}`);

      const result = Array.isArray(data) ? data[0] : data;
      persisted = {
        inserted: Number(result?.inserted_count ?? 0),
        updated: Number(result?.updated_count ?? 0),
        unchanged: preview.unchanged.length + Number(result?.unchanged_count ?? 0),
        reconciledPdf: Number(result?.reconciled_pdf_count ?? 0),
      };
    }

    revalidatePath('/roster-upload');
    return {
      success: true,
      ...persisted,
      removalCandidatesIgnored: preview.removalCandidates.length,
      rows: await fetchFlightMenuRows(supabase, userId),
      message:
        `Importação IADP confirmada: ${persisted.inserted} inclusões, ` +
        `${persisted.updated} alterações e ${persisted.unchanged} inalterados. ` +
        `${preview.removalCandidates.length} candidato(s) a remoção foram ignorados.`,
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

function assertManualImportEnabled() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('A importação manual IADP está desabilitada em produção.');
  }
}

async function getAuthenticatedContext() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Não autorizado.');
  return { supabase, userId: user.id };
}

async function parseFixture(formData: FormData) {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) throw new Error('Selecione um arquivo JSON IADP.');
  if (file.size > MAX_JSON_BYTES) throw new Error('O JSON IADP deve ter no máximo 5 MB.');
  if (!file.name.toLowerCase().endsWith('.json')) throw new Error('Somente arquivos JSON são permitidos.');

  const text = await file.text();
  let payload: IadpRosterEventsResponse;
  try {
    payload = JSON.parse(text) as IadpRosterEventsResponse;
  } catch {
    throw new Error('O arquivo não contém JSON válido.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('O JSON IADP deve conter um objeto na raiz.');
  }

  return {
    file,
    payload,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

async function buildPreviewFromDatabase(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  payload: IadpRosterEventsResponse
) {
  const normalized = normalizeIadpRosterEvents(payload);
  if (!normalized.period.from || !normalized.period.to) {
    return buildManualIadpImportPreview({ authenticatedUserId: userId, payload, persistedRows: [] });
  }

  const { data, error } = await supabase
    .from('flight_leg_details')
    .select('*')
    .eq('user_id', userId)
    .gte('departure_time', normalized.period.from)
    .lte('departure_time', normalized.period.to);
  if (error) throw new Error(`Não foi possível consultar a escala atual: ${error.message}`);

  return buildManualIadpImportPreview({
    authenticatedUserId: userId,
    payload,
    persistedRows: (data ?? []) as PersistedRosterRow[],
  });
}

function serializePreview(
  preview: Awaited<ReturnType<typeof buildPreviewFromDatabase>>,
  digest: string,
  fileName: string
): IadpManualPreviewResult {
  return {
    success: true,
    digest,
    fileName,
    period: { from: preview.period.from, to: preview.period.to },
    snapshot: {
      completeAndValid: preview.snapshot.completeAndValid,
      removalSafe: false,
      reasons: preview.snapshot.reasons,
      removalBlockers: preview.snapshot.removalBlockers,
    },
    counts: {
      insertions: preview.insertions.length,
      updates: preview.updates.length,
      unchanged: preview.unchanged.length,
      removalCandidates: preview.removalCandidates.length,
    },
    insertions: preview.insertions.map(summarizeEntry),
    updates: preview.updates.map(summarizeEntry),
    unchanged: preview.unchanged.map(summarizeEntry),
    removalCandidates: preview.removalCandidates.map((row) => summarizePersisted(row)),
  };
}

function buildConfirmationDigest(
  fixtureDigest: string,
  preview: Awaited<ReturnType<typeof buildPreviewFromDatabase>>
) {
  const entryState = (entry: ManualIadpPreviewEntry) => ({
    sourceEventId: entry.item.source_event_id,
    next: entry.item,
    previousRowId: entry.previousRowId,
    previous: entry.previous,
    reconcilesPdf: entry.reconcilesPdf,
  });
  return createHash('sha256').update(JSON.stringify({
    fixtureDigest,
    period: preview.period,
    insertions: preview.insertions.map(entryState),
    updates: preview.updates.map(entryState),
    unchanged: preview.unchanged.map(entryState),
    removalCandidateIds: preview.removalCandidates.map((row) => row.id).sort(),
  })).digest('hex');
}

function summarizeEntry(entry: ManualIadpPreviewEntry): IadpPreviewItem {
  return {
    sourceEventId: entry.item.source_event_id,
    kind: entry.item.source_kind,
    code: entry.item.flight_number,
    route: formatRoute(entry.item.origin, entry.item.destination),
    departureTime: entry.item.departure_time,
    arrivalTime: entry.item.arrival_time,
    previousDepartureTime: entry.previous?.departure_time ?? null,
    reconcilesPdf: entry.reconcilesPdf,
  };
}

function summarizePersisted(row: PersistedRosterRow): IadpPreviewItem {
  return {
    sourceEventId: row.source_event_id ?? row.unique_key,
    kind: row.source_kind === 'activity' ? 'activity' : 'flight',
    code: row.flight_number,
    route: formatRoute(row.origin, row.destination),
    departureTime: row.departure_time,
    arrivalTime: row.arrival_time,
    previousDepartureTime: null,
    reconcilesPdf: false,
  };
}

function formatRoute(origin: string, destination: string) {
  return origin === '-' && destination === '-' ? 'Atividade' : `${origin} → ${destination}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Erro desconhecido na importação IADP.';
}
