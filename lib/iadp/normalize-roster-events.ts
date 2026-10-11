export type IadpAirportDate = {
  airportCode?: string | null;
  dateTime?: string | null;
  postfix?: string | null;
};

export type IadpEventDescription = {
  flightNumber?: string | null;
  aircraftTypeCode?: string | null;
  aircraftSubType?: string | null;
  groundActivityCode?: string | null;
  [key: string]: unknown;
};

export type IadpRosterEvent = {
  id?: string | number | null;
  logicalId?: string | null;
  type?: string | null;
  originalEventType?: string | null;
  from?: string | null;
  to?: string | null;
  fromDateTimeUTC?: string | null;
  toDateTimeUTC?: string | null;
  fromDateTimeSchedUTC?: string | null;
  toDateTimeSchedUTC?: string | null;
  fromDateTimeLtAtAirport?: string | null;
  toDateTimeLtAtAirport?: string | null;
  fromDateTimeLtAtHb?: string | null;
  toDateTimeLtAtHb?: string | null;
  departure?: IadpAirportDate | null;
  arrival?: IadpAirportDate | null;
  eventDescription?: IadpEventDescription | null;
  description?: string[] | null;
  events?: IadpRosterEvent[] | null;
};

export type IadpRosterEventsResponse = {
  success?: boolean;
  result?: {
    success?: boolean;
    refTimestamp?: string | null;
    rosterPeriod?: {
      from?: string | null;
      to?: string | null;
      fromLocalAtHb?: string | null;
      toLocalAtHb?: string | null;
    } | null;
    events?: IadpRosterEvent[] | null;
  } | null;
};

export type IadpRosterUpdatesResponse = {
  success?: boolean;
  result?: {
    roster?: boolean;
    lastRosterChange?: string | null;
    lastDailyRemarkTimestamp?: string | null;
  } | null;
};

export type NormalizedIadpRosterItem = {
  unique_key: string;
  source: 'iadp';
  source_event_id: string;
  source_parent_event_id: string | null;
  source_kind: 'flight' | 'activity';
  flight_number: string;
  crew_position: string | null;
  origin: string;
  destination: string;
  departure_time: string;
  arrival_time: string;
  scheduled_departure_time: string | null;
  scheduled_arrival_time: string | null;
  departure_local_airport: string | null;
  arrival_local_airport: string | null;
  departure_local_home_base: string | null;
  arrival_local_home_base: string | null;
  flight_duration_minutes: number;
  equipment: string | null;
  service_type: null;
  meal_type: null;
};

export type NormalizedIadpRoster = {
  period: {
    from: string | null;
    to: string | null;
    fromLocalAtHomeBase: string | null;
    toLocalAtHomeBase: string | null;
  };
  sourceRefTimestamp: string | null;
  items: NormalizedIadpRosterItem[];
  warnings: string[];
};

export type IadpSnapshotSyncPlan = {
  upsert: NormalizedIadpRosterItem[];
  removeUniqueKeys: string[];
  unchangedUniqueKeys: string[];
};

export type IadpImportPreview = {
  scope: {
    userId: string;
    periodFrom: string | null;
    periodTo: string | null;
  };
  snapshot: {
    completeAndValid: boolean;
    removalSafe: boolean;
    leafEventCount: number;
    normalizedItemCount: number;
    reasons: string[];
    removalBlockers: string[];
  };
  insertions: NormalizedIadpRosterItem[];
  updates: Array<{
    previous: NormalizedIadpRosterItem;
    next: NormalizedIadpRosterItem;
    replacesUniqueKey: string | null;
  }>;
  removals: NormalizedIadpRosterItem[];
  suppressedRemovals: NormalizedIadpRosterItem[];
  unchanged: NormalizedIadpRosterItem[];
  warnings: string[];
};

/**
 * Converts an IADP full roster snapshot into the canonical flight-leg shape.
 * Pairing containers are flattened and only their leaf events are normalized.
 */
