"use strict";

const { emitArray, emitNestedValues, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  emitArray(
    "fee_structure_items",
    doc,
    doc.items,
    recordCounters,
    writeRecord,
    (item) => ({
      amount: item?.amount ?? null,
      category: item?.category ?? null,
      description: item?.description ?? null,
      optional: item?.optional ?? null,
      raw_item: item,
    }),
  );
  return doc;
};
