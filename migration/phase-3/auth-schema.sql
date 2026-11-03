-- Additive Phase 3 Auth bridge; never drops or rewrites existing objects.
BEGIN;

DO $auth_migration_preflight$
BEGIN
  IF to_regclass('auth.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Supabase Auth users table/function is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'Supabase service_role is required';
  END IF;
  IF to_regclass('public.firebase_migration_auth_user_map') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_credentials') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_rate_limits') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to overwrite an existing Phase 3 Auth relation';
  END IF;
  IF to_regclass('public.firebase_migration_auth_user_map_pkey') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_credentials_pkey') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_rate_limits_pkey') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_email_unique') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_user_id_unique') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_rate_window_idx') IS NOT NULL OR
     to_regprocedure('public.firebase_migration_check_auth_rate_limit(text,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to overwrite an existing Phase 3 Auth index or function';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_control
    WHERE key = 'phase3_auth_schema_version'
  ) THEN
    RAISE EXCEPTION 'Phase 3 Auth schema version is already recorded';
  END IF;
END;
$auth_migration_preflight$;

CREATE TABLE public.firebase_migration_auth_user_map (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firebase_uid text NOT NULL,
  auth_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  email text NOT NULL,
  profile_found boolean NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  provider_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  password_migrated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_project, firebase_uid)
);

CREATE UNIQUE INDEX firebase_migration_auth_user_id_unique
  ON public.firebase_migration_auth_user_map (auth_user_id);

CREATE UNIQUE INDEX firebase_migration_auth_email_unique
  ON public.firebase_migration_auth_user_map (lower(email));

CREATE TABLE public.firebase_migration_auth_credentials (
  source_project text NOT NULL,
  firebase_uid text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_project, firebase_uid),
  FOREIGN KEY (source_project, firebase_uid)
    REFERENCES public.firebase_migration_auth_user_map (source_project, firebase_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_auth_rate_limits (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0)
);

CREATE INDEX firebase_migration_auth_rate_window_idx
  ON public.firebase_migration_auth_rate_limits (window_started_at);

ALTER TABLE public.firebase_migration_auth_user_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_auth_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_auth_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.firebase_migration_auth_user_map
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.firebase_migration_auth_credentials
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.firebase_migration_auth_rate_limits
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.firebase_migration_auth_user_map FROM service_role;
REVOKE ALL ON TABLE public.firebase_migration_auth_credentials FROM service_role;
REVOKE ALL ON TABLE public.firebase_migration_auth_rate_limits FROM service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.firebase_migration_auth_user_map
  TO service_role;
GRANT SELECT ON TABLE public.firebase_migration_auth_credentials
  TO service_role;

CREATE FUNCTION public.firebase_migration_check_auth_rate_limit(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  is_allowed boolean;
BEGIN
  IF p_bucket_key IS NULL OR length(p_bucket_key) < 1 OR length(p_bucket_key) > 128 OR
     p_limit < 1 OR p_limit > 1000 OR
     p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid Auth migration rate-limit arguments';
  END IF;

  DELETE FROM public.firebase_migration_auth_rate_limits
  WHERE window_started_at < v_now - interval '1 day';

  INSERT INTO public.firebase_migration_auth_rate_limits AS existing (
    bucket_key,
    window_started_at,
    attempt_count
  )
  VALUES (p_bucket_key, v_now, 1)
  ON CONFLICT (bucket_key) DO UPDATE
  SET window_started_at = CASE
        WHEN existing.window_started_at <= v_now - pg_catalog.make_interval(secs => p_window_seconds)
          THEN v_now
        ELSE existing.window_started_at
      END,
      attempt_count = CASE
        WHEN existing.window_started_at <= v_now - pg_catalog.make_interval(secs => p_window_seconds)
          THEN 1
        ELSE existing.attempt_count + 1
      END
  RETURNING attempt_count <= p_limit INTO is_allowed;

  RETURN is_allowed;
END;
$function$;

REVOKE ALL ON FUNCTION public.firebase_migration_check_auth_rate_limit(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.firebase_migration_check_auth_rate_limit(text, integer, integer)
  TO service_role;

INSERT INTO public.firebase_migration_control (key, value)
VALUES ('phase3_auth_schema_version', '1');

COMMIT;
