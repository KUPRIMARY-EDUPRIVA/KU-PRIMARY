-- Phase 4: typed empty tables for app contracts verified in reachable routes.
-- No source records are imported and no client permissions are granted.
BEGIN;

DO $active_app_schema_preflight$
DECLARE
  table_name text;
  planned_tables text[] := ARRAY[
    'firebase_migration_assessment_configs',
    'firebase_migration_invoices',
    'firebase_migration_invoice_items',
    'firebase_migration_term_locks',
    'firebase_migration_sms_gateway',
    'firebase_migration_sms_history',
    'firebase_migration_sms_history_outcomes',
    'firebase_migration_sms_templates',
    'firebase_migration_discipline_records',
    'firebase_migration_health_records',
    'firebase_migration_prescriptions',
    'firebase_migration_allergies',
    'firebase_migration_immunizations',
    'firebase_migration_medical_staff',
    'firebase_migration_school_inventory',
    'firebase_migration_student_transfers',
    'firebase_migration_student_transfer_schools',
    'firebase_migration_student_transfer_history',
    'firebase_migration_dormitories',
    'firebase_migration_dorm_assignments',
    'firebase_migration_dorm_patrons',
    'firebase_migration_dorm_maintenance',
    'firebase_migration_dorm_rules',
    'firebase_migration_dorm_inventory',
    'firebase_migration_buses',
    'firebase_migration_routes',
    'firebase_migration_route_days',
    'firebase_migration_drivers',
    'firebase_migration_assignments',
    'firebase_migration_transport_payments',
    'firebase_migration_maintenance',
    'firebase_migration_fuel_records',
    'firebase_migration_duty_rosters',
    'firebase_migration_duty_roster_entries',
    'firebase_migration_timetable_events',
    'firebase_migration_timetable_event_days',
    'firebase_migration_timetable_event_periods',
    'firebase_migration_timetable_event_classes'
  ];
BEGIN
  IF to_regclass('public.firebase_migration_control') IS NULL THEN
    RAISE EXCEPTION 'Phase 2 control relation is required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(planned_tables) AS planned(name)
    JOIN pg_class c ON c.relname = planned.name
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'One or more Phase 4 app relations already exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.firebase_migration_control
    WHERE key = 'phase4_active_app_schema_version'
  ) THEN
    RAISE EXCEPTION 'Phase 4 active app schema version is already recorded';
  END IF;
  FOREACH table_name IN ARRAY planned_tables LOOP
    IF to_regclass(format('public.%I_pkey', table_name)) IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected existing primary-key index for %', table_name;
    END IF;
  END LOOP;
END;
$active_app_schema_preflight$;

