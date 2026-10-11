import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildIadpImportPreview,
  normalizeIadpRosterEvents,
} from '../.iadp-analysis/iadp-runtime/lib/iadp/normalize-roster-events.js';

const fixturePath = process.argv[2] ?? '.iadp-analysis/iadp-events.anonymized.json';
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const normalized = normalizeIadpRosterEvents(fixture);
const preview = buildIadpImportPreview({
  userId: 'fixture-validation-user',
  previousSnapshot: { userId: 'fixture-validation-user', items: [] },
  nextPayload: fixture,
});
const structural = inspectStructure(fixture.result?.events ?? []);

assert.ok(structural.topLevelEvents > 0, 'fixture must contain top-level events');
assert.ok(structural.pairingContainers > 0, 'fixture must contain pairings with child events');
assert.ok(structural.flightLeaves > 0, 'fixture must contain flight leaves');
assert.equal(normalized.warnings.length, 0, 'all real-shape leaves must normalize without warnings');
assert.equal(normalized.items.length, structural.leafEvents, 'every leaf event must normalize');
assert.equal(preview.snapshot.completeAndValid, true, 'fixture must validate as a complete snapshot');
assert.equal(preview.snapshot.removalSafe, false, 'automatic removals must remain disabled');
assert.equal(preview.insertions.length, normalized.items.length);
assert.equal(preview.updates.length, 0);
assert.equal(preview.removals.length, 0);

console.log(JSON.stringify({
  fixtureValidated: true,
  ...structural,
  normalizedItems: normalized.items.length,
  normalizedFlights: normalized.items.filter((item) => item.source_kind === 'flight').length,
  normalizedActivities: normalized.items.filter((item) => item.source_kind === 'activity').length,
  warnings: normalized.warnings.length,
  removalSafe: preview.snapshot.removalSafe,
}, null, 2));

function inspectStructure(events) {
  let pairingContainers = 0;
  let leafEvents = 0;
  let flightLeaves = 0;
  let activityLeaves = 0;

  function visit(event) {
    if (Array.isArray(event.events) && event.events.length > 0) {
      pairingContainers += 1;
      event.events.forEach(visit);
      return;
    }
    leafEvents += 1;
    if (event.eventDescription?.flightNumber) flightLeaves += 1;
    else activityLeaves += 1;
  }

  events.forEach(visit);
  return {
    topLevelEvents: events.length,
    pairingContainers,
    leafEvents,
    flightLeaves,
    activityLeaves,
  };
}
