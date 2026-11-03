BEGIN;

DO $active_app_rls_preflight$
DECLARE
  table_name text;
  required_tables text[] := ARRAY[
    'firebase_migration_assessment_configs',
    'firebase_migration_invoices',
    'firebase_migration_invoice_items',
    'firebase_migration_sms_history',
    'firebase_migration_sms_history_outcomes',
    'firebase_migration_sms_templates',
    'firebase_migration_health_records',
    'firebase_migration_allergies',
    'firebase_migration_prescriptions',
    'firebase_migration_immunizations',
    'firebase_migration_medical_staff',
    'firebase_migration_dormitories',
    'firebase_migration_dorm_assignments',
    'firebase_migration_dorm_patrons',
    'firebase_migration_dorm_rules',
    'firebase_migration_dorm_inventory',
    'firebase_migration_buses',
    'firebase_migration_routes',
    'firebase_migration_route_days',
    'firebase_migration_drivers',
    'firebase_migration_fuel_records',
    'firebase_migration_duty_rosters',
    'firebase_migration_duty_roster_entries',
    'firebase_migration_timetable_events',
    'firebase_migration_timetable_event_days',
    'firebase_migration_timetable_event_periods',
    'firebase_migration_timetable_event_classes'
  ];
  policy_name text;
  planned_policies text[] := ARRAY[
    'phase4_assessment_read', 'phase4_assessment_write',
    'phase4_invoice_read', 'phase4_invoice_insert', 'phase4_invoice_update', 'phase4_invoice_delete',
    'phase4_invoice_items_read', 'phase4_invoice_items_insert', 'phase4_invoice_items_update', 'phase4_invoice_items_delete',
    'phase4_sms_history_read', 'phase4_sms_history_insert',
    'phase4_sms_outcomes_read', 'phase4_sms_outcomes_insert',
    'phase4_sms_templates_read',
    'phase4_health_records_read', 'phase4_health_records_write',
    'phase4_allergies_read', 'phase4_allergies_write',
    'phase4_prescriptions_read', 'phase4_prescriptions_write',
    'phase4_immunizations_read', 'phase4_immunizations_write',
    'phase4_medical_staff_read', 'phase4_medical_staff_write',
    'phase4_dormitories_read', 'phase4_dormitories_write',
    'phase4_dorm_assignments_read', 'phase4_dorm_assignments_write',
    'phase4_dorm_patrons_read', 'phase4_dorm_patrons_write',
    'phase4_dorm_rules_read', 'phase4_dorm_rules_write',
    'phase4_dorm_inventory_read', 'phase4_dorm_inventory_write',
    'phase4_buses_read', 'phase4_buses_write',
    'phase4_routes_read', 'phase4_routes_write',
    'phase4_route_days_read', 'phase4_route_days_write',
    'phase4_drivers_read', 'phase4_drivers_write',
    'phase4_fuel_records_read', 'phase4_fuel_records_write',
    'phase4_duty_rosters_read', 'phase4_duty_rosters_insert', 'phase4_duty_rosters_update',
    'phase4_duty_entries_read', 'phase4_duty_entries_insert', 'phase4_duty_entries_update', 'phase4_duty_entries_delete',
    'phase4_timetable_events_read', 'phase4_timetable_events_write',
    'phase4_event_days_read', 'phase4_event_days_write',
    'phase4_event_periods_read', 'phase4_event_periods_write',
    'phase4_event_classes_read', 'phase4_event_classes_write'
  ];
