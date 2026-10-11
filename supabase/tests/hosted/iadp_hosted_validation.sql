-- Hosted-only validation runner. This file is copied to the isolated test
-- workdir as a migration after the application schema has been applied.

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_condition BOOLEAN, p_message TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_condition IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'IADP hosted validation failed: %', p_message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_sqlstate(
  p_statement TEXT,
  p_expected_state TEXT,
  p_message TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caught_state TEXT;
BEGIN
  BEGIN
    EXECUTE p_statement;
  EXCEPTION WHEN OTHERS THEN
    v_caught_state := SQLSTATE;
  END;
  IF v_caught_state IS DISTINCT FROM p_expected_state THEN
    RAISE EXCEPTION 'IADP hosted validation failed: % (expected %, got %)',
      p_message, p_expected_state, COALESCE(v_caught_state, 'no error');
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flight_leg_details'
      AND column_name = 'source_event_id'
  ),
  'source_event_id column is missing'
);
SELECT pg_temp.assert_true(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.flight_leg_details'::REGCLASS),
  'RLS is not enabled on flight_leg_details'
);
SELECT pg_temp.assert_true(
  has_function_privilege('authenticated', 'public.import_current_user_iadp_roster(text,timestamptz,timestamptz,timestamptz,jsonb)', 'EXECUTE'),
  'authenticated role cannot execute the IADP RPC'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege('anon', 'public.import_current_user_iadp_roster(text,timestamptz,timestamptz,timestamptz,jsonb)', 'EXECUTE'),
  'anonymous role can execute the IADP RPC'
);

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'iadp-hosted-a@example.invalid', '', NOW(),
    '{"provider":"email","providers":["email"]}'::JSONB, '{}'::JSONB, NOW(), NOW()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'iadp-hosted-b@example.invalid', '', NOW(),
    '{"provider":"email","providers":["email"]}'::JSONB, '{}'::JSONB, NOW(), NOW()
  );

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL request.jwt.claim.role = 'authenticated';

SELECT * FROM public.import_current_user_iadp_roster(
  repeat('a', 64), '2030-10-01T12:00:00Z',
  '2030-10-01T00:00:00Z', '2030-11-01T00:00:00Z',
  '[{
    "unique_key":"2030-10-10-G31001-FLIGHT-a1b2c3d4",
    "source_event_id":"synthetic-logical-a:1001",
    "source_parent_event_id":"synthetic-pairing-a:9001",
    "source_kind":"flight",
    "flight_number":"G31001",
    "origin":"AAA",
    "destination":"BBB",
    "departure_time":"2030-10-10T12:00:00Z",
    "arrival_time":"2030-10-10T14:00:00Z",
    "departure_local_home_base":"2030-10-10T09:00:00-03:00",
    "flight_duration_minutes":120,
    "equipment":"SYN01"
  }]'::JSONB
);
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details) = 1,
  'first import did not create exactly one visible row for user A'
);

SELECT * FROM public.import_current_user_iadp_roster(
  repeat('a', 64), '2030-10-01T12:00:00Z',
  '2030-10-01T00:00:00Z', '2030-11-01T00:00:00Z',
  '[{
    "unique_key":"2030-10-10-G31001-FLIGHT-a1b2c3d4",
    "source_event_id":"synthetic-logical-a:1001",
    "source_parent_event_id":"synthetic-pairing-a:9001",
    "source_kind":"flight",
    "flight_number":"G31001",
    "origin":"AAA",
    "destination":"BBB",
    "departure_time":"2030-10-10T12:00:00Z",
    "arrival_time":"2030-10-10T14:00:00Z",
    "departure_local_home_base":"2030-10-10T09:00:00-03:00",
    "flight_duration_minutes":120,
    "equipment":"SYN01"
  }]'::JSONB
);
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details) = 1,
  'same snapshot reimport created a duplicate'
);

