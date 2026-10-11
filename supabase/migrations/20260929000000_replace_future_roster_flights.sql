-- Replace a user's current and future roster flights atomically while keeping
-- all historical flights untouched.

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
  DELETE FROM public.flight_leg_details
  WHERE user_id = p_user_id
    AND COALESCE(
      departure_time::DATE,
      CASE
        WHEN unique_key ~ '^\d{4}-\d{2}-\d{2}-' THEN SUBSTRING(unique_key FROM 1 FOR 10)::DATE
        ELSE NULL
      END
    ) >= p_cutoff_date;

  GET DIAGNOSTICS affected_deleted = ROW_COUNT;

  INSERT INTO public.flight_leg_details (
    unique_key,
    roster_id,
    user_id,
    flight_number,
    crew_position,
    origin,
    destination,
    departure_time,
    arrival_time,
    flight_duration_minutes,
    equipment,
    service_type,
    meal_type,
    updated_at
  )
  SELECT
    leg.unique_key,
    leg.roster_id,
    p_user_id,
    leg.flight_number,
    leg.crew_position,
    leg.origin,
    leg.destination,
    leg.departure_time,
    leg.arrival_time,
    leg.flight_duration_minutes,
    leg.equipment,
    leg.service_type,
    leg.meal_type,
    NOW()
  FROM JSONB_TO_RECORDSET(COALESCE(p_flight_legs, '[]'::JSONB)) AS leg(
    unique_key TEXT,
    roster_id UUID,
    flight_number TEXT,
    crew_position TEXT,
    origin TEXT,
    destination TEXT,
    departure_time TIMESTAMPTZ,
    arrival_time TIMESTAMPTZ,
    flight_duration_minutes INTEGER,
    equipment TEXT,
    service_type TEXT,
    meal_type TEXT
  )
  WHERE leg.departure_time::DATE >= p_cutoff_date;

  GET DIAGNOSTICS affected_inserted = ROW_COUNT;

  RETURN QUERY SELECT affected_deleted, affected_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_user_future_flight_legs(UUID, DATE, JSONB) TO service_role;