BEGIN
  IF to_regclass('public.firebase_migration_user_tenant_memberships') IS NULL OR
     to_regclass('public.firebase_migration_platform_admin_memberships') IS NULL OR
     to_regclass('public.firebase_migration_control') IS NULL OR
     to_regnamespace('firebase_migration_private') IS NOT NULL OR
     to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Phase 2/4 Auth relations are missing or private policy schema already exists';
  END IF;
  IF to_regprocedure('firebase_migration_private.has_school_access(text,text,text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 RLS helper already exists';
  END IF;
  IF to_regprocedure('firebase_migration_private.prevent_identity_change()') IS NOT NULL OR
     EXISTS (
       SELECT 1
       FROM pg_trigger
       WHERE tgname LIKE 'firebase_migration_phase4_identity_guard_%'
         AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'Phase 4 identity guard already exists';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(required_tables) AS required(name)
    LEFT JOIN pg_class c ON c.relname = required.name
    LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.oid IS NULL OR n.oid IS NULL OR NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'A required Phase 4 relation is missing or has RLS disabled';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(required_tables) AS required(name)
    JOIN pg_class c ON c.relname = required.name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE has_table_privilege('authenticated', c.oid, 'SELECT')
       OR has_table_privilege('authenticated', c.oid, 'INSERT')
       OR has_table_privilege('authenticated', c.oid, 'UPDATE')
       OR has_table_privilege('authenticated', c.oid, 'DELETE')
       OR has_table_privilege('anon', c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'A Phase 4 relation already has client privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM public.firebase_migration_invoices) THEN
    RAISE EXCEPTION 'Invoices are no longer empty; refusing validation-constraint changes';
  END IF;
  FOREACH policy_name IN ARRAY planned_policies LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polname = policy_name
    ) THEN
      RAISE EXCEPTION 'Policy % already exists', policy_name;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.firebase_migration_control
    WHERE key = 'phase4_active_app_rls_version'
  ) THEN
    RAISE EXCEPTION 'Phase 4 RLS schema version is already recorded';
  END IF;
END;
$active_app_rls_preflight$;

CREATE SCHEMA firebase_migration_private;
REVOKE ALL ON SCHEMA firebase_migration_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA firebase_migration_private TO authenticated;

CREATE FUNCTION firebase_migration_private.has_school_access(
  p_source_project text,
  p_school_id text,
  p_roles text[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.firebase_migration_user_tenant_memberships AS membership
        WHERE membership.auth_user_id = (SELECT auth.uid())
          AND membership.source_project = p_source_project
          AND membership.school_id = p_school_id
          AND (
            p_roles IS NULL
            OR membership.role = ANY (p_roles)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.firebase_migration_platform_admin_memberships AS platform_admin
        WHERE platform_admin.auth_user_id = (SELECT auth.uid())
          AND platform_admin.source_project = p_source_project
      )
    );
$function$;

REVOKE ALL ON FUNCTION firebase_migration_private.has_school_access(text, text, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION firebase_migration_private.has_school_access(text, text, text[])
  TO authenticated;

ALTER TABLE public.firebase_migration_invoices
  ALTER COLUMN total SET NOT NULL,
  ADD CONSTRAINT firebase_migration_invoices_total_nonnegative CHECK (total >= 0),
  ADD CONSTRAINT firebase_migration_invoices_school_id_valid
    CHECK (length(school_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT firebase_migration_invoices_student_id_valid
    CHECK (length(student_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT firebase_migration_invoices_term_valid
    CHECK (length(term) BETWEEN 1 AND 32),
  ADD CONSTRAINT firebase_migration_invoices_academic_year_valid
    CHECK (length(academic_year) BETWEEN 1 AND 32),
  ADD CONSTRAINT firebase_migration_invoices_status_valid
    CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'cancelled'));

CREATE FUNCTION firebase_migration_private.prevent_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  key_column text;
BEGIN
  FOREACH key_column IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(NEW) -> key_column) IS DISTINCT FROM (to_jsonb(OLD) -> key_column) THEN
      RAISE EXCEPTION 'Identity column % cannot be changed', key_column;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION firebase_migration_private.prevent_identity_change()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER firebase_migration_phase4_identity_guard_assessment_configs
  BEFORE UPDATE ON public.firebase_migration_assessment_configs
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_invoices
  BEFORE UPDATE ON public.firebase_migration_invoices
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id', 'student_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_invoice_items
  BEFORE UPDATE ON public.firebase_migration_invoice_items
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'invoice_firestore_id', 'ordinal'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_sms_history
  BEFORE UPDATE ON public.firebase_migration_sms_history
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_sms_history_outcomes
  BEFORE UPDATE ON public.firebase_migration_sms_history_outcomes
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'history_firestore_id', 'ordinal'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_sms_templates
  BEFORE UPDATE ON public.firebase_migration_sms_templates
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_health_records
  BEFORE UPDATE ON public.firebase_migration_health_records
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_allergies
  BEFORE UPDATE ON public.firebase_migration_allergies
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_prescriptions
  BEFORE UPDATE ON public.firebase_migration_prescriptions
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_immunizations
  BEFORE UPDATE ON public.firebase_migration_immunizations
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_medical_staff
  BEFORE UPDATE ON public.firebase_migration_medical_staff
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_dormitories
  BEFORE UPDATE ON public.firebase_migration_dormitories
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_dorm_assignments
  BEFORE UPDATE ON public.firebase_migration_dorm_assignments
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_dorm_patrons
  BEFORE UPDATE ON public.firebase_migration_dorm_patrons
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_dorm_rules
  BEFORE UPDATE ON public.firebase_migration_dorm_rules
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_dorm_inventory
  BEFORE UPDATE ON public.firebase_migration_dorm_inventory
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_buses
  BEFORE UPDATE ON public.firebase_migration_buses
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_routes
  BEFORE UPDATE ON public.firebase_migration_routes
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_route_days
  BEFORE UPDATE ON public.firebase_migration_route_days
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'route_firestore_id', 'ordinal'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_drivers
  BEFORE UPDATE ON public.firebase_migration_drivers
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_fuel_records
  BEFORE UPDATE ON public.firebase_migration_fuel_records
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_duty_rosters
  BEFORE UPDATE ON public.firebase_migration_duty_rosters
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_duty_roster_entries
  BEFORE UPDATE ON public.firebase_migration_duty_roster_entries
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'roster_firestore_id', 'day', 'duty_area_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_timetable_events
  BEFORE UPDATE ON public.firebase_migration_timetable_events
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'firestore_id', 'school_id'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_timetable_event_days
  BEFORE UPDATE ON public.firebase_migration_timetable_event_days
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'event_firestore_id', 'ordinal'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_timetable_event_periods
  BEFORE UPDATE ON public.firebase_migration_timetable_event_periods
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'event_firestore_id', 'ordinal'
  );
CREATE TRIGGER firebase_migration_phase4_identity_guard_timetable_event_classes
  BEFORE UPDATE ON public.firebase_migration_timetable_event_classes
  FOR EACH ROW EXECUTE FUNCTION firebase_migration_private.prevent_identity_change(
    'source_project', 'event_firestore_id', 'ordinal'
  );

CREATE POLICY phase4_assessment_read ON public.firebase_migration_assessment_configs
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_assessment_write ON public.firebase_migration_assessment_configs
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher', 'teacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher', 'teacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_assessment_configs TO authenticated;

CREATE POLICY phase4_invoice_read ON public.firebase_migration_invoices
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
  ));
CREATE POLICY phase4_invoice_insert ON public.firebase_migration_invoices
  FOR INSERT TO authenticated
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
  ));