SELECT * FROM public.import_current_user_iadp_roster(
  repeat('b', 64), '2030-10-02T12:00:00Z',
  '2030-10-01T00:00:00Z', '2030-11-01T00:00:00Z',
  '[{
    "unique_key":"2030-10-10-G31001-FLIGHT-a1b2c3d4",
    "source_event_id":"synthetic-logical-a:1001",
    "source_parent_event_id":"synthetic-pairing-a:9001",
    "source_kind":"flight",
    "flight_number":"G31001",
    "origin":"AAA",
    "destination":"BBB",
    "departure_time":"2030-10-10T12:30:00Z",
    "arrival_time":"2030-10-10T14:30:00Z",
    "departure_local_home_base":"2030-10-10T09:30:00-03:00",
    "flight_duration_minutes":120,
    "equipment":"SYN02"
  }]'::JSONB
);
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details) = 1
  AND (SELECT departure_time FROM public.flight_leg_details LIMIT 1) = '2030-10-10T12:30:00Z'::TIMESTAMPTZ
  AND (SELECT source_event_id FROM public.flight_leg_details LIMIT 1) = 'synthetic-logical-a:1001',
  'editable time update changed identity or duplicated the row'
);

SELECT pg_temp.assert_sqlstate(
  $$INSERT INTO public.flight_leg_details (
      user_id, unique_key, flight_number, origin, destination, departure_time, arrival_time
    ) VALUES (
      '22222222-2222-4222-8222-222222222222', 'forbidden-cross-user', 'G39999',
      'AAA', 'BBB', '2030-10-20T10:00:00Z', '2030-10-20T11:00:00Z'
    )$$,
  '42501',
  'RLS accepted cross-user insert'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
SET LOCAL request.jwt.claim.role = 'authenticated';

SELECT * FROM public.import_current_user_iadp_roster(
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
);
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details) = 1,
  'user B does not see exactly its own isolated row'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL request.jwt.claim.role = 'authenticated';
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details) = 1,
  'user A can see user B rows through RLS'
);

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT * FROM public.replace_user_future_flight_legs(
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
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL request.jwt.claim.role = 'authenticated';
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details WHERE roster_source = 'pdf' AND flight_number = 'G32002') = 1,
  'PDF regression did not insert the expected row'
);

SELECT * FROM public.import_current_user_iadp_roster(
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
);
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details WHERE reconciliation_key = '2031-01-10|flight|G32002|CCC|DDD') = 1,
  'IADP reconciliation duplicated the matching PDF operation'
);
SELECT pg_temp.assert_true(
  (SELECT roster_source FROM public.flight_leg_details WHERE source_event_id = 'synthetic-logical-pdf-match:2002') = 'iadp'
  AND (SELECT service_type FROM public.flight_leg_details WHERE source_event_id = 'synthetic-logical-pdf-match:2002') = 'test-service',
  'IADP reconciliation did not preserve PDF catering data'
);

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT * FROM public.replace_user_future_flight_legs(
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
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL request.jwt.claim.role = 'authenticated';
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details WHERE source_event_id = 'synthetic-logical-pdf-match:2002') = 1
  AND (SELECT COUNT(*) FROM public.flight_leg_details WHERE roster_source = 'pdf' AND flight_number = 'G33003') = 1,
  'PDF reimport did not preserve IADP and insert unrelated PDF operation'
);
SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.flight_leg_details WHERE roster_source = 'iadp') = 2,
  'an omitted IADP identity was deleted automatically'
);

RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.assert_sqlstate(
  $$SELECT * FROM public.import_current_user_iadp_roster(
      repeat('e', 64), NOW(), NOW(), NOW() + INTERVAL '1 day', '[]'::JSONB
    )$$,
  '42501',
  'anonymous execution of IADP RPC was not denied'
);

RESET ROLE;
DELETE FROM public.flight_leg_details
WHERE user_id IN (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
);
DELETE FROM auth.users
WHERE id IN (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.flight_leg_details
    WHERE user_id IN (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    )
  ),
  'synthetic flight rows were not cleaned up'
);
