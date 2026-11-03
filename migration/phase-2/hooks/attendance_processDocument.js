"use strict";

const { emitArray, emitNestedValues, emitObjectEntries, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  emitArray(
    "attendance_entries",
    doc,
    doc.entries,
    recordCounters,
    writeRecord,
    (entry) => ({
      admissionNumber: entry?.admissionNumber ?? null,
      name: entry?.name ?? null,
      note: entry?.note ?? null,
      status: entry?.status ?? null,
      studentId: entry?.studentId ?? null,
      raw_entry: entry,
    }),
  );
  emitObjectEntries(
    "attendance_counts",
    doc,
    doc.counts,
    recordCounters,
    writeRecord,
    (status, count) => ({ status, count }),
  );
  return doc;
};