CREATE POLICY phase4_invoice_update ON public.firebase_migration_invoices
  FOR UPDATE TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
  ));
CREATE POLICY phase4_invoice_delete ON public.firebase_migration_invoices
  FOR DELETE TO authenticated
  USING (
    status <> 'paid'
    AND firebase_migration_private.has_school_access(
      source_project, school_id,
      ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
    )
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_invoices TO authenticated;

CREATE POLICY phase4_invoice_items_read ON public.firebase_migration_invoice_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.firebase_migration_invoices AS invoice
    WHERE invoice.source_project = firebase_migration_invoice_items.source_project
      AND invoice.firestore_id = firebase_migration_invoice_items.invoice_firestore_id
      AND firebase_migration_private.has_school_access(
        invoice.source_project, invoice.school_id,
        ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
      )
  ));
CREATE POLICY phase4_invoice_items_insert ON public.firebase_migration_invoice_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_invoices AS invoice
    WHERE invoice.source_project = firebase_migration_invoice_items.source_project
      AND invoice.firestore_id = firebase_migration_invoice_items.invoice_firestore_id
      AND firebase_migration_private.has_school_access(
        invoice.source_project, invoice.school_id,
        ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
      )
  ));
CREATE POLICY phase4_invoice_items_update ON public.firebase_migration_invoice_items
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_invoices AS invoice
    WHERE invoice.source_project = firebase_migration_invoice_items.source_project
      AND invoice.firestore_id = firebase_migration_invoice_items.invoice_firestore_id
      AND firebase_migration_private.has_school_access(
        invoice.source_project, invoice.school_id,
        ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_invoices AS invoice
    WHERE invoice.source_project = firebase_migration_invoice_items.source_project
      AND invoice.firestore_id = firebase_migration_invoice_items.invoice_firestore_id
      AND firebase_migration_private.has_school_access(
        invoice.source_project, invoice.school_id,
        ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
      )
  ));
