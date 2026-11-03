-- Phase 5A: allow the shared app to represent new schools and multiple
-- school memberships without changing existing source rows or grants.
BEGIN;

DO $shared_tenant_preflight$
DECLARE
  source_check_count integer;
  exact_source_check_count integer;
  source_columns_without_check integer;
  membership_count bigint;
  school_count bigint;
  source_constraint record;
BEGIN
  IF to_regclass('public.firebase_migration_control') IS NULL OR
     to_regclass('public.firebase_migration_user_tenant_memberships') IS NULL OR
     to_regclass('public.firebase_migration_schools') IS NULL OR
     to_regclass('public.firebase_migration_auth_credentials') IS NULL THEN
    RAISE EXCEPTION 'Phase 2, Auth, and Phase 4 schema prerequisites are required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_control
    WHERE key = 'phase5_shared_tenant_schema_version'
  ) THEN
    RAISE EXCEPTION 'Phase 5 shared tenant schema is already recorded';
  END IF;
  IF to_regclass('public.firebase_migration_schools_school_id_unique') IS NOT NULL THEN
    RAISE EXCEPTION 'Global school ID index already exists';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.firebase_migration_user_tenant_memberships'::regclass
      AND conname <> 'firebase_migration_user_tenant_memberships_pkey'
      AND contype = 'p'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.firebase_migration_user_tenant_memberships'::regclass
      AND conname = 'firebase_migration_user_tenant_memberships_pkey'
      AND contype = 'p'
      AND pg_get_constraintdef(oid) =
        'PRIMARY KEY (auth_user_id, source_project)'
  ) THEN
    RAISE EXCEPTION 'Membership primary key is not the expected Phase 2 key';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'public.firebase_migration_user_tenant_memberships'::regclass
  ) THEN
    RAISE EXCEPTION 'Membership primary key has inbound foreign-key dependencies';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_user_tenant_memberships
    GROUP BY auth_user_id, source_project, school_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Existing membership rows collide on the multi-school key';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_schools
    WHERE school_id IS NULL OR length(btrim(school_id)) = 0
  ) OR EXISTS (
    SELECT 1
    FROM public.firebase_migration_schools
    GROUP BY school_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'School IDs are missing or not globally unique';
  END IF;

  SELECT count(*)::integer
    INTO source_check_count
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%source_project%';

  SELECT count(*)::integer
    INTO exact_source_check_count
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) =
      'CHECK ((source_project = ANY (ARRAY[''ku''::text, ''kiwanja''::text])))';

  SELECT count(*)::integer
    INTO source_columns_without_check
  FROM pg_attribute a
  JOIN pg_class r ON r.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND r.relname LIKE 'firebase_migration_%'
    AND r.relkind IN ('r', 'p')
    AND a.attname = 'source_project'
    AND NOT a.attisdropped
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conrelid = r.oid
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%source_project%'
    );

  IF source_check_count <> 104 OR exact_source_check_count <> 104 OR
     source_columns_without_check <> 1 OR NOT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class r ON r.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'public'
         AND r.relname = 'firebase_migration_auth_credentials'
         AND a.attname = 'source_project'
         AND NOT a.attisdropped
         AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint c
           WHERE c.conrelid = r.oid
             AND c.contype = 'c'
             AND pg_get_constraintdef(c.oid) ILIKE '%source_project%'
         )
     ) THEN
    RAISE EXCEPTION
      'Expected 104 exact source checks and only the Auth credentials relation without one';
  END IF;

  SELECT count(*) INTO membership_count
  FROM public.firebase_migration_user_tenant_memberships;
  SELECT count(*) INTO school_count
  FROM public.firebase_migration_schools;

  FOR source_constraint IN
    SELECT c.conrelid::regclass AS relation_name, c.conname
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) =
        'CHECK ((source_project = ANY (ARRAY[''ku''::text, ''kiwanja''::text])))'
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      source_constraint.relation_name,
      source_constraint.conname
    );
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (source_project IN (''ku'', ''kiwanja'', ''platform''))',
      source_constraint.relation_name,
      source_constraint.conname
    );
  END LOOP;

  ALTER TABLE public.firebase_migration_auth_credentials
    ADD CONSTRAINT firebase_migration_auth_credentials_source_project_check
    CHECK (source_project IN ('ku', 'kiwanja', 'platform'));

  ALTER TABLE public.firebase_migration_user_tenant_memberships
    DROP CONSTRAINT firebase_migration_user_tenant_memberships_pkey,
    ADD CONSTRAINT firebase_migration_user_tenant_memberships_pkey
      PRIMARY KEY (auth_user_id, source_project, school_id);

  ALTER TABLE public.firebase_migration_schools
    ALTER COLUMN school_id SET NOT NULL;
  CREATE UNIQUE INDEX firebase_migration_schools_school_id_unique
    ON public.firebase_migration_schools (school_id);

  IF (SELECT count(*) FROM public.firebase_migration_user_tenant_memberships)
       <> membership_count OR
     (SELECT count(*) FROM public.firebase_migration_schools) <> school_count THEN
    RAISE EXCEPTION 'Phase 5 schema changes unexpectedly changed row counts';
  END IF;
  IF (
    SELECT count(*)::integer
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) =
        'CHECK ((source_project = ANY (ARRAY[''ku''::text, ''kiwanja''::text, ''platform''::text])))'
  ) <> 105 THEN
    RAISE EXCEPTION 'Phase 5 source-project constraints failed postflight';
  END IF;
END;
$shared_tenant_preflight$;

INSERT INTO public.firebase_migration_control (key, value)
VALUES ('phase5_shared_tenant_schema_version', '1');

COMMIT;
