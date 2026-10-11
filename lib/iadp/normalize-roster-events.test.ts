import assert from 'node:assert/strict';
import test from 'node:test';

import { syntheticInitialRoster, syntheticUpdatedRoster } from './__fixtures__/synthetic-roster.js';
import {
  buildIadpImportPreview,
  iadpUpdateRequiresFullRosterRefresh,
  normalizeIadpRosterEvents,
  planIadpSnapshotSync,
} from './normalize-roster-events.js';

test('flattens pairing children and preserves standalone activities', () => {
  const result = normalizeIadpRosterEvents(syntheticInitialRoster);

  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map((item) => item.source_kind), ['flight', 'flight', 'activity']);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.items[0].source_parent_event_id, 'synthetic-pairing-oct-03:9000');
});

test('normalizes UTC instants while using home-base local time for identity', () => {
  const result = normalizeIadpRosterEvents(syntheticInitialRoster);
  const firstFlight = result.items[0];

  assert.match(firstFlight.unique_key, /^2026-10-03-G31234-FLIGHT-[0-9a-f]{8}$/);
  assert.equal(firstFlight.departure_time, '2026-10-03T23:30:00.000Z');
  assert.equal(firstFlight.arrival_time, '2026-10-04T02:30:00.000Z');
  assert.equal(firstFlight.flight_duration_minutes, 180);
  assert.equal(firstFlight.scheduled_departure_time, '2026-10-03T23:20:00.000Z');
  assert.equal(firstFlight.departure_local_home_base, '2026-10-03T20:30:00-03:00');
  assert.equal(firstFlight.equipment, 'B38M');
});

test('maps a ground activity to the existing roster activity convention', () => {
  const result = normalizeIadpRosterEvents(syntheticInitialRoster);
  const activity = result.items.find((item) => item.source_kind === 'activity');

  assert.ok(activity);
  assert.match(activity.unique_key, /^2026-10-05-FR-ACTIVITY-[0-9a-f]{8}$/);
  assert.equal(activity.flight_number, 'FR');
  assert.equal(activity.crew_position, 'ROSTER_ACTIVITY');
});

test('plans changed fields, moved legs, additions, and removals between full snapshots', () => {
  const initial = normalizeIadpRosterEvents(syntheticInitialRoster);
  const updated = normalizeIadpRosterEvents(syntheticUpdatedRoster);
  const plan = planIadpSnapshotSync(initial.items, updated.items);

  assert.equal(plan.upsert.length, 3);
  assert.deepEqual(plan.removeUniqueKeys, [initial.items.find((item) => item.flight_number === 'FR')?.unique_key]);
  assert.deepEqual(plan.unchangedUniqueKeys, []);
  assert.equal(plan.upsert.find((item) => item.flight_number === 'G31234')?.equipment, 'B38N');
  assert.equal(
    plan.upsert.find((item) => item.flight_number === 'G35678')?.unique_key,
    initial.items.find((item) => item.flight_number === 'G35678')?.unique_key
  );
  assert.ok(plan.upsert.some((item) => item.flight_number === 'G39012'));
});

test('builds a user- and period-scoped preview without treating a moved leg as a duplicate', () => {
  const initial = normalizeIadpRosterEvents(syntheticInitialRoster);
  const outsidePeriod = {
    ...initial.items[0],
    unique_key: '2026-12-01-G39999-FLIGHT-deadbeef',
    source_event_id: 'synthetic-outside-period',
    departure_time: '2026-12-01T13:00:00.000Z',
    arrival_time: '2026-12-01T14:00:00.000Z',
  };
  const preview = buildIadpImportPreview({
    userId: 'synthetic-user',
    previousSnapshot: { userId: 'synthetic-user', items: [...initial.items, outsidePeriod] },
    nextPayload: syntheticUpdatedRoster,
  });

  assert.equal(preview.scope.userId, 'synthetic-user');
  assert.equal(preview.snapshot.completeAndValid, true);
  assert.equal(preview.snapshot.removalSafe, false);
  assert.equal(preview.insertions.length, 1);
  assert.equal(preview.updates.length, 2);
  assert.equal(preview.removals.length, 0);
  assert.equal(preview.suppressedRemovals.length, 1);
  assert.equal(preview.suppressedRemovals[0].flight_number, 'FR');
  assert.equal(
    preview.updates.find((change) => change.next.flight_number === 'G35678')?.replacesUniqueKey,
    null
  );
  assert.ok(!preview.removals.some((item) => item.source_event_id === 'synthetic-outside-period'));
});

test('suppresses removals for a partial or invalid snapshot', () => {
  const initial = normalizeIadpRosterEvents(syntheticInitialRoster);
  const preview = buildIadpImportPreview({
    userId: 'synthetic-user',
    previousSnapshot: { userId: 'synthetic-user', items: initial.items },
    nextPayload: {
      success: false,
      result: {
        success: false,
        rosterPeriod: syntheticInitialRoster.result?.rosterPeriod,
        events: [],
      },
    },
  });

  assert.equal(preview.snapshot.removalSafe, false);
  assert.equal(preview.removals.length, 0);
  assert.equal(preview.suppressedRemovals.length, 3);
  assert.ok(preview.snapshot.reasons.includes('top-level-success-is-not-true'));
  assert.ok(preview.snapshot.reasons.includes('events-snapshot-is-empty'));
});

test('suppresses removals when the previous snapshot belongs to another user', () => {
  const initial = normalizeIadpRosterEvents(syntheticInitialRoster);
  const preview = buildIadpImportPreview({
    userId: 'authenticated-user',
    previousSnapshot: { userId: 'different-user', items: initial.items },
    nextPayload: syntheticUpdatedRoster,
  });

  assert.equal(preview.snapshot.removalSafe, false);
  assert.equal(preview.removals.length, 0);
  assert.ok(preview.snapshot.reasons.includes('previous-snapshot-user-mismatch'));
});

test('treats updates as a signal to fetch a new full events snapshot', () => {
  assert.equal(iadpUpdateRequiresFullRosterRefresh({ success: true, result: { roster: true } }), true);
  assert.equal(iadpUpdateRequiresFullRosterRefresh({ success: true, result: { roster: false } }), false);
  assert.equal(iadpUpdateRequiresFullRosterRefresh({ success: false, result: { roster: true } }), false);
});

test('rejects timestamps without an explicit timezone instead of guessing', () => {
  const result = normalizeIadpRosterEvents({
    success: true,
    result: {
      events: [{
        logicalId: 'synthetic-invalid-timezone',
        fromDateTimeUTC: '2026-10-10T08:00:00',
        toDateTimeUTC: '2026-10-10T09:00:00',
        eventDescription: { flightNumber: 'G3 0001' },
      }],
    },
  });

  assert.equal(result.items.length, 0);
  assert.equal(result.warnings.length, 2);
});
