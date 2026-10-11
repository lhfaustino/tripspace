-- Manual IADP snapshot import. This migration is intentionally additive and is
-- not applied automatically by the application.

ALTER TABLE public.flight_leg_details
  ADD COLUMN IF NOT EXISTS roster_source TEXT NOT NULL DEFAULT 'pdf',
  ADD COLUMN IF NOT EXISTS source_event_id TEXT,
  ADD COLUMN IF NOT EXISTS source_parent_event_id TEXT,
  ADD COLUMN IF NOT EXISTS source_kind TEXT,
  ADD COLUMN IF NOT EXISTS source_snapshot_digest TEXT,
  ADD COLUMN IF NOT EXISTS source_ref_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_departure_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_arrival_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS departure_local_airport TEXT,
  ADD COLUMN IF NOT EXISTS arrival_local_airport TEXT,
  ADD COLUMN IF NOT EXISTS departure_local_home_base TEXT,
  ADD COLUMN IF NOT EXISTS arrival_local_home_base TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_key TEXT;

ALTER TABLE public.flight_leg_details
  DROP CONSTRAINT IF EXISTS flight_leg_details_roster_source_check,
  ADD CONSTRAINT flight_leg_details_roster_source_check
    CHECK (roster_source IN ('pdf', 'iadp')),
  DROP CONSTRAINT IF EXISTS flight_leg_details_source_kind_check,
  ADD CONSTRAINT flight_leg_details_source_kind_check
    CHECK (source_kind IS NULL OR source_kind IN ('flight', 'activity'));

