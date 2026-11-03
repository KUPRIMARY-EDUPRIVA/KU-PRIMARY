"use strict";

const { emitNestedValues, emitRow, tagSource } = require("./hook-utils");

module.exports = (collectionName, doc, recordCounters, writeRecord) => {
  tagSource(doc);
  emitNestedValues(collectionName, doc, recordCounters, writeRecord);
  if (doc.periods && typeof doc.periods === "object" && !Array.isArray(doc.periods)) {
    let ordinal = 0;
    for (const [level, periods] of Object.entries(doc.periods)) {
      if (!Array.isArray(periods)) continue;
      periods.forEach((period, levelOrdinal) => {
        emitRow(
          "timetable_setting_periods",
          doc,
          `${level}:${levelOrdinal}`,
          ordinal++,
          { level, level_ordinal: levelOrdinal, period },
          recordCounters,
          writeRecord,
        );
      });
    }
  }
  return doc;
};