CREATE TABLE public.firebase_migration_assessment_configs (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  level text NOT NULL,
  class text NOT NULL,
  subject text NOT NULL,
  assessment_type text NOT NULL,
  term text NOT NULL,
  deadline timestamptz,
  created_by text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_invoices (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  invoice_number text,
  student_id text NOT NULL,
  student_name text,
  student_class text,
  student_level text,
  admission_number text,
  subtotal numeric,
  tax numeric,
  discount numeric,
  total numeric,
  paid_amount numeric,
  remaining_balance numeric,
  term text NOT NULL,
  academic_year text NOT NULL,
  due_date text,
  status text NOT NULL,
  notes text,
  created_by text,
  created_by_name text,
  cancelled_at timestamptz,
  cancelled_by text,
  cancelled_by_name text,
  cancel_reason text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_invoice_items (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  invoice_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  description text NOT NULL DEFAULT '',
  amount numeric NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL,
  PRIMARY KEY (source_project, invoice_firestore_id, ordinal),
  FOREIGN KEY (source_project, invoice_firestore_id)
    REFERENCES public.firebase_migration_invoices (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_term_locks (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  term text NOT NULL,
  year integer NOT NULL,
  locked boolean NOT NULL,
  locked_by text,
  locked_by_name text,
  locked_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_sms_gateway (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  status text,
  api_url text,
  api_key text,
  device_id text,
  default_sender text,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_sms_history (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  created_by text,
  created_by_name text,
  transport text NOT NULL,
  recipient_kind text NOT NULL,
  sim_name text,
  sim_slot integer,
  assessment text,
  template_name text,
  message text NOT NULL,
  recipient_count integer NOT NULL CHECK (recipient_count >= 0),
  submitted integer NOT NULL CHECK (submitted >= 0),
  failed integer NOT NULL CHECK (failed >= 0),
  skipped integer NOT NULL CHECK (skipped >= 0),
  status text NOT NULL,
  created_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_sms_history_outcomes (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  history_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  recipient_id text,
  admission_number text,
  status text NOT NULL,
  error text,
  PRIMARY KEY (source_project, history_firestore_id, ordinal),
  FOREIGN KEY (source_project, history_firestore_id)
    REFERENCES public.firebase_migration_sms_history (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_sms_templates (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  name text,
  category text,
  audience text,
  body text,
  content text,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_discipline_records (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  student_name text,
  admission_number text,
  class_name text,
  level text,
  parent_phone text,
  incident_date text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL,
  summary text NOT NULL,
  action_taken text,
  follow_up_date text,
  status text,
  parent_notified boolean,
  parent_notified_at timestamptz,
  recorded_by text NOT NULL,
  recorded_by_name text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_health_records (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  student_name text,
  student_class text,
  visit_date text,
  visit_type text,
  symptoms text,
  diagnosis text,
  treatment text,
  severity text,
  status text,
  temperature text,
  blood_pressure text,
  weight text,
  height text,
  notes text,
  referred_to text,
  referral_reason text,
  follow_up_date text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_prescriptions (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  record_id text,
  medication text NOT NULL,
  dosage text NOT NULL,
  frequency text NOT NULL,
  route text,
  duration text,
  type text,
  prescribed_by text,
  prescribed_date text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_allergies (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  allergen text NOT NULL,
  type text,
  severity text NOT NULL,
  reaction text,
  diagnosed_date text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_immunizations (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  vaccine text NOT NULL,
  dose text NOT NULL,
  date text NOT NULL,
  next_due_date text,
  administered_by text,
  batch_number text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_medical_staff (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  role text NOT NULL,
  qualification text,
  license_number text,
  status text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_school_inventory (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  name text NOT NULL,
  category text,
  sku text,
  quantity numeric NOT NULL,
  min_quantity numeric NOT NULL,
  unit_price numeric NOT NULL,
  condition text,
  status text,
  location text,
  assigned_to text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_student_transfers (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text,
  admission_number text,
  requested_student_name text,
  releasing_school_id text,
  releasing_school_name text,
  receiving_school_id text,
  receiving_school_name text,
  verified_student_id text,
  verified_student_name text,
  stage text,
  status text,
  reason text,
  notes text,
  initiated_by text,
  initiated_by_user text,
  released_at timestamptz,
  released_by text,
  released_by_user text,
  admitted_at timestamptz,
  admitted_by text,
  admitted_by_user text,
  new_student_id text,
  declined_at timestamptz,
  declined_by text,
  declined_by_user text,
  decline_reason text,
  created_by text,
  created_by_name text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_student_transfer_schools (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  transfer_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  school_id text NOT NULL,
  PRIMARY KEY (source_project, transfer_firestore_id, ordinal),
  FOREIGN KEY (source_project, transfer_firestore_id)
    REFERENCES public.firebase_migration_student_transfers (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_student_transfer_history (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  transfer_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  stage text,
  status text,
  occurred_at timestamptz,
  note text,
  user_id text,
  PRIMARY KEY (source_project, transfer_firestore_id, ordinal),
  FOREIGN KEY (source_project, transfer_firestore_id)
    REFERENCES public.firebase_migration_student_transfers (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_dormitories (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  gender text,
  capacity integer NOT NULL,
  current_occupancy integer,
  status text,
  floor text,
  block text,
  description text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_dorm_assignments (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  student_name text,
  student_class text,
  dorm_id text NOT NULL,
  dorm_name text,
  bed_number text,
  room_number text,
  status text,
  assigned_date text,
  expected_end_date text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_dorm_patrons (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  teacher_id text NOT NULL,
  teacher_name text,
  dorm_id text NOT NULL,
  dorm_name text,
  role text,
  start_date text,
  end_date text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_dorm_maintenance (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  dorm_id text NOT NULL,
  type text NOT NULL,
  description text NOT NULL,
  priority text,
  status text,
  reported_by text,
  reported_date text,
  completed_date text,
  cost numeric,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_dorm_rules (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  dorm_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  priority text,
  category text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_dorm_inventory (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  dorm_id text NOT NULL,
  item_name text NOT NULL,
  quantity integer NOT NULL,
  description text,
  condition text,
  last_checked text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_buses (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  registration_number text NOT NULL,
  model text NOT NULL,
  capacity text,
  status text,
  fuel_type text,
  insurance_expiry text,
  service_due text,
  purchase_date text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_routes (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  name text NOT NULL,
  start_point text NOT NULL,
  end_point text NOT NULL,
  stops text,
  estimated_time text,
  distance text,
  fee text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_route_days (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  route_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  day text NOT NULL,
  PRIMARY KEY (source_project, route_firestore_id, ordinal),
  FOREIGN KEY (source_project, route_firestore_id)
    REFERENCES public.firebase_migration_routes (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_drivers (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  license_number text NOT NULL,
  license_expiry text NOT NULL,
  assigned_bus text,
  status text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_assignments (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  route_id text NOT NULL,
  bus_id text NOT NULL,
  pickup_point text,
  dropoff_point text,
  pickup_time text,
  dropoff_time text,
  status text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_transport_payments (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  student_id text NOT NULL,
  route_id text NOT NULL,
  amount numeric NOT NULL,
  payment_method text,
  payment_date text,
  status text,
  reference text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_maintenance (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  bus_id text NOT NULL,
  type text NOT NULL,
  description text NOT NULL,
  date text,
  cost numeric,
  status text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_fuel_records (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  bus_id text NOT NULL,
  amount numeric NOT NULL,
  cost numeric NOT NULL,
  date text,
  odometer_reading text,
  fuel_type text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_duty_rosters (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  term text NOT NULL,
  year integer NOT NULL,
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_duty_roster_entries (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  roster_firestore_id text NOT NULL,
  day text NOT NULL,
  duty_area_id text NOT NULL,
  duty_area_label text,
  start_hour numeric,
  end_hour numeric,
  teacher_id text,
  teacher_initials text,
  teacher_full_name text,
  PRIMARY KEY (source_project, roster_firestore_id, day, duty_area_id),
  FOREIGN KEY (source_project, roster_firestore_id)
    REFERENCES public.firebase_migration_duty_rosters (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_timetable_events (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  firestore_id text NOT NULL,
  school_id text NOT NULL,
  title text NOT NULL,
  description text,
  location text,
  color text,
  term text NOT NULL,
  year integer NOT NULL,
  level text,
  teacher_name text,
  teacher_initials text,
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (source_project, firestore_id)
);

CREATE TABLE public.firebase_migration_timetable_event_days (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  event_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  day text NOT NULL,
  PRIMARY KEY (source_project, event_firestore_id, ordinal),
  FOREIGN KEY (source_project, event_firestore_id)
    REFERENCES public.firebase_migration_timetable_events (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_timetable_event_periods (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  event_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  period_id text NOT NULL,
  PRIMARY KEY (source_project, event_firestore_id, ordinal),
  FOREIGN KEY (source_project, event_firestore_id)
    REFERENCES public.firebase_migration_timetable_events (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.firebase_migration_timetable_event_classes (
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  event_firestore_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  class text NOT NULL,
  PRIMARY KEY (source_project, event_firestore_id, ordinal),
  FOREIGN KEY (source_project, event_firestore_id)
    REFERENCES public.firebase_migration_timetable_events (source_project, firestore_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

ALTER TABLE public.firebase_migration_assessment_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_term_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_sms_gateway ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_sms_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_sms_history_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_sms_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_discipline_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_health_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_allergies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_immunizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_medical_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_school_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_student_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_student_transfer_schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_student_transfer_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_dormitories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_dorm_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_dorm_patrons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_dorm_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_dorm_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_dorm_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_buses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_route_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_transport_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_fuel_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_duty_rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_duty_roster_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_timetable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_timetable_event_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_timetable_event_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firebase_migration_timetable_event_classes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.firebase_migration_assessment_configs,
  public.firebase_migration_invoices,
  public.firebase_migration_invoice_items,
  public.firebase_migration_term_locks,
  public.firebase_migration_sms_gateway,
  public.firebase_migration_sms_history,
  public.firebase_migration_sms_history_outcomes,
  public.firebase_migration_sms_templates,
  public.firebase_migration_discipline_records,
  public.firebase_migration_health_records,
  public.firebase_migration_prescriptions,
  public.firebase_migration_allergies,
  public.firebase_migration_immunizations,
  public.firebase_migration_medical_staff,
  public.firebase_migration_school_inventory,
  public.firebase_migration_student_transfers,
  public.firebase_migration_student_transfer_schools,
  public.firebase_migration_student_transfer_history,
  public.firebase_migration_dormitories,
  public.firebase_migration_dorm_assignments,
  public.firebase_migration_dorm_patrons,
  public.firebase_migration_dorm_maintenance,
  public.firebase_migration_dorm_rules,
  public.firebase_migration_dorm_inventory,
  public.firebase_migration_buses,
  public.firebase_migration_routes,
  public.firebase_migration_route_days,
  public.firebase_migration_drivers,
  public.firebase_migration_assignments,
  public.firebase_migration_transport_payments,
  public.firebase_migration_maintenance,
  public.firebase_migration_fuel_records,
  public.firebase_migration_duty_rosters,
  public.firebase_migration_duty_roster_entries,
  public.firebase_migration_timetable_events,
  public.firebase_migration_timetable_event_days,
  public.firebase_migration_timetable_event_periods,
  public.firebase_migration_timetable_event_classes
FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.firebase_migration_control (key, value)
VALUES ('phase4_active_app_schema_version', '1');

COMMIT;
