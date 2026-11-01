"use strict";

const { emitArray, emitNestedValues, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  emitArray(
    "paper_config_items",
    doc,
    doc.papers,
    recordCounters,
    writeRecord,
    (paper) => ({
      name: paper?.name ?? null,
      maxScore: paper?.maxScore ?? null,
      weight: paper?.weight ?? null,
      raw_paper: paper,
    }),
  );
  return doc;
};
