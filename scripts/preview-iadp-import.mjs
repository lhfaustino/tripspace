import { readFile, writeFile } from 'node:fs/promises';

import {
  buildIadpImportPreview,
  normalizeIadpRosterEvents,
} from '../.iadp-analysis/iadp-runtime/lib/iadp/normalize-roster-events.js';

const nextFixturePath = process.argv[2] ?? '.iadp-analysis/iadp-events.anonymized.json';
const previousFixturePath = process.argv[3];
const outputPath = process.argv[4] ?? '.iadp-analysis/iadp-import-preview.json';
const nextPayload = JSON.parse(await readFile(nextFixturePath, 'utf8'));
const previousItems = previousFixturePath
  ? normalizeIadpRosterEvents(JSON.parse(await readFile(previousFixturePath, 'utf8'))).items
  : [];
const preview = buildIadpImportPreview({
  userId: 'local-preview-user',
  previousSnapshot: { userId: 'local-preview-user', items: previousItems },
  nextPayload,
});
const output = {
  scope: preview.scope,
  snapshot: preview.snapshot,
  counts: {
    insertions: preview.insertions.length,
    updates: preview.updates.length,
    removals: preview.removals.length,
    suppressedRemovals: preview.suppressedRemovals.length,
    unchanged: preview.unchanged.length,
  },
  insertions: preview.insertions.map(summarizeItem),
  updates: preview.updates.map((change) => ({
    previous: summarizeItem(change.previous),
    next: summarizeItem(change.next),
    replacesUniqueKey: change.replacesUniqueKey,
  })),
  removals: preview.removals.map(summarizeItem),
  suppressedRemovals: preview.suppressedRemovals.map(summarizeItem),
  warnings: preview.warnings,
};

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, ...output.counts, snapshot: output.snapshot }, null, 2));

function summarizeItem(item) {
  return {
    uniqueKey: item.unique_key,
    sourceEventId: item.source_event_id,
    kind: item.source_kind,
    flightNumber: item.flight_number,
    origin: item.origin,
    destination: item.destination,
    departureTime: item.departure_time,
    arrivalTime: item.arrival_time,
    equipment: item.equipment,
  };
}