CREATE POLICY phase4_invoice_items_delete ON public.firebase_migration_invoice_items
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_invoices AS invoice
    WHERE invoice.source_project = firebase_migration_invoice_items.source_project
      AND invoice.firestore_id = firebase_migration_invoice_items.invoice_firestore_id
      AND firebase_migration_private.has_school_access(
        invoice.source_project, invoice.school_id,
        ARRAY['admin', 'user', 'school_admin', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']
      )
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_invoice_items TO authenticated;

CREATE POLICY phase4_sms_history_read ON public.firebase_migration_sms_history
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['headteacher']
  ));
CREATE POLICY phase4_sms_history_insert ON public.firebase_migration_sms_history
  FOR INSERT TO authenticated
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['headteacher']
  ));
GRANT SELECT, INSERT ON TABLE public.firebase_migration_sms_history TO authenticated;

CREATE POLICY phase4_sms_outcomes_read ON public.firebase_migration_sms_history_outcomes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_sms_history AS history
    WHERE history.source_project = firebase_migration_sms_history_outcomes.source_project
      AND history.firestore_id = firebase_migration_sms_history_outcomes.history_firestore_id
      AND firebase_migration_private.has_school_access(
        history.source_project, history.school_id, ARRAY['headteacher']
      )
  ));
CREATE POLICY phase4_sms_outcomes_insert ON public.firebase_migration_sms_history_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_sms_history AS history
    WHERE history.source_project = firebase_migration_sms_history_outcomes.source_project
      AND history.firestore_id = firebase_migration_sms_history_outcomes.history_firestore_id
      AND firebase_migration_private.has_school_access(
        history.source_project, history.school_id, ARRAY['headteacher']
      )
  ));
GRANT SELECT, INSERT ON TABLE public.firebase_migration_sms_history_outcomes TO authenticated;

CREATE POLICY phase4_sms_templates_read ON public.firebase_migration_sms_templates
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['headteacher']
  ));
GRANT SELECT ON TABLE public.firebase_migration_sms_templates TO authenticated;

CREATE POLICY phase4_health_records_read ON public.firebase_migration_health_records
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher', 'teacher']
  ));
CREATE POLICY phase4_health_records_write ON public.firebase_migration_health_records
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_health_records TO authenticated;

CREATE POLICY phase4_allergies_read ON public.firebase_migration_allergies
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher', 'teacher']
  ));
CREATE POLICY phase4_allergies_write ON public.firebase_migration_allergies
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_allergies TO authenticated;

CREATE POLICY phase4_prescriptions_read ON public.firebase_migration_prescriptions
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
CREATE POLICY phase4_prescriptions_write ON public.firebase_migration_prescriptions
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_prescriptions TO authenticated;

CREATE POLICY phase4_immunizations_read ON public.firebase_migration_immunizations
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_immunizations_write ON public.firebase_migration_immunizations
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_immunizations TO authenticated;

CREATE POLICY phase4_medical_staff_read ON public.firebase_migration_medical_staff
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_medical_staff_write ON public.firebase_migration_medical_staff
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_medical_staff TO authenticated;

CREATE POLICY phase4_dormitories_read ON public.firebase_migration_dormitories
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_dormitories_write ON public.firebase_migration_dormitories
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_dormitories TO authenticated;

