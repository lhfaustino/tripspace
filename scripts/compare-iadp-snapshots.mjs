import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizeIadpRosterEvents } from '../.iadp-analysis/iadp-runtime/lib/iadp/normalize-roster-events.js';

const previousPath = process.argv[2];
const nextPath = process.argv[3];
const destinationPath = process.argv[4] ?? '.iadp-analysis/iadp-snapshot-comparison.json';

if (!previousPath || !nextPath) {
  console.error(
    'Uso: npm run iadp:compare-snapshots -- <anterior.json> <novo.json> [comparacao.json]'
  );
  process.exitCode = 1;
} else {
  const previousPayload = JSON.parse(await readFile(previousPath, 'utf8'));
  const nextPayload = JSON.parse(await readFile(nextPath, 'utf8'));
  const comparison = compareSnapshots(previousPayload, nextPayload);
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(comparison.summary, null, 2));
  console.log(`Comparacao detalhada gravada em ${destinationPath}`);
}

function compareSnapshots(previousPayload, nextPayload) {
  const previous = normalizeIadpRosterEvents(previousPayload);
  const next = normalizeIadpRosterEvents(nextPayload);
  const previousLeaves = flattenLeaves(previousPayload?.result?.events ?? []);
  const nextLeaves = flattenLeaves(nextPayload?.result?.events ?? []);
  const previousIdentities = indexIdentities(previousLeaves);
  const nextIdentities = indexIdentities(nextLeaves);
  const previousBySourceId = new Map(previous.items.map((item) => [item.source_event_id, item]));
  const nextBySourceId = new Map(next.items.map((item) => [item.source_event_id, item]));

  const previousIds = new Set(previousIdentities.byComposite.keys());
  const nextIds = new Set(nextIdentities.byComposite.keys());
  const stableIds = intersection(previousIds, nextIds);
  const onlyPreviousIds = difference(previousIds, nextIds);
  const onlyNextIds = difference(nextIds, previousIds);
  const period = comparePeriods(previous.period, next.period);

  const changes = [...stableIds].flatMap((sourceId) => {
    const before = previousBySourceId.get(sourceId);
    const after = nextBySourceId.get(sourceId);
    if (!before || !after) return [];
    const changedFields = diffItemFields(before, after);
    return changedFields.length === 0
      ? []
      : [{ sourceEventId: sourceId, changedFields }];
  });

  const additions = [...onlyNextIds].map((sourceEventId) => describeItem(nextBySourceId.get(sourceEventId), sourceEventId));
  const removalCandidates = [...onlyPreviousIds]
    .map((sourceEventId) => describeItem(previousBySourceId.get(sourceEventId), sourceEventId));
  const logicalIdChanges = compareLogicalIdMembership(previousIdentities, nextIdentities);
  const unexpectedIdentityChanges = findUnexpectedIdentityChanges(
    onlyPreviousIds,
    onlyNextIds,
    previousBySourceId,
    nextBySourceId
  );
  const previousContentChecks = contentChecks(
    previousPayload,
    previous,
    previousLeaves,
    previousIdentities
  );
  const nextContentChecks = contentChecks(nextPayload, next, nextLeaves, nextIdentities);
  const contentConsistent = previousContentChecks.length === 0 && nextContentChecks.length === 0;

  return {
    summary: {
      periodsMatch: period.exactMatch,
      periodAndContentComparable: period.exactMatch && contentConsistent,
      serverCompletenessProven: false,
      previousLeafEvents: previousLeaves.length,
      nextLeafEvents: nextLeaves.length,
      stableCompositeIdentities: stableIds.size,
      insertions: additions.length,
      alterations: changes.length,
      removalCandidates: removalCandidates.length,
      unexpectedIdentityChanges: unexpectedIdentityChanges.length,
      automaticRemovalsAllowed: false,
    },
    period,
    identityStability: {
      stableCompositeIds: [...stableIds],
      onlyInPrevious: [...onlyPreviousIds],
      onlyInNext: [...onlyNextIds],
      duplicateCompositeIdsInPrevious: previousIdentities.duplicates,
      duplicateCompositeIdsInNext: nextIdentities.duplicates,
      logicalIdsWithChangedEventIdMembership: logicalIdChanges,
    },
    insertions: additions,
    alterations: changes,
    removalCandidates,
    unexpectedIdentityChanges,
    consistency: {
      contentConsistent,
      previousContentProblems: previousContentChecks,
      nextContentProblems: nextContentChecks,
      previousWarnings: previous.warnings,
      nextWarnings: next.warnings,
      automaticRemovalsAllowed: false,
      blockers: [
        ...(period.exactMatch ? [] : ['snapshot-periods-do-not-match']),
        ...(contentConsistent ? [] : ['one-or-both-snapshots-failed-content-consistency-checks']),
        'server-completeness-is-not-independently-proven',
        'automatic-removals-are-disabled',
      ],
    },
  };
}