CREATE OR REPLACE FUNCTION public.roster_reconciliation_key(
  p_service_date DATE,
  p_source_kind TEXT,
  p_flight_number TEXT,
  p_origin TEXT,
  p_destination TEXT,
  p_service_time TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CONCAT_WS(
    '|',
    TO_CHAR(p_service_date, 'YYYY-MM-DD'),
    LOWER(p_source_kind),
    UPPER(REGEXP_REPLACE(COALESCE(p_flight_number, ''), '\s+', '', 'g')),
    UPPER(REGEXP_REPLACE(COALESCE(p_origin, ''), '\s+', '', 'g')),
    UPPER(REGEXP_REPLACE(COALESCE(p_destination, ''), '\s+', '', 'g')),
    CASE
      WHEN LOWER(p_source_kind) = 'activity' THEN p_service_time
      ELSE NULL
    END
  );
$$;

UPDATE public.flight_leg_details
SET
  roster_source = COALESCE(roster_source, 'pdf'),
  source_kind = COALESCE(
    source_kind,
    CASE WHEN crew_position = 'ROSTER_ACTIVITY' THEN 'activity' ELSE 'flight' END
  ),
  reconciliation_key = public.roster_reconciliation_key(
    (departure_time AT TIME ZONE 'UTC')::DATE,
    COALESCE(source_kind, CASE WHEN crew_position = 'ROSTER_ACTIVITY' THEN 'activity' ELSE 'flight' END),
    flight_number,
    origin,
    destination,
    TO_CHAR(departure_time AT TIME ZONE 'UTC', 'HH24:MI')
  )
WHERE reconciliation_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS flight_leg_details_user_iadp_source_event_idx
  ON public.flight_leg_details (user_id, source_event_id)
  WHERE roster_source = 'iadp' AND source_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS flight_leg_details_user_reconciliation_idx
  ON public.flight_leg_details (user_id, reconciliation_key);

CREATE OR REPLACE FUNCTION public.import_current_user_iadp_roster(
  p_snapshot_digest TEXT,
  p_source_ref_timestamp TIMESTAMPTZ,
  p_period_from TIMESTAMPTZ,
  p_period_to TIMESTAMPTZ,
  p_items JSONB
)
RETURNS TABLE(
  inserted_count BIGINT,
  updated_count BIGINT,
  unchanged_count BIGINT,
  reconciled_pdf_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_item JSONB;
  v_target_id UUID;
  v_target_source TEXT;
  v_match_count INTEGER;
  v_reconciliation_key TEXT;
  v_local_date DATE;
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_unchanged BIGINT := 0;
  v_reconciled BIGINT := 0;
  v_changed BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_snapshot_digest IS NULL OR LENGTH(p_snapshot_digest) <> 64 THEN
    RAISE EXCEPTION 'Invalid snapshot digest';
  END IF;
  IF p_period_from IS NULL OR p_period_to IS NULL OR p_period_from >= p_period_to THEN
    RAISE EXCEPTION 'Invalid roster period';
  END IF;
  IF JSONB_TYPEOF(p_items) <> 'array' THEN
    RAISE EXCEPTION 'IADP items must be a JSON array';
  END IF;

  -- Serialize imports for the same authenticated user inside this transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::TEXT, 0));

  FOR v_item IN SELECT value FROM JSONB_ARRAY_ELEMENTS(p_items)
  LOOP
    IF COALESCE(v_item->>'source_event_id', '') = '' THEN
      RAISE EXCEPTION 'Every IADP item requires source_event_id';
    END IF;
    IF v_item->>'source_kind' NOT IN ('flight', 'activity') THEN
      RAISE EXCEPTION 'Invalid IADP source_kind';
    END IF;
    IF (v_item->>'departure_time')::TIMESTAMPTZ < p_period_from
       OR (v_item->>'departure_time')::TIMESTAMPTZ > p_period_to THEN
      RAISE EXCEPTION 'IADP item is outside the confirmed roster period';
    END IF;

    v_local_date := COALESCE(
      SUBSTRING(v_item->>'departure_local_home_base' FROM 1 FOR 10)::DATE,
      ((v_item->>'departure_time')::TIMESTAMPTZ AT TIME ZONE 'UTC')::DATE
    );
    v_reconciliation_key := public.roster_reconciliation_key(
      v_local_date,
      v_item->>'source_kind',
      v_item->>'flight_number',
      v_item->>'origin',
      v_item->>'destination',
      COALESCE(
        SUBSTRING(v_item->>'departure_local_home_base' FROM 12 FOR 5),
        TO_CHAR((v_item->>'departure_time')::TIMESTAMPTZ AT TIME ZONE 'UTC', 'HH24:MI')
      )
    );

    v_target_id := NULL;
    v_target_source := NULL;
    SELECT id, roster_source
    INTO v_target_id, v_target_source
    FROM public.flight_leg_details
    WHERE user_id = v_user_id
      AND roster_source = 'iadp'
      AND source_event_id = v_item->>'source_event_id'
    FOR UPDATE;

    IF v_target_id IS NULL THEN
      SELECT COUNT(*), MIN(id::TEXT)::UUID
      INTO v_match_count, v_target_id
      FROM public.flight_leg_details
      WHERE user_id = v_user_id
        AND roster_source = 'pdf'
        AND reconciliation_key = v_reconciliation_key;

      IF v_match_count <> 1 THEN
        v_target_id := NULL;
      ELSE
        SELECT id, roster_source
        INTO v_target_id, v_target_source
        FROM public.flight_leg_details
        WHERE id = v_target_id AND user_id = v_user_id
        FOR UPDATE;
      END IF;
    END IF;

    IF v_target_id IS NULL THEN
      INSERT INTO public.flight_leg_details (
        user_id, unique_key, roster_source, source_event_id, source_parent_event_id,
        source_kind, source_snapshot_digest, source_ref_timestamp, reconciliation_key,
        flight_number, crew_position, origin, destination, departure_time, arrival_time,
        scheduled_departure_time, scheduled_arrival_time, departure_local_airport,
        arrival_local_airport, departure_local_home_base, arrival_local_home_base,
        flight_duration_minutes, equipment, service_type, meal_type, updated_at
      ) VALUES (
        v_user_id, v_item->>'unique_key', 'iadp', v_item->>'source_event_id',
        NULLIF(v_item->>'source_parent_event_id', ''), v_item->>'source_kind',
        p_snapshot_digest, p_source_ref_timestamp, v_reconciliation_key,
        v_item->>'flight_number', NULLIF(v_item->>'crew_position', ''),
        v_item->>'origin', v_item->>'destination',
        (v_item->>'departure_time')::TIMESTAMPTZ, (v_item->>'arrival_time')::TIMESTAMPTZ,
        NULLIF(v_item->>'scheduled_departure_time', '')::TIMESTAMPTZ,
        NULLIF(v_item->>'scheduled_arrival_time', '')::TIMESTAMPTZ,
        NULLIF(v_item->>'departure_local_airport', ''), NULLIF(v_item->>'arrival_local_airport', ''),
        NULLIF(v_item->>'departure_local_home_base', ''), NULLIF(v_item->>'arrival_local_home_base', ''),
        (v_item->>'flight_duration_minutes')::INTEGER, NULLIF(v_item->>'equipment', ''),
        NULLIF(v_item->>'service_type', ''), NULLIF(v_item->>'meal_type', ''), NOW()
      );
      v_inserted := v_inserted + 1;
    ELSE
      SELECT NOT (
        unique_key IS NOT DISTINCT FROM v_item->>'unique_key'
        AND roster_source = 'iadp'
        AND source_event_id IS NOT DISTINCT FROM v_item->>'source_event_id'
        AND flight_number IS NOT DISTINCT FROM v_item->>'flight_number'
        AND origin IS NOT DISTINCT FROM v_item->>'origin'
        AND destination IS NOT DISTINCT FROM v_item->>'destination'
        AND departure_time IS NOT DISTINCT FROM (v_item->>'departure_time')::TIMESTAMPTZ
        AND arrival_time IS NOT DISTINCT FROM (v_item->>'arrival_time')::TIMESTAMPTZ
        AND equipment IS NOT DISTINCT FROM NULLIF(v_item->>'equipment', '')
      )
      INTO v_changed
      FROM public.flight_leg_details
      WHERE id = v_target_id AND user_id = v_user_id;

      IF v_changed OR v_target_source = 'pdf' THEN
        UPDATE public.flight_leg_details
        SET
          unique_key = v_item->>'unique_key', roster_source = 'iadp',
          source_event_id = v_item->>'source_event_id',
          source_parent_event_id = NULLIF(v_item->>'source_parent_event_id', ''),
          source_kind = v_item->>'source_kind', source_snapshot_digest = p_snapshot_digest,
          source_ref_timestamp = p_source_ref_timestamp, reconciliation_key = v_reconciliation_key,
          flight_number = v_item->>'flight_number', crew_position = NULLIF(v_item->>'crew_position', ''),
          origin = v_item->>'origin', destination = v_item->>'destination',
          departure_time = (v_item->>'departure_time')::TIMESTAMPTZ,
          arrival_time = (v_item->>'arrival_time')::TIMESTAMPTZ,
          scheduled_departure_time = NULLIF(v_item->>'scheduled_departure_time', '')::TIMESTAMPTZ,
          scheduled_arrival_time = NULLIF(v_item->>'scheduled_arrival_time', '')::TIMESTAMPTZ,
          departure_local_airport = NULLIF(v_item->>'departure_local_airport', ''),
          arrival_local_airport = NULLIF(v_item->>'arrival_local_airport', ''),
          departure_local_home_base = NULLIF(v_item->>'departure_local_home_base', ''),
          arrival_local_home_base = NULLIF(v_item->>'arrival_local_home_base', ''),
          flight_duration_minutes = (v_item->>'flight_duration_minutes')::INTEGER,
          equipment = NULLIF(v_item->>'equipment', ''),
          service_type = COALESCE(NULLIF(v_item->>'service_type', ''), service_type),
          meal_type = COALESCE(NULLIF(v_item->>'meal_type', ''), meal_type),
          updated_at = NOW()
        WHERE id = v_target_id AND user_id = v_user_id;
        v_updated := v_updated + 1;
        IF v_target_source = 'pdf' THEN v_reconciled := v_reconciled + 1; END IF;
      ELSE
        v_unchanged := v_unchanged + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_updated, v_unchanged, v_reconciled;