CREATE POLICY phase4_dorm_assignments_read ON public.firebase_migration_dorm_assignments
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_dorm_assignments_write ON public.firebase_migration_dorm_assignments
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_dorm_assignments TO authenticated;

CREATE POLICY phase4_dorm_patrons_read ON public.firebase_migration_dorm_patrons
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_dorm_patrons_write ON public.firebase_migration_dorm_patrons
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_dorm_patrons TO authenticated;

CREATE POLICY phase4_dorm_rules_read ON public.firebase_migration_dorm_rules
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_dorm_rules_write ON public.firebase_migration_dorm_rules
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_dorm_rules TO authenticated;

CREATE POLICY phase4_dorm_inventory_read ON public.firebase_migration_dorm_inventory
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_dorm_inventory_write ON public.firebase_migration_dorm_inventory
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_dorm_inventory TO authenticated;

CREATE POLICY phase4_buses_read ON public.firebase_migration_buses
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_buses_write ON public.firebase_migration_buses
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_buses TO authenticated;

CREATE POLICY phase4_routes_read ON public.firebase_migration_routes
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_routes_write ON public.firebase_migration_routes
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_routes TO authenticated;

CREATE POLICY phase4_route_days_read ON public.firebase_migration_route_days
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_routes AS route
    WHERE route.source_project = firebase_migration_route_days.source_project
      AND route.firestore_id = firebase_migration_route_days.route_firestore_id
      AND firebase_migration_private.has_school_access(route.source_project, route.school_id, NULL)
  ));
CREATE POLICY phase4_route_days_write ON public.firebase_migration_route_days
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_routes AS route
    WHERE route.source_project = firebase_migration_route_days.source_project
      AND route.firestore_id = firebase_migration_route_days.route_firestore_id
      AND firebase_migration_private.has_school_access(
        route.source_project, route.school_id,
        ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_routes AS route
    WHERE route.source_project = firebase_migration_route_days.source_project
      AND route.firestore_id = firebase_migration_route_days.route_firestore_id
      AND firebase_migration_private.has_school_access(
        route.source_project, route.school_id,
        ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
      )
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_route_days TO authenticated;

CREATE POLICY phase4_drivers_read ON public.firebase_migration_drivers
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_drivers_write ON public.firebase_migration_drivers
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_drivers TO authenticated;

CREATE POLICY phase4_fuel_records_read ON public.firebase_migration_fuel_records
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_fuel_records_write ON public.firebase_migration_fuel_records
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id, ARRAY['admin', 'principal', 'finance', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_fuel_records TO authenticated;

CREATE POLICY phase4_duty_rosters_read ON public.firebase_migration_duty_rosters
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_duty_rosters_insert ON public.firebase_migration_duty_rosters
  FOR INSERT TO authenticated
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
  ));
CREATE POLICY phase4_duty_rosters_update ON public.firebase_migration_duty_rosters
  FOR UPDATE TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE ON TABLE public.firebase_migration_duty_rosters TO authenticated;

CREATE POLICY phase4_duty_entries_read ON public.firebase_migration_duty_roster_entries
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_duty_rosters AS roster
    WHERE roster.source_project = firebase_migration_duty_roster_entries.source_project
      AND roster.firestore_id = firebase_migration_duty_roster_entries.roster_firestore_id
      AND firebase_migration_private.has_school_access(roster.source_project, roster.school_id, NULL)
  ));
CREATE POLICY phase4_duty_entries_insert ON public.firebase_migration_duty_roster_entries
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_duty_rosters AS roster
    WHERE roster.source_project = firebase_migration_duty_roster_entries.source_project
      AND roster.firestore_id = firebase_migration_duty_roster_entries.roster_firestore_id
      AND firebase_migration_private.has_school_access(
        roster.source_project, roster.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ));
