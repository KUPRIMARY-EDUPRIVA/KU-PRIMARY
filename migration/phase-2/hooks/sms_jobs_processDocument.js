"use strict";

const { emitArray, emitNestedValues, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  emitArray(
    "sms_job_students",
    doc,
    doc.studentIds,
    recordCounters,
    writeRecord,
    (studentId) => ({ studentId }),
  );
  return doc;
};
