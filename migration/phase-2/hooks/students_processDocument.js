"use strict";

const { emitArray, emitNestedValues, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  emitArray(
    "student_history_entries",
    doc,
    doc.history,
    recordCounters,
    writeRecord,
    (entry) => ({ raw_entry: entry }),
  );
  return doc;
};