export function normalizeIadpRosterEvents(payload: IadpRosterEventsResponse): NormalizedIadpRoster {
  const warnings: string[] = [];
  const itemsByKey = new Map<string, NormalizedIadpRosterItem>();
  const events = payload.result?.events ?? [];

  for (const event of events) {
    visitEvent(event, null, itemsByKey, warnings);
  }

  const rosterPeriod = payload.result?.rosterPeriod;
  return {
    period: {
      from: normalizeOptionalInstant(rosterPeriod?.from),
      to: normalizeOptionalInstant(rosterPeriod?.to),
      fromLocalAtHomeBase: rosterPeriod?.fromLocalAtHb ?? null,
      toLocalAtHomeBase: rosterPeriod?.toLocalAtHb ?? null,
    },
    sourceRefTimestamp: normalizeOptionalInstant(payload.result?.refTimestamp),
    items: [...itemsByKey.values()].sort((left, right) =>
      left.departure_time.localeCompare(right.departure_time)
    ),
    warnings,
  };
}

/**
 * Plans changes between two complete snapshots. The `/updates` endpoint is only
 * a refresh signal; callers must fetch `/events` again before using this diff.
 */
export function planIadpSnapshotSync(
  previousItems: NormalizedIadpRosterItem[],
  nextItems: NormalizedIadpRosterItem[]
): IadpSnapshotSyncPlan {
  const previousByKey = new Map(previousItems.map((item) => [item.unique_key, item]));
  const nextByKey = new Map(nextItems.map((item) => [item.unique_key, item]));
  const previousBySourceId = new Map(previousItems.map((item) => [item.source_event_id, item]));
  const upsert: NormalizedIadpRosterItem[] = [];
  const unchangedUniqueKeys: string[] = [];
  const replacedPreviousKeys = new Set<string>();

  for (const item of nextByKey.values()) {
    const previous = previousBySourceId.get(item.source_event_id) ?? previousByKey.get(item.unique_key);
    if (!previous || persistenceFingerprint(previous) !== persistenceFingerprint(item)) {
      upsert.push(item);
      if (previous && previous.unique_key !== item.unique_key) replacedPreviousKeys.add(previous.unique_key);
    } else {
      unchangedUniqueKeys.push(item.unique_key);
    }
  }

  const nextSourceIds = new Set(nextItems.map((item) => item.source_event_id));
  const removeUniqueKeys = [...previousByKey.values()]
    .filter((item) => replacedPreviousKeys.has(item.unique_key) || !nextSourceIds.has(item.source_event_id))
    .map((item) => item.unique_key);
  return { upsert, removeUniqueKeys, unchangedUniqueKeys };
}

/**
 * Builds a read-only import preview. Removals are emitted only for a complete,
 * valid snapshot and only inside that snapshot's covered period.
 */
export function buildIadpImportPreview({
  userId,
  previousSnapshot,
  nextPayload,
}: {
  userId: string;
  previousSnapshot: {
    userId: string;
    items: NormalizedIadpRosterItem[];
  };
  nextPayload: IadpRosterEventsResponse;
}): IadpImportPreview {
  const normalized = normalizeIadpRosterEvents(nextPayload);
  const baseValidation = validateIadpFullSnapshot(nextPayload, normalized);
  const userScopeMatches = previousSnapshot.userId === userId;
  const validation = userScopeMatches
    ? baseValidation
    : {
        ...baseValidation,
        completeAndValid: false,
        removalSafe: false,
        reasons: [...baseValidation.reasons, 'previous-snapshot-user-mismatch'],
        removalBlockers: [...baseValidation.removalBlockers, 'previous-snapshot-user-mismatch'],
      };
  const previousItems = userScopeMatches ? previousSnapshot.items : [];
  const previousBySourceId = new Map(previousItems.map((item) => [item.source_event_id, item]));
  const nextSourceIds = new Set(normalized.items.map((item) => item.source_event_id));
  const insertions: NormalizedIadpRosterItem[] = [];
  const updates: IadpImportPreview['updates'] = [];
  const unchanged: NormalizedIadpRosterItem[] = [];

  for (const item of normalized.items) {
    const previous = previousBySourceId.get(item.source_event_id);
    if (!previous) {
      insertions.push(item);
    } else if (
      previous.unique_key !== item.unique_key ||
      persistenceFingerprint(previous) !== persistenceFingerprint(item)
    ) {
      updates.push({
        previous,
        next: item,
        replacesUniqueKey: previous.unique_key === item.unique_key ? null : previous.unique_key,
      });
    } else {
      unchanged.push(item);
    }
  }

  const removalCandidates = previousItems.filter((item) =>
    !nextSourceIds.has(item.source_event_id) &&
    isInsideSnapshotPeriod(item, normalized.period.from, normalized.period.to)
  );

  return {
    scope: {
      userId,
      periodFrom: normalized.period.from,
      periodTo: normalized.period.to,
    },
    snapshot: validation,
    insertions,
    updates,
    removals: [],
    suppressedRemovals: removalCandidates,
    unchanged,
    warnings: normalized.warnings,
  };
}