CREATE POLICY phase4_duty_entries_update ON public.firebase_migration_duty_roster_entries
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_duty_rosters AS roster
    WHERE roster.source_project = firebase_migration_duty_roster_entries.source_project
      AND roster.firestore_id = firebase_migration_duty_roster_entries.roster_firestore_id
      AND firebase_migration_private.has_school_access(
        roster.source_project, roster.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_duty_rosters AS roster
    WHERE roster.source_project = firebase_migration_duty_roster_entries.source_project
      AND roster.firestore_id = firebase_migration_duty_roster_entries.roster_firestore_id
      AND firebase_migration_private.has_school_access(
        roster.source_project, roster.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ));
CREATE POLICY phase4_duty_entries_delete ON public.firebase_migration_duty_roster_entries
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_duty_rosters AS roster
    WHERE roster.source_project = firebase_migration_duty_roster_entries.source_project
      AND roster.firestore_id = firebase_migration_duty_roster_entries.roster_firestore_id
      AND firebase_migration_private.has_school_access(
        roster.source_project, roster.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_duty_roster_entries TO authenticated;

CREATE POLICY phase4_timetable_events_read ON public.firebase_migration_timetable_events
  FOR SELECT TO authenticated
  USING (firebase_migration_private.has_school_access(source_project, school_id, NULL));
CREATE POLICY phase4_timetable_events_write ON public.firebase_migration_timetable_events
  FOR ALL TO authenticated
  USING (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
  ))
  WITH CHECK (firebase_migration_private.has_school_access(
    source_project, school_id,
    ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_timetable_events TO authenticated;

CREATE POLICY phase4_event_days_read ON public.firebase_migration_timetable_event_days
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_days.source_project
      AND event.firestore_id = firebase_migration_timetable_event_days.event_firestore_id
      AND firebase_migration_private.has_school_access(event.source_project, event.school_id, NULL)
  ));
CREATE POLICY phase4_event_days_write ON public.firebase_migration_timetable_event_days
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_days.source_project
      AND event.firestore_id = firebase_migration_timetable_event_days.event_firestore_id
      AND firebase_migration_private.has_school_access(
        event.source_project, event.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_days.source_project
      AND event.firestore_id = firebase_migration_timetable_event_days.event_firestore_id
      AND firebase_migration_private.has_school_access(
        event.source_project, event.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_timetable_event_days TO authenticated;

CREATE POLICY phase4_event_periods_read ON public.firebase_migration_timetable_event_periods
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_periods.source_project
      AND event.firestore_id = firebase_migration_timetable_event_periods.event_firestore_id
      AND firebase_migration_private.has_school_access(event.source_project, event.school_id, NULL)
  ));
CREATE POLICY phase4_event_periods_write ON public.firebase_migration_timetable_event_periods
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_periods.source_project
      AND event.firestore_id = firebase_migration_timetable_event_periods.event_firestore_id
      AND firebase_migration_private.has_school_access(
        event.source_project, event.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_periods.source_project
      AND event.firestore_id = firebase_migration_timetable_event_periods.event_firestore_id
      AND firebase_migration_private.has_school_access(
        event.source_project, event.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_timetable_event_periods TO authenticated;

CREATE POLICY phase4_event_classes_read ON public.firebase_migration_timetable_event_classes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_classes.source_project
      AND event.firestore_id = firebase_migration_timetable_event_classes.event_firestore_id
      AND firebase_migration_private.has_school_access(event.source_project, event.school_id, NULL)
  ));
CREATE POLICY phase4_event_classes_write ON public.firebase_migration_timetable_event_classes
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_classes.source_project
      AND event.firestore_id = firebase_migration_timetable_event_classes.event_firestore_id
      AND firebase_migration_private.has_school_access(
        event.source_project, event.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firebase_migration_timetable_events AS event
    WHERE event.source_project = firebase_migration_timetable_event_classes.source_project
      AND event.firestore_id = firebase_migration_timetable_event_classes.event_firestore_id
      AND firebase_migration_private.has_school_access(
        event.source_project, event.school_id,
        ARRAY['admin', 'user', 'school_admin', 'school-admin', 'principal', 'headteacher', 'deputy-headteacher']
      )
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.firebase_migration_timetable_event_classes TO authenticated;

INSERT INTO public.firebase_migration_control (key, value)
VALUES ('phase4_active_app_rls_version', '1');

COMMIT;
