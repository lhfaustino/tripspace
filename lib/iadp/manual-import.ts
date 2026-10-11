import {
  normalizeIadpRosterEvents,
  validateIadpFullSnapshot,
  type IadpRosterEventsResponse,
  type NormalizedIadpRosterItem,
} from './normalize-roster-events';

export type PersistedRosterRow = {
  id: string;
  user_id: string;
  unique_key: string;
  roster_source?: string | null;
  source_event_id?: string | null;
  source_parent_event_id?: string | null;
  source_kind?: string | null;
  flight_number: string;
  crew_position: string | null;
  origin: string;
  destination: string;
  departure_time: string;
  arrival_time: string;
  flight_duration_minutes: number | null;
  equipment: string | null;
  service_type: string | null;
  meal_type: string | null;
};

export type ManualIadpPreviewEntry = {
  item: NormalizedIadpRosterItem;
  previousRowId: string | null;
  previous: PersistedRosterRow | null;
  reconcilesPdf: boolean;
};

export type ManualIadpImportPreview = {
  period: ReturnType<typeof normalizeIadpRosterEvents>['period'];
  sourceRefTimestamp: string | null;
  snapshot: ReturnType<typeof validateIadpFullSnapshot>;
  insertions: ManualIadpPreviewEntry[];
  updates: ManualIadpPreviewEntry[];
  unchanged: ManualIadpPreviewEntry[];
  removalCandidates: PersistedRosterRow[];
  warnings: string[];
};

export function buildManualIadpImportPreview({
  authenticatedUserId,
  payload,
  persistedRows,
}: {
  authenticatedUserId: string;
  payload: IadpRosterEventsResponse;
  persistedRows: PersistedRosterRow[];
}): ManualIadpImportPreview {
  if (persistedRows.some((row) => row.user_id !== authenticatedUserId)) {
    throw new Error('A prévia recebeu registros de outro usuário.');
  }

  const normalized = normalizeIadpRosterEvents(payload);
  const snapshot = validateIadpFullSnapshot(payload, normalized);
  const iadpBySourceId = new Map(
    persistedRows
      .filter((row) => row.roster_source === 'iadp' && row.source_event_id)
      .map((row) => [row.source_event_id as string, row])
  );
  const pdfRows = persistedRows.filter((row) => row.roster_source !== 'iadp');
  const claimedPdfRows = new Set<string>();
  const insertions: ManualIadpPreviewEntry[] = [];
  const updates: ManualIadpPreviewEntry[] = [];
  const unchanged: ManualIadpPreviewEntry[] = [];

  for (const item of normalized.items) {
    const existingIadp = iadpBySourceId.get(item.source_event_id);
    if (existingIadp) {
      const entry = toEntry(item, existingIadp, false);
      if (editableFingerprint(existingIadp) === editableFingerprint(item)) unchanged.push(entry);
      else updates.push(entry);
      continue;
    }

    const pdfMatch = findPdfReconciliationMatch(item, pdfRows, claimedPdfRows);
    if (pdfMatch) {
      claimedPdfRows.add(pdfMatch.id);
      updates.push(toEntry(item, pdfMatch, true));
    } else {
      insertions.push(toEntry(item, null, false));
    }
  }

  const incomingSourceIds = new Set(normalized.items.map((item) => item.source_event_id));
  const removalCandidates = persistedRows.filter((row) =>
    row.roster_source === 'iadp' &&
    Boolean(row.source_event_id) &&
    !incomingSourceIds.has(row.source_event_id as string) &&
    isWithinPeriod(row.departure_time, normalized.period.from, normalized.period.to)
  );

  return {
    period: normalized.period,
    sourceRefTimestamp: normalized.sourceRefTimestamp,
    snapshot,
    insertions,
    updates,
    unchanged,
    removalCandidates,
    warnings: normalized.warnings,
  };
}

export function buildRosterReconciliationKey(
  item: Pick<
    NormalizedIadpRosterItem,
    'source_kind' | 'flight_number' | 'origin' | 'destination' | 'departure_time' | 'departure_local_home_base'
  >
) {
  const localDate = (item.departure_local_home_base ?? item.departure_time).slice(0, 10);
  const base = [
    localDate,
    item.source_kind,
    normalizeCode(item.flight_number),
    normalizeCode(item.origin),
    normalizeCode(item.destination),
  ];
  if (item.source_kind === 'activity') {
    base.push((item.departure_local_home_base ?? item.departure_time).slice(11, 16));
  }
  return base.join('|');
}

function findPdfReconciliationMatch(
  item: NormalizedIadpRosterItem,
  rows: PersistedRosterRow[],
  claimedRows: Set<string>
) {
  const candidates = rows.filter((row) =>
    !claimedRows.has(row.id) && persistedReconciliationKey(row) === buildRosterReconciliationKey(item)
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const exactTime = candidates.filter((row) => row.departure_time === item.departure_time);
    if (exactTime.length === 1) return exactTime[0];
  }
  return null;
}

function persistedReconciliationKey(row: PersistedRosterRow) {
  const sourceKind = row.source_kind === 'activity' || row.crew_position === 'ROSTER_ACTIVITY'
    ? 'activity'
    : 'flight';
  return buildRosterReconciliationKey({
    source_kind: sourceKind,
    flight_number: row.flight_number,
    origin: row.origin,
    destination: row.destination,
    departure_time: row.departure_time,
    departure_local_home_base: null,
  });
}

function editableFingerprint(item: PersistedRosterRow | NormalizedIadpRosterItem) {
  return JSON.stringify({
    flight_number: item.flight_number,
    crew_position: item.crew_position,
    origin: item.origin,
    destination: item.destination,
    departure_time: item.departure_time,
    arrival_time: item.arrival_time,
    flight_duration_minutes: item.flight_duration_minutes,
    equipment: item.equipment,
  });
}

function toEntry(
  item: NormalizedIadpRosterItem,
  previous: PersistedRosterRow | null,
  reconcilesPdf: boolean
): ManualIadpPreviewEntry {
  return {
    item,
    previousRowId: previous?.id ?? null,
    previous,
    reconcilesPdf,
  };
}

function isWithinPeriod(value: string, from: string | null, to: string | null) {
  return Boolean(from && to && value >= from && value <= to);
}

function normalizeCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}
