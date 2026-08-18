const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;

function requireRun(run) {
  if (!run || !Array.isArray(run.points) || !Array.isArray(run.sessions)) {
    throw new TypeError("a parsed sauna run is required");
  }
}

function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function worksheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${reference}"><v>${value}</v></c>`;
      }
      const text = value === null || value === undefined ? "" : String(value);
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function joinBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Build a standards-compliant, uncompressed ZIP container for a small XLSX. */
function zipFiles(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, contents] of files) {
    const nameBytes = encoder.encode(name);
    const data = typeof contents === "string" ? encoder.encode(contents) : contents;
    const checksum = crc32(data);
    const local = joinBytes([
      uint32(0x04034b50),
      uint16(ZIP_VERSION),
      uint16(UTF8_FLAG),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes,
      data,
    ]);
    localParts.push(local);
    centralParts.push(joinBytes([
      uint32(0x02014b50),
      uint16(ZIP_VERSION),
      uint16(ZIP_VERSION),
      uint16(UTF8_FLAG),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      nameBytes,
    ]));
    offset += local.length;
  }
  const central = joinBytes(centralParts);
  return joinBytes([
    ...localParts,
    central,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(central.length),
    uint32(offset),
    uint16(0),
  ]);
}

export const MEASUREMENT_HEADERS = Object.freeze([
  "observed_seconds_excluding_unknown_gaps",
  "segment",
  "session_id",
  "session_seconds",
  "unknown_gap_before",
  "P1_temperature_c",
  "P2_temperature_c",
  "P3_temperature_c",
  "P4_temperature_c",
  "P5_temperature_c",
  "P6_temperature_c",
  "P7_temperature_c",
  "P8_temperature_c",
  "logger_temperature_c",
  "status_flags",
]);

export function buildMeasurementRows(run) {
  requireRun(run);
  const unknownBefore = new Set(
    (run.breaks ?? [])
      .filter((gap) => gap.durationSeconds === null)
      .map((gap) => gap.beforeSegment),
  );
  const seenSegments = new Set();
  return run.points.map((point) => {
    const firstInSegment = !seenSegments.has(point.segment);
    seenSegments.add(point.segment);
    return [
      point.observedSeconds,
      point.segment + 1,
      point.sessionId,
      point.relativeSeconds,
      firstInSegment && unknownBefore.has(point.segment) ? "yes" : "",
      ...point.temperaturesC,
      point.chipTemperatureC,
      point.statusFlags,
    ];
  });
}

export function serializeRunCsv(run) {
  const rows = [MEASUREMENT_HEADERS, ...buildMeasurementRows(run)];
  return `\ufeff${rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n")}\r\n`;
}

function probeRows(run) {
  return [
    ["probe", "relative_height_cm", "rom_address"],
    ...run.sensors.map((sensor, index) => [
      `P${index + 1}`,
      sensor.relativeHeightCm,
      sensor.rom,
    ]),
  ];
}

function gapRows(run) {
  return [
    ["after_segment", "before_segment", "continuation_kind", "duration_seconds"],
    ...(run.breaks ?? []).map((gap) => [
      gap.afterSegment + 1,
      gap.beforeSegment + 1,
      gap.continuationKind,
      gap.durationSeconds === null ? "unknown" : gap.durationSeconds,
    ]),
  ];
}

export function createRunWorkbook(run) {
  requireRun(run);
  const measurements = [MEASUREMENT_HEADERS, ...buildMeasurementRows(run)];
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Measurements" sheetId="1" r:id="rId1"/><sheet name="Probes" sheetId="2" r:id="rId2"/><sheet name="Gaps" sheetId="3" r:id="rId3"/></sheets></workbook>`;
  const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`;
  return zipFiles([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRelationships],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", workbookRelationships],
    ["xl/worksheets/sheet1.xml", worksheetXml(measurements)],
    ["xl/worksheets/sheet2.xml", worksheetXml(probeRows(run))],
    ["xl/worksheets/sheet3.xml", worksheetXml(gapRows(run))],
  ]);
}

export function runExportFilename(run, extension) {
  requireRun(run);
  if (!/^[a-z0-9]+$/i.test(extension)) throw new TypeError("invalid export extension");
  const ids = run.sessions.map((session) => session.sessionId).join("-");
  return `sauna-run-${ids}.${extension.toLowerCase()}`;
}
