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
  if (!Array.isArray(doc.assignments)) return doc;
  doc.assignments.forEach((assignment, assignmentOrdinal) => {
    const assignmentId = childId(
      "teacher_assignments",
      doc.firestore_id,
      `assignment:${assignmentOrdinal}`,
    );
    emitRow(
      "teacher_assignments",
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
      "teacher_assignment_classes",
      { ...doc, firestore_id: assignmentId },
      assignment?.classes,
      recordCounters,
      writeRecord,
      (className, classOrdinal) => ({
        teacher_firestore_id: doc.firestore_id,
        assignment_ordinal: assignmentOrdinal,
        class_ordinal: classOrdinal,
        className,
      }),
      "class:",
    );
  });
  for (const [category, values] of Object.entries({
    class: doc.classes,
    level: doc.levels,
    subject: doc.subjects,
  })) {
    emitArray(
      "teacher_scopes",
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
