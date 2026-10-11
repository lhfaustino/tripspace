BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(22);

SELECT has_table('public', 'flight_leg_details', 'flight_leg_details exists');
SELECT has_column('public', 'flight_leg_details', 'roster_source', 'roster source is persisted');
SELECT has_column('public', 'flight_leg_details', 'source_event_id', 'IADP source identity is separate');
SELECT has_function('public', 'import_current_user_iadp_roster', 'IADP transactional RPC exists');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'iadp-test-a@example.invalid', '', NOW(),
    '{"provider":"email","providers":["email"]}'::JSONB, '{}'::JSONB, NOW(), NOW()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'iadp-test-b@example.invalid', '', NOW(),
    '{"provider":"email","providers":["email"]}'::JSONB, '{}'::JSONB, NOW(), NOW()
  );

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL request.jwt.claim.role = 'authenticated';

SELECT is(
  (
    SELECT inserted_count
    FROM public.import_current_user_iadp_roster(
      repeat('a', 64), '2030-10-01T12:00:00Z',
      '2030-10-01T00:00:00Z', '2030-11-01T00:00:00Z',
      '[{
        "unique_key":"2030-10-10-G31001-FLIGHT-a1b2c3d4",
        "source_event_id":"synthetic-logical-a:1001",
        "source_parent_event_id":"synthetic-pairing-a:9001",
        "source_kind":"flight",
        "flight_number":"G31001",
        "crew_position":null,
        "origin":"AAA",
        "destination":"BBB",
        "departure_time":"2030-10-10T12:00:00Z",
        "arrival_time":"2030-10-10T14:00:00Z",
        "scheduled_departure_time":"2030-10-10T12:00:00Z",
        "scheduled_arrival_time":"2030-10-10T14:00:00Z",
        "departure_local_home_base":"2030-10-10T09:00:00-03:00",
        "arrival_local_home_base":"2030-10-10T11:00:00-03:00",
        "flight_duration_minutes":120,
        "equipment":"SYN01",
        "service_type":null,
        "meal_type":null
      }]'::JSONB
    )
  ),
  1::BIGINT,
  'first IADP snapshot inserts one row for authenticated user A'
);

SELECT is(
  (SELECT COUNT(*) FROM public.flight_leg_details),
  1::BIGINT,
  'user A sees the inserted row through RLS'
);

SELECT is(
  (
    SELECT unchanged_count
    FROM public.import_current_user_iadp_roster(
      repeat('a', 64), '2030-10-01T12:00:00Z',
      '2030-10-01T00:00:00Z', '2030-11-01T00:00:00Z',
      '[{
        "unique_key":"2030-10-10-G31001-FLIGHT-a1b2c3d4",
        "source_event_id":"synthetic-logical-a:1001",
        "source_parent_event_id":"synthetic-pairing-a:9001",
        "source_kind":"flight",
        "flight_number":"G31001",
        "crew_position":null,
        "origin":"AAA",
        "destination":"BBB",
        "departure_time":"2030-10-10T12:00:00Z",
        "arrival_time":"2030-10-10T14:00:00Z",
        "scheduled_departure_time":"2030-10-10T12:00:00Z",
        "scheduled_arrival_time":"2030-10-10T14:00:00Z",
        "departure_local_home_base":"2030-10-10T09:00:00-03:00",
        "arrival_local_home_base":"2030-10-10T11:00:00-03:00",
        "flight_duration_minutes":120,
        "equipment":"SYN01",
        "service_type":null,
        "meal_type":null
      }]'::JSONB
    )
  ),
  1::BIGINT,
  'reimporting the same snapshot is unchanged'
);

SELECT is(
  (SELECT COUNT(*) FROM public.flight_leg_details),
  1::BIGINT,
  'reimport does not duplicate the row'
);

SELECT is(
  (
    SELECT updated_count
    FROM public.import_current_user_iadp_roster(
      repeat('b', 64), '2030-10-02T12:00:00Z',
      '2030-10-01T00:00:00Z', '2030-11-01T00:00:00Z',
      '[{
        "unique_key":"2030-10-10-G31001-FLIGHT-a1b2c3d4",
        "source_event_id":"synthetic-logical-a:1001",
        "source_parent_event_id":"synthetic-pairing-a:9001",
        "source_kind":"flight",
        "flight_number":"G31001",
        "crew_position":null,
        "origin":"AAA",
        "destination":"BBB",
        "departure_time":"2030-10-10T12:30:00Z",
        "arrival_time":"2030-10-10T14:30:00Z",
        "departure_local_home_base":"2030-10-10T09:30:00-03:00",
        "arrival_local_home_base":"2030-10-10T11:30:00-03:00",
        "flight_duration_minutes":120,
        "equipment":"SYN02",
        "service_type":null,
        "meal_type":null
      }]'::JSONB
    )
  ),
  1::BIGINT,
  'time and equipment changes update by stable source identity'
);

SELECT is(
  (SELECT departure_time FROM public.flight_leg_details WHERE source_event_id = 'synthetic-logical-a:1001'),
  '2030-10-10T12:30:00Z'::TIMESTAMPTZ,
  'updated editable time is persisted without changing identity'
);

