import assert from 'node:assert/strict';
import test from 'node:test';

import { syntheticInitialRoster, syntheticUpdatedRoster } from './__fixtures__/synthetic-roster.js';
import {
  buildManualIadpImportPreview,
  type PersistedRosterRow,
} from './manual-import.js';
import { normalizeIadpRosterEvents } from './normalize-roster-events.js';

test('rejects persisted rows outside the authenticated user scope', () => {
  const foreignRow = toPersistedRows('another-user')[0];
  assert.throws(
    () => buildManualIadpImportPreview({
      authenticatedUserId: 'authenticated-user',
      payload: syntheticInitialRoster,
      persistedRows: [foreignRow],
    }),
    /outro usuário/
  );
});

test('reconciles a unique PDF operation instead of inserting a duplicate', () => {
  const normalized = normalizeIadpRosterEvents(syntheticInitialRoster);
  const item = normalized.items[0];
  const pdfRow: PersistedRosterRow = {
    ...toPersistedRows('user-1')[0],
    id: 'pdf-row',
    roster_source: 'pdf',
    source_event_id: null,
    unique_key: 'legacy-pdf-key',
    flight_number: item.flight_number,
    origin: item.origin,
    destination: item.destination,
    departure_time: item.departure_time,
    arrival_time: item.arrival_time,
  };
  const preview = buildManualIadpImportPreview({
    authenticatedUserId: 'user-1',
    payload: syntheticInitialRoster,
    persistedRows: [pdfRow],
  });

  assert.equal(preview.updates.length, 1);
  assert.equal(preview.updates[0].reconcilesPdf, true);
  assert.equal(preview.updates[0].previousRowId, 'pdf-row');
  assert.equal(preview.insertions.length, normalized.items.length - 1);
});

test('reimporting the same snapshot is idempotent', () => {
  const persistedRows = toPersistedRows('user-1');
  const preview = buildManualIadpImportPreview({
    authenticatedUserId: 'user-1',
    payload: syntheticInitialRoster,
    persistedRows,
  });

  assert.equal(preview.insertions.length, 0);
  assert.equal(preview.updates.length, 0);
  assert.equal(preview.unchanged.length, persistedRows.length);
  assert.equal(preview.removalCandidates.length, 0);
});

test('reports missing IADP rows only as removal candidates', () => {
  const preview = buildManualIadpImportPreview({
    authenticatedUserId: 'user-1',
    payload: syntheticUpdatedRoster,
    persistedRows: toPersistedRows('user-1'),
  });

  assert.equal(preview.removalCandidates.length, 1);
  assert.equal(preview.removalCandidates[0].flight_number, 'FR');
  assert.equal(preview.snapshot.removalSafe, false);
});

function toPersistedRows(userId: string): PersistedRosterRow[] {
  return normalizeIadpRosterEvents(syntheticInitialRoster).items.map((item, index) => ({
    id: `row-${index}`,
    user_id: userId,
    unique_key: item.unique_key,
    roster_source: 'iadp',
    source_event_id: item.source_event_id,
    source_parent_event_id: item.source_parent_event_id,
    source_kind: item.source_kind,
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
  }));
}
