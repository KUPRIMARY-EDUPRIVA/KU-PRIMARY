"use strict";

const SOURCES = new Set(["ku", "kiwanja"]);

function tagSource(doc) {
  const source = process.env.MIGRATION_SOURCE;
  if (!SOURCES.has(source)) {
    throw new Error("MIGRATION_SOURCE must be set to ku or kiwanja");
  }
  if (!doc || typeof doc.firestore_id !== "string" || !doc.firestore_id) {
    throw new Error("Document is missing its original Firestore ID");
  }
  if (doc.source_project && doc.source_project !== source) {
    throw new Error("Document source_project does not match MIGRATION_SOURCE");
  }
  doc.source_project = source;
}

function emitRow(table, parent, key, ordinal, payload, recordCounters, writeRecord) {
  const row = {
    ...payload,
    firestore_id: `${table}|${encodeURIComponent(parent.firestore_id)}|${encodeURIComponent(String(key))}`,
    source_project: parent.source_project,
    schoolId: parent.schoolId ?? null,
    parent_firestore_id: parent.firestore_id,
    ordinal,
  };
  writeRecord(table, row, recordCounters);
}

function childId(table, parentFirestoreId, key) {
  return `${table}|${encodeURIComponent(parentFirestoreId)}|${encodeURIComponent(String(key))}`;
}

function emitArray(table, parent, values, recordCounters, writeRecord, mapRow, keyPrefix = "") {
  if (!Array.isArray(values)) return;
  values.forEach((value, ordinal) => {
    const mapped = mapRow ? mapRow(value, ordinal) : { value };
    emitRow(
      table,
      parent,
      `${keyPrefix}${ordinal}`,
      ordinal,
      mapped,
      recordCounters,
      writeRecord,
    );
  });
}

function emitObjectEntries(table, parent, value, recordCounters, writeRecord, mapRow) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  Object.entries(value).forEach(([key, entry], ordinal) => {
    const mapped = mapRow ? mapRow(key, entry, ordinal) : { map_key: key, map_value: entry };
    emitRow(table, parent, key, ordinal, mapped, recordCounters, writeRecord);
  });
}

function emitNestedValues(collectionName, parent, recordCounters, writeRecord) {
  let ordinal = 0;
  const table = `${collectionName}_nested_values`;

  function visit(value, segments) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        emit(value, segments, "array");
        return;
      }
      value.forEach((item, index) => visit(item, [...segments, index]));
      return;
    }

    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        emit(value, segments, "object");
        return;
      }
      entries.forEach(([key, item]) => visit(item, [...segments, key]));
      return;
    }

    emit(value, segments, value === null ? "null" : typeof value);
  }

  function emit(value, segments, valueType) {
    const position = ordinal++;
    emitRow(
      table,
      parent,
      position,
      position,
      {
        field_path: JSON.stringify(segments),
        value_jsonb: value,
        value_type: valueType,
      },
      recordCounters,
      writeRecord,
    );
  }

  for (const [field, value] of Object.entries(parent)) {
    if (field === "firestore_id" || field === "source_project") continue;
    if (value && typeof value === "object") visit(value, [field]);
  }
}

module.exports = {
  childId,
  emitArray,
  emitNestedValues,
  emitObjectEntries,
  emitRow,
  tagSource,
};
