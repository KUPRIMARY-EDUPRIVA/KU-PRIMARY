-- Phase 4 Auth scope prerequisite. Existing mapping rows are preserved.
BEGIN;

DO $auth_source_scope_preflight$
BEGIN
  IF to_regclass('public.firebase_migration_auth_user_map') IS NULL OR
     to_regclass('public.firebase_migration_user_tenant_memberships') IS NULL OR
     to_regclass('public.firebase_migration_platform_admins') IS NULL OR
     to_regclass('public.firebase_migration_control') IS NULL THEN
    RAISE EXCEPTION 'Phase 2 and Phase 3 migration relations are required';
  END IF;
  IF to_regclass('public.firebase_migration_auth_user_id_unique') IS NULL OR
     to_regclass('public.firebase_migration_auth_email_unique') IS NULL THEN
    RAISE EXCEPTION 'Expected Phase 3 global Auth mapping indexes are missing';
  END IF;
  IF to_regclass('public.firebase_migration_auth_source_user_id_unique') IS NOT NULL OR
     to_regclass('public.firebase_migration_auth_source_email_unique') IS NOT NULL OR
     to_regclass('public.firebase_migration_platform_admin_memberships') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 Auth source-scope objects already exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_auth_user_map
    GROUP BY source_project, auth_user_id
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM public.firebase_migration_auth_user_map
    GROUP BY source_project, lower(email)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Source-scoped Auth mapping uniqueness preflight failed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_control
    WHERE key = 'phase4_auth_source_scope_schema_version'
  ) THEN
    RAISE EXCEPTION 'Phase 4 Auth source-scope schema version is already recorded';
  END IF;
END;
$auth_source_scope_preflight$;

-- Replace global uniqueness with per-source uniqueness without changing rows.
DROP INDEX public.firebase_migration_auth_user_id_unique;
DROP INDEX public.firebase_migration_auth_email_unique;

CREATE UNIQUE INDEX firebase_migration_auth_source_user_id_unique
  ON public.firebase_migration_auth_user_map (source_project, auth_user_id);
CREATE UNIQUE INDEX firebase_migration_auth_source_email_unique
  ON public.firebase_migration_auth_user_map (source_project, lower(email));

CREATE TABLE public.firebase_migration_platform_admin_memberships (
  auth_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (auth_user_id, source_project)
);

ALTER TABLE public.firebase_migration_platform_admin_memberships
  ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_self
  ON public.firebase_migration_platform_admin_memberships
  FOR SELECT TO authenticated
  USING (auth_user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.firebase_migration_platform_admin_memberships
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.firebase_migration_platform_admin_memberships
  TO authenticated;

REVOKE ALL ON TABLE public.firebase_migration_platform_admin_memberships
  FROM service_role;
GRANT SELECT, INSERT, DELETE
  ON TABLE public.firebase_migration_platform_admin_memberships
  TO service_role;

INSERT INTO public.firebase_migration_control (key, value)
VALUES ('phase4_auth_source_scope_schema_version', '1');

COMMIT;
