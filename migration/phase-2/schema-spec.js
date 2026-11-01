"use strict";

const PARENT_TABLES = [
  "audit_logs",
  "attendance",
  "exams",
  "fee_audit_log",
  "fee_structures",
  "fee_transactions",
  "level_permissions",
  "mpesa_pending_transactions",
  "paper_configs",
  "school_timetables",
  "schools",
  "sms_jobs",
  "sms_outbox",
  "student_balances",
  "student_scores",
  "students",
  "subject_paper_configs",
  "teachers",
  "timetable_settings",
  "user_roles",
  "users",
];

const CHILD_PARENTS = {
  attendance_counts: "attendance",
  attendance_entries: "attendance",
  attendance_nested_values: "attendance",
  audit_logs_nested_values: "audit_logs",
  exams_nested_values: "exams",
  fee_audit_log_nested_values: "fee_audit_log",
  fee_structure_items: "fee_structures",
  fee_structures_nested_values: "fee_structures",
  fee_transactions_nested_values: "fee_transactions",
  level_permissions_nested_values: "level_permissions",
  mpesa_pending_transactions_nested_values: "mpesa_pending_transactions",
  paper_config_items: "paper_configs",
  paper_configs_nested_values: "paper_configs",
  school_class_teachers: "schools",
  school_custom_classes: "schools",
  school_subject_options: "schools",
  school_timetable_slots: "school_timetables",
  school_timetables_nested_values: "school_timetables",
  schools_nested_values: "schools",
  sms_job_students: "sms_jobs",
  sms_jobs_nested_values: "sms_jobs",
  sms_outbox_nested_values: "sms_outbox",
  student_balances_nested_values: "student_balances",
  student_score_papers: "student_scores",
  student_scores_nested_values: "student_scores",
  students_nested_values: "students",
  subject_paper_config_items: "subject_paper_configs",
  subject_paper_configs_nested_values: "subject_paper_configs",
  teacher_assignment_classes: "teacher_assignments",
  teacher_assignments: "teachers",
  teacher_scopes: "teachers",
  teachers_nested_values: "teachers",
  timetable_setting_periods: "timetable_settings",
  timetable_settings_nested_values: "timetable_settings",
  user_assignment_classes: "user_assignments",
  user_assignments: "users",
  user_role_assignment_classes: "user_role_assignments",
  user_role_assignments: "user_roles",
  user_role_scopes: "user_roles",
  user_roles_nested_values: "user_roles",
  user_scopes: "users",
  users_nested_values: "users",
};

const SCHOOL_MEMBER_CRUD = [
  "attendance",
  "subject_paper_configs",
  "sms_jobs",
  "sms_outbox",
];

const SCHOOL_ADMIN_CRUD = [
  "level_permissions",
  "paper_configs",
  "user_roles",
];

const STUDENT_REFERENCE_TABLES = [
  "attendance_entries",
  "fee_audit_log",
  "fee_transactions",
  "mpesa_pending_transactions",
  "sms_job_students",
  "student_balances",
  "student_scores",
];

const CONTROL_TABLES = [
  "migration_control",
  "user_tenant_memberships",
  "platform_admins",
];

function rootCollection(table) {
  let current = table;
  const visited = new Set();
  while (CHILD_PARENTS[current]) {
    if (visited.has(current)) {
      throw new Error(`Child-table dependency cycle at ${current}`);
    }
    visited.add(current);
    current = CHILD_PARENTS[current];
  }
  return current;
}

module.exports = {
  CHILD_PARENTS,
  CONTROL_TABLES,
  PARENT_TABLES,
  SCHOOL_ADMIN_CRUD,
  SCHOOL_MEMBER_CRUD,
  STUDENT_REFERENCE_TABLES,
  rootCollection,
};
