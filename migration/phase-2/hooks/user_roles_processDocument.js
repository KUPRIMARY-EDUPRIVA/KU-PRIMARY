"use strict";

const {
  childId,
  emitArray,
  emitNestedValues,
  emitRow,
  tagSource,
} = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  if (Array.isArray(doc.assignments)) {
    doc.assignments.forEach((assignment, assignmentOrdinal) => {
      const assignmentId = childId(
        "user_role_assignments",
        doc.firestore_id,
        `assignment:${assignmentOrdinal}`,
      );
      emitRow(
        "user_role_assignments",
        doc,
        `assignment:${assignmentOrdinal}`,
        assignmentOrdinal,
        {
          level: assignment?.level ?? null,
          subject: assignment?.subject ?? null,
          raw_assignment: assignment,
        },
        recordCounters,
        writeRecord,
      );
      emitArray(
        "user_role_assignment_classes",
        { ...doc, firestore_id: assignmentId },
        assignment?.classes,
        recordCounters,
        writeRecord,
        (className, classOrdinal) => ({
          user_role_firestore_id: doc.firestore_id,
          assignment_ordinal: assignmentOrdinal,
          class_ordinal: classOrdinal,
          className,
        }),
        "class:",
      );
    });
  }
  for (const [category, values] of Object.entries({
    assigned_class: doc.assignedClasses,
    assigned_subject: doc.assignedSubjects,
    level: doc.levels,
  })) {
    emitArray(
      "user_role_scopes",
      doc,
      values,
      recordCounters,
      writeRecord,
      (value) => ({ category, value }),
      `${category}:`,
    );
  }
  return doc;
};