export function iadpUpdateRequiresFullRosterRefresh(payload: IadpRosterUpdatesResponse) {
  return payload.success === true && payload.result?.roster === true;
}

function visitEvent(
  event: IadpRosterEvent,
  parentSourceId: string | null,
  itemsByKey: Map<string, NormalizedIadpRosterItem>,
  warnings: string[]
) {
  const sourceId = getSourceId(event);
  const children = event.events?.filter(Boolean) ?? [];

  if (children.length > 0) {
    for (const child of children) {
      visitEvent(child, sourceId, itemsByKey, warnings);
    }
    return;
  }

  const item = normalizeLeafEvent(event, sourceId, parentSourceId, warnings);
  if (!item) return;

  if (itemsByKey.has(item.unique_key)) {
    warnings.push(`Duplicate IADP roster identity ignored: ${item.unique_key}`);
    return;
  }
  itemsByKey.set(item.unique_key, item);
}

function normalizeLeafEvent(
  event: IadpRosterEvent,
  sourceId: string,
  parentSourceId: string | null,
  warnings: string[]
): NormalizedIadpRosterItem | null {
  const departureTime = normalizeRequiredInstant(
    event.fromDateTimeUTC ?? event.from ?? event.departure?.dateTime,
    sourceId,
    'departure',
    warnings
  );
  const arrivalTime = normalizeRequiredInstant(
    event.toDateTimeUTC ?? event.to ?? event.arrival?.dateTime,
    sourceId,
    'arrival',
    warnings
  );
  if (!departureTime || !arrivalTime) return null;

  const departureMs = Date.parse(departureTime);
  const arrivalMs = Date.parse(arrivalTime);
  if (arrivalMs < departureMs) {
    warnings.push(`IADP event ${sourceId} has arrival before departure and was ignored.`);
    return null;
  }

  const flightNumber = normalizeCode(event.eventDescription?.flightNumber);
  const activityCode = normalizeCode(
    event.eventDescription?.groundActivityCode ?? event.originalEventType ?? event.type
  );
  const sourceKind = flightNumber ? 'flight' : 'activity';
  const canonicalCode = flightNumber ?? activityCode;
  if (!canonicalCode) {
    warnings.push(`IADP event ${sourceId} has no flight or activity code and was ignored.`);
    return null;
  }

  const origin = normalizeAirport(event.departure?.airportCode);
  const destination = normalizeAirport(event.arrival?.airportCode);
  const identityLocalTime =
    event.fromDateTimeLtAtHb ?? event.fromDateTimeLtAtAirport ?? departureTime;
  const { date } = getLocalIdentityParts(identityLocalTime, departureTime);
  const uniqueKey = `${date}-${canonicalCode}-${sourceKind.toUpperCase()}-${stableSourceToken(sourceId)}`;

  return {
    unique_key: uniqueKey,
    source: 'iadp',
    source_event_id: sourceId,
    source_parent_event_id: parentSourceId,
    source_kind: sourceKind,
    flight_number: canonicalCode,
    crew_position: sourceKind === 'activity' ? 'ROSTER_ACTIVITY' : null,
    origin,
    destination,
    departure_time: departureTime,
    arrival_time: arrivalTime,
    scheduled_departure_time: normalizeOptionalInstant(event.fromDateTimeSchedUTC),
    scheduled_arrival_time: normalizeOptionalInstant(event.toDateTimeSchedUTC),
    departure_local_airport: event.fromDateTimeLtAtAirport ?? null,
    arrival_local_airport: event.toDateTimeLtAtAirport ?? null,
    departure_local_home_base: event.fromDateTimeLtAtHb ?? null,
    arrival_local_home_base: event.toDateTimeLtAtHb ?? null,
    flight_duration_minutes: Math.round((arrivalMs - departureMs) / 60_000),
    equipment: sourceKind === 'flight'
      ? normalizeCode(event.eventDescription?.aircraftTypeCode ?? event.eventDescription?.aircraftSubType)
      : null,
    service_type: null,
    meal_type: null,
  };
}