SELECT throws_ok(
  $$INSERT INTO public.flight_leg_details (
      user_id, unique_key, flight_number, origin, destination, departure_time, arrival_time
    ) VALUES (
      '22222222-2222-4222-8222-222222222222', 'forbidden-cross-user', 'G39999',
      'AAA', 'BBB', '2030-10-20T10:00:00Z', '2030-10-20T11:00:00Z'
    )$$,
  '42501',
  NULL,
  'RLS prevents user A from inserting a row owned by user B'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
SET LOCAL request.jwt.claim.role = 'authenticated';

SELECT is(
  (
    SELECT inserted_count
    FROM public.import_current_user_iadp_roster(
      repeat('c', 64), '2030-10-03T12:00:00Z',
      '2030-10-01T00:00:00Z', '2030-11-01T00:00:00Z',
      '[{
        "unique_key":"2030-10-10-G31001-FLIGHT-a1b2c3d4",
        "source_event_id":"synthetic-logical-a:1001",
        "source_kind":"flight",
        "flight_number":"G31001",
        "origin":"AAA",
        "destination":"BBB",
        "departure_time":"2030-10-10T12:30:00Z",
        "arrival_time":"2030-10-10T14:30:00Z",
        "departure_local_home_base":"2030-10-10T09:30:00-03:00",
        "flight_duration_minutes":120
      }]'::JSONB
    )
  ),
  1::BIGINT,
  'the same source identity can exist independently for user B'
);

SELECT is(
  (SELECT COUNT(*) FROM public.flight_leg_details),
  1::BIGINT,
  'user B sees only its own row'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT is(
  (
    SELECT inserted_count
    FROM public.replace_user_future_flight_legs(
      '11111111-1111-4111-8111-111111111111',
      '2031-01-01',
      '[{
        "unique_key":"2031-01-10-G32002-CCC-DDD-0900",
        "roster_id":null,
        "flight_number":"G32002",
        "crew_position":null,
        "origin":"CCC",
        "destination":"DDD",
        "departure_time":"2031-01-10T09:00:00Z",
        "arrival_time":"2031-01-10T11:00:00Z",
        "flight_duration_minutes":120,
        "equipment":"SYN03",
        "service_type":"test-service",
        "meal_type":"test-meal"
      }]'::JSONB
    )
  ),
  1::BIGINT,
  'PDF regression inserts a future PDF row'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL request.jwt.claim.role = 'authenticated';

SELECT is(
  (
    SELECT reconciled_pdf_count
    FROM public.import_current_user_iadp_roster(
      repeat('d', 64), '2031-01-01T12:00:00Z',
      '2031-01-01T00:00:00Z', '2031-02-01T00:00:00Z',
      '[{
        "unique_key":"2031-01-10-G32002-FLIGHT-d4e5f6a7",
        "source_event_id":"synthetic-logical-pdf-match:2002",
        "source_kind":"flight",
        "flight_number":"G32002",
        "origin":"CCC",
        "destination":"DDD",
        "departure_time":"2031-01-10T09:00:00Z",
        "arrival_time":"2031-01-10T11:00:00Z",
        "departure_local_home_base":"2031-01-10T09:00:00Z",
        "flight_duration_minutes":120,
        "equipment":"SYN03"
      }]'::JSONB
    )
  ),
  1::BIGINT,
  'IADP adopts one matching PDF row instead of duplicating it'
);

SELECT is(
  (SELECT COUNT(*) FROM public.flight_leg_details WHERE reconciliation_key = '2031-01-10|flight|G32002|CCC|DDD'),
  1::BIGINT,
  'reconciled PDF/IADP operation has a single row'
);

SELECT is(
  (SELECT service_type FROM public.flight_leg_details WHERE source_event_id = 'synthetic-logical-pdf-match:2002'),
  'test-service'::TEXT,
  'PDF catering data survives IADP reconciliation'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT is(
  (
    SELECT inserted_count
    FROM public.replace_user_future_flight_legs(
      '11111111-1111-4111-8111-111111111111',
      '2031-01-01',
      '[
        {
          "unique_key":"2031-01-10-G32002-CCC-DDD-0900",
          "roster_id":null,
          "flight_number":"G32002",
          "crew_position":null,
          "origin":"CCC",
          "destination":"DDD",
          "departure_time":"2031-01-10T09:00:00Z",
          "arrival_time":"2031-01-10T11:00:00Z",
          "flight_duration_minutes":120
        },
        {
          "unique_key":"2031-01-11-G33003-EEE-FFF-1000",
          "roster_id":null,
          "flight_number":"G33003",
          "crew_position":null,
          "origin":"EEE",
          "destination":"FFF",
          "departure_time":"2031-01-11T10:00:00Z",
          "arrival_time":"2031-01-11T12:00:00Z",
          "flight_duration_minutes":120
        }
      ]'::JSONB
    )
  ),
  1::BIGINT,
  'PDF reimport skips the operation already owned by IADP'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL request.jwt.claim.role = 'authenticated';

SELECT is(
  (SELECT COUNT(*) FROM public.flight_leg_details WHERE source_event_id = 'synthetic-logical-pdf-match:2002'),
  1::BIGINT,
  'PDF replacement preserves the reconciled IADP row'
);

SELECT is(
  (SELECT COUNT(*) FROM public.flight_leg_details WHERE roster_source = 'pdf' AND flight_number = 'G33003'),
  1::BIGINT,
  'PDF replacement still inserts unrelated PDF operations'
);

SELECT is(
  (
    SELECT COUNT(*)
    FROM public.flight_leg_details
    WHERE source_event_id IN ('synthetic-logical-a:1001', 'synthetic-logical-pdf-match:2002')
  ),
  2::BIGINT,
  'omitted IADP identities remain stored because automatic removal is disabled'
);

RESET ROLE;
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$SELECT * FROM public.import_current_user_iadp_roster(
      repeat('e', 64), NOW(), NOW(), NOW() + INTERVAL '1 day', '[]'::JSONB
    )$$,
  '42501',
  NULL,
  'anonymous role cannot execute the IADP import RPC'
);

SELECT * FROM finish();
ROLLBACK;