function contentChecks(payload, normalized, leaves, identities) {
  const problems = [];
  if (payload?.success !== true) problems.push('top-level-success-is-not-true');
  if (payload?.result?.success !== true) problems.push('result-success-is-not-true');
  if (!Array.isArray(payload?.result?.events)) problems.push('events-array-is-missing');
  if (leaves.length === 0) problems.push('events-snapshot-is-empty');
  if (!normalized.period.from || !normalized.period.to) problems.push('roster-period-is-invalid');
  if (
    normalized.period.from &&
    normalized.period.to &&
    normalized.period.from >= normalized.period.to
  ) {
    problems.push('roster-period-is-not-increasing');
  }
  if (normalized.items.length !== leaves.length) {
    problems.push('one-or-more-leaf-events-failed-normalization');
  }
  if (identities.duplicates.length > 0) problems.push('source-event-ids-are-not-unique');
  if (normalized.warnings.length > 0) problems.push('normalization-produced-warnings');
  return problems;
}

function flattenLeaves(events) {
  return events.flatMap((event) => {
    const children = Array.isArray(event?.events) ? event.events.filter(Boolean) : [];
    return children.length > 0 ? flattenLeaves(children) : [event];
  });
}

function sourceIdentity(event) {
  const logicalId = event?.logicalId === null || event?.logicalId === undefined
    ? ''
    : String(event.logicalId).trim();
  const eventId = event?.id === null || event?.id === undefined ? '' : String(event.id).trim();
  return {
    composite: logicalId && eventId ? `${logicalId}:${eventId}` : logicalId || eventId || 'unknown-event',
    logicalId: logicalId || null,
    eventId: eventId || null,
  };
}

function indexIdentities(events) {
  const byComposite = new Map();
  const byLogicalId = new Map();
  const duplicates = [];
  for (const event of events) {
    const identity = sourceIdentity(event);
    if (byComposite.has(identity.composite)) duplicates.push(identity.composite);
    byComposite.set(identity.composite, identity);
    if (identity.logicalId) {
      const ids = byLogicalId.get(identity.logicalId) ?? new Set();
      ids.add(identity.eventId);
      byLogicalId.set(identity.logicalId, ids);
    }
  }
  return { byComposite, byLogicalId, duplicates: [...new Set(duplicates)] };
}

function compareLogicalIdMembership(previous, next) {
  return [...intersection(new Set(previous.byLogicalId.keys()), new Set(next.byLogicalId.keys()))]
    .flatMap((logicalId) => {
      const previousIds = previous.byLogicalId.get(logicalId);
      const nextIds = next.byLogicalId.get(logicalId);
      if (setsEqual(previousIds, nextIds)) return [];
      return [{
        logicalId,
        previousEventIds: [...previousIds],
        nextEventIds: [...nextIds],
      }];
    });
}

function comparePeriods(previous, next) {
  const fields = ['from', 'to', 'fromLocalAtHomeBase', 'toLocalAtHomeBase'];
  const mismatchedFields = fields.filter((field) => previous[field] !== next[field]);
  return {
    exactMatch: mismatchedFields.length === 0,
    mismatchedFields,
    previous,
    next,
  };
}

function diffItemFields(previous, next) {
  const ignored = new Set(['unique_key', 'source', 'source_event_id', 'source_parent_event_id']);
  return Object.keys(next).flatMap((field) => {
    if (ignored.has(field) || previous[field] === next[field]) return [];
    return [{ field, previous: previous[field], next: next[field] }];
  });
}

function describeItem(item, sourceEventId) {
  if (!item) return { sourceEventId, normalized: false };
  return {
    sourceEventId,
    normalized: true,
    kind: item.source_kind,
    code: item.flight_number,
    origin: item.origin,
    destination: item.destination,
    departureTime: item.departure_time,
    arrivalTime: item.arrival_time,
  };
}

function findUnexpectedIdentityChanges(previousOnly, nextOnly, previousItems, nextItems) {
  const additionsBySignature = groupBy(
    [...nextOnly].map((id) => nextItems.get(id)).filter(Boolean),
    operationalSignature
  );
  const matches = [];
  for (const previousId of previousOnly) {
    const previous = previousItems.get(previousId);
    if (!previous) continue;
    const candidates = additionsBySignature.get(operationalSignature(previous)) ?? [];
    const next = candidates.shift();
    if (!next) continue;
    matches.push({
      signature: operationalSignature(previous),
      previousSourceEventId: previous.source_event_id,
      nextSourceEventId: next.source_event_id,
      note: 'Mesmo evento operacional aparente recebeu outra combinacao logicalId + id.',
    });
  }
  return matches;
}

function operationalSignature(item) {
  return [
    item.source_kind,
    item.flight_number,
    item.origin,
    item.destination,
    (item.departure_local_home_base ?? item.departure_local_airport ?? item.departure_time).slice(0, 10),
  ].join('|');
}

function groupBy(values, keyOf) {
  const grouped = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function difference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