function getSourceId(event: IadpRosterEvent) {
  const logicalId = event.logicalId === null || event.logicalId === undefined
    ? ''
    : String(event.logicalId).trim();
  const eventId = event.id === null || event.id === undefined
    ? ''
    : String(event.id).trim();
  if (logicalId && eventId) return `${logicalId}:${eventId}`;
  return logicalId || eventId || 'unknown-event';
}

function normalizeRequiredInstant(
  value: string | null | undefined,
  sourceId: string,
  field: string,
  warnings: string[]
) {
  const normalized = normalizeOptionalInstant(value);
  if (!normalized) {
    warnings.push(`IADP event ${sourceId} has no timezone-safe ${field} timestamp and was ignored.`);
  }
  return normalized;
}

function normalizeOptionalInstant(value: string | null | undefined) {
  if (!value || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function getLocalIdentityParts(localValue: string, utcFallback: string) {
  const match = localValue.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):?(\d{2})/);
  if (match) return { date: match[1], time: `${match[2]}${match[3]}` };
  return { date: utcFallback.slice(0, 10), time: utcFallback.slice(11, 16).replace(':', '') };
}

function normalizeAirport(value: string | null | undefined) {
  const airport = normalizeCode(value);
  return airport && /^[A-Z]{3}$/.test(airport) ? airport : '-';
}

function normalizeCode(value: string | null | undefined) {
  const normalized = value?.trim().toUpperCase().replace(/\s+/g, '');
  return normalized || null;
}

function stableSourceToken(sourceId: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sourceId.length; index += 1) {
    hash ^= sourceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function persistenceFingerprint(item: NormalizedIadpRosterItem) {
  return JSON.stringify({
    flight_number: item.flight_number,
    crew_position: item.crew_position,
    origin: item.origin,
    destination: item.destination,
    departure_time: item.departure_time,
    arrival_time: item.arrival_time,
    flight_duration_minutes: item.flight_duration_minutes,
    equipment: item.equipment,
    service_type: item.service_type,
    meal_type: item.meal_type,
  });
}

export function validateIadpFullSnapshot(
  payload: IadpRosterEventsResponse,
  normalized: NormalizedIadpRoster
) {
  const reasons: string[] = [];
  const leafEvents = countLeafEvents(payload.result?.events ?? []);
  const sourceIds = normalized.items.map((item) => item.source_event_id);

  if (payload.success !== true) reasons.push('top-level-success-is-not-true');
  if (payload.result?.success !== true) reasons.push('result-success-is-not-true');
  if (!Array.isArray(payload.result?.events)) reasons.push('events-array-is-missing');
  if (leafEvents === 0) reasons.push('events-snapshot-is-empty');
  if (!normalized.period.from || !normalized.period.to) reasons.push('roster-period-is-invalid');
  if (
    normalized.period.from &&
    normalized.period.to &&
    normalized.period.from >= normalized.period.to
  ) {
    reasons.push('roster-period-is-not-increasing');
  }
  if (normalized.items.length !== leafEvents) reasons.push('one-or-more-leaf-events-failed-normalization');
  if (new Set(sourceIds).size !== sourceIds.length) reasons.push('source-event-ids-are-not-unique');
  if (normalized.warnings.length > 0) reasons.push('normalization-produced-warnings');

  const completeAndValid = reasons.length === 0;
  return {
    completeAndValid,
    removalSafe: false,
    leafEventCount: leafEvents,
    normalizedItemCount: normalized.items.length,
    reasons,
    removalBlockers: [
      ...(completeAndValid ? [] : ['snapshot-content-is-inconsistent']),
      'server-completeness-is-not-independently-proven',
      'automatic-removals-are-disabled',
    ],
  };
}

function countLeafEvents(events: IadpRosterEvent[]): number {
  return events.reduce((count, event) => {
    const children = event.events?.filter(Boolean) ?? [];
    return count + (children.length > 0 ? countLeafEvents(children) : 1);
  }, 0);
}

function isInsideSnapshotPeriod(
  item: NormalizedIadpRosterItem,
  periodFrom: string | null,
  periodTo: string | null
) {
  if (!periodFrom || !periodTo) return false;
  return item.departure_time >= periodFrom && item.departure_time <= periodTo;
}
