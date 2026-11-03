BEGIN;

DO $transfer_contract_preflight$
BEGIN
  IF to_regclass('public.firebase_migration_student_transfers') IS NULL OR
     to_regclass('public.firebase_migration_control') IS NULL THEN
    RAISE EXCEPTION 'Phase 4 transfer relation and control table are required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_control
    WHERE key = 'phase4_transfer_contract_version'
  ) THEN
    RAISE EXCEPTION 'Transfer contract correction is already recorded';
  END IF;
  IF EXISTS (SELECT 1 FROM public.firebase_migration_student_transfers) THEN
    RAISE EXCEPTION 'Transfer relation is no longer empty; refusing automatic correction';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'firebase_migration_student_transfers'
      AND column_name IN (
        'requested_student_name',
        'verified_student_id',
        'verified_student_name',
        'initiated_by',
        'initiated_by_user',
        'released_at',
        'released_by',
        'released_by_user',
        'admitted_at',
        'admitted_by',
        'admitted_by_user',
        'new_student_id',
        'declined_at',
        'declined_by',
        'declined_by_user',
        'decline_reason'
      )
  ) THEN
    RAISE EXCEPTION 'Transfer contract correction columns already exist';
  END IF;
END;
$transfer_contract_preflight$;

ALTER TABLE public.firebase_migration_student_transfers
  ALTER COLUMN school_id DROP NOT NULL,
  ALTER COLUMN student_id DROP NOT NULL,
  ADD COLUMN requested_student_name text,
  ADD COLUMN verified_student_id text,
  ADD COLUMN verified_student_name text,
  ADD COLUMN initiated_by text,
  ADD COLUMN initiated_by_user text,
  ADD COLUMN released_at timestamptz,
  ADD COLUMN released_by text,
  ADD COLUMN released_by_user text,
  ADD COLUMN admitted_at timestamptz,
  ADD COLUMN admitted_by text,
  ADD COLUMN admitted_by_user text,
  ADD COLUMN new_student_id text,
  ADD COLUMN declined_at timestamptz,
  ADD COLUMN declined_by text,
  ADD COLUMN declined_by_user text,
  ADD COLUMN decline_reason text;

INSERT INTO public.firebase_migration_control (key, value)
VALUES ('phase4_transfer_contract_version', '1');

COMMIT;
