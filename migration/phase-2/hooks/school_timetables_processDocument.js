"use strict";

const { emitNestedValues, emitRow, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  if (doc.schedule && typeof doc.schedule === "object" && !Array.isArray(doc.schedule)) {
    let ordinal = 0;
    for (const [day, periods] of Object.entries(doc.schedule)) {
      if (!periods || typeof periods !== "object" || Array.isArray(periods)) continue;
      for (const [period, slot] of Object.entries(periods)) {
        emitRow(
          "school_timetable_slots",
          doc,
          `${day}:${period}`,
          ordinal++,
          { day, period, slot },
          recordCounters,
          writeRecord,
        );
      }
    }
  }
  return doc;
};
