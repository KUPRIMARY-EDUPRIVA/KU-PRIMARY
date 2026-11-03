"use strict";

const { emitNestedValues, emitObjectEntries, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  emitObjectEntries(
    "student_score_papers",
    doc,
    doc.papers,
    recordCounters,
    writeRecord,
    (learningArea, scoreDetails) => ({ learningArea, score_details: scoreDetails }),
  );
  return doc;
};
