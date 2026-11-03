"use strict";

const {
  emitArray,
  emitNestedValues,
  emitObjectEntries,
  tagSource,
} = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  emitArray(
    "school_custom_classes",
    doc,
    doc.customClasses,
    recordCounters,
    writeRecord,
    (customClass) => ({
      classId: customClass?.id ?? null,
      className: customClass?.className ?? null,
      level: customClass?.level ?? null,
      raw_class: customClass,
    }),
  );
  for (const [category, subjects] of Object.entries({
    core: doc.coreSubjects,
    optional: doc.optionalSubjects,
    custom: doc.customSubjects,
  })) {
    emitArray(
      "school_subject_options",
      doc,
      subjects,
      recordCounters,
      writeRecord,
      (subject) => ({ category, subject }),
      `${category}:`,
    );
  }
  emitObjectEntries(
    "school_class_teachers",
    doc,
    doc.classTeachers,
    recordCounters,
    writeRecord,
    (className, assignment) => ({ className, assignment }),
  );
  return doc;
};