END;
$$;

REVOKE ALL ON FUNCTION public.import_current_user_iadp_roster(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_current_user_iadp_roster(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.import_current_user_iadp_roster(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) TO authenticated;

-- Keep PDF as a fallback. PDF replacement now touches only PDF-owned rows and
-- skips operations already represented by an IADP row.
CREATE OR REPLACE FUNCTION public.replace_user_future_flight_legs(
  p_user_id UUID,
  p_cutoff_date DATE,
  p_flight_legs JSONB
)
RETURNS TABLE(deleted_count BIGINT, inserted_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_deleted BIGINT := 0;
  affected_inserted BIGINT := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 0));

  DELETE FROM public.flight_leg_details
  WHERE user_id = p_user_id
    AND roster_source = 'pdf'
    AND COALESCE(
      departure_time::DATE,
      CASE WHEN unique_key ~ '^\d{4}-\d{2}-\d{2}-' THEN SUBSTRING(unique_key FROM 1 FOR 10)::DATE END
    ) >= p_cutoff_date;
  GET DIAGNOSTICS affected_deleted = ROW_COUNT;

  INSERT INTO public.flight_leg_details (
    unique_key, roster_id, user_id, roster_source, source_kind, reconciliation_key,
    flight_number, crew_position, origin, destination, departure_time, arrival_time,
    flight_duration_minutes, equipment, service_type, meal_type, updated_at
  )
  SELECT
    leg.unique_key, leg.roster_id, p_user_id, 'pdf',
    CASE WHEN leg.crew_position = 'ROSTER_ACTIVITY' THEN 'activity' ELSE 'flight' END,
    public.roster_reconciliation_key(
      leg.departure_time::DATE,
      CASE WHEN leg.crew_position = 'ROSTER_ACTIVITY' THEN 'activity' ELSE 'flight' END,
      leg.flight_number, leg.origin, leg.destination,
      TO_CHAR(leg.departure_time AT TIME ZONE 'UTC', 'HH24:MI')
    ),
    leg.flight_number, leg.crew_position, leg.origin, leg.destination,
    leg.departure_time, leg.arrival_time, leg.flight_duration_minutes,
    leg.equipment, leg.service_type, leg.meal_type, NOW()
  FROM JSONB_TO_RECORDSET(COALESCE(p_flight_legs, '[]'::JSONB)) AS leg(
    unique_key TEXT, roster_id UUID, flight_number TEXT, crew_position TEXT,
    origin TEXT, destination TEXT, departure_time TIMESTAMPTZ, arrival_time TIMESTAMPTZ,
    flight_duration_minutes INTEGER, equipment TEXT, service_type TEXT, meal_type TEXT
  )
  WHERE leg.departure_time::DATE >= p_cutoff_date
    AND NOT EXISTS (
      SELECT 1
      FROM public.flight_leg_details existing
      WHERE existing.user_id = p_user_id
        AND existing.roster_source = 'iadp'
        AND existing.reconciliation_key = public.roster_reconciliation_key(
          leg.departure_time::DATE,
          CASE WHEN leg.crew_position = 'ROSTER_ACTIVITY' THEN 'activity' ELSE 'flight' END,
          leg.flight_number, leg.origin, leg.destination,
          TO_CHAR(leg.departure_time AT TIME ZONE 'UTC', 'HH24:MI')
        )
    );
  GET DIAGNOSTICS affected_inserted = ROW_COUNT;

  RETURN QUERY SELECT affected_deleted, affected_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) TO service_role;
