export const ROMS = Object.freeze([
  "2825E1BD00000058",
  "2856BE530000003F",
  "287C38C000000078",
  "28D92E50000000CE",
  "289ABC52000000D1",
  "28CD19520000009B",
  "28939352000000D0",
  "2801F3520000001E",
]);

export function infoLine(overrides = {}) {
  const fields = {
    protocol: "1",
    product: "sauna_logger",
    firmware: "0.3.0-dev",
    commit: "test",
    partition: "sauna_ota_v1",
    ota: "app0",
    configured: "1",
    active_generation: "7",
    restart_required: "0",
    commissioning: "0",
    ...overrides,
  };
  return `SYS_INFO ${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`;
}

export function scanLines(roms = ROMS, { missing = [], overflow = false } = {}) {
  const lines = [
    `CFG_SCAN_BEGIN count=${roms.length} bus_count=${roms.length} overflow=${overflow ? 1 : 0}`,
  ];
  for (const [index, rom] of roms.entries()) {
    const temperature = missing.includes(rom) ? "NA" : (20 + index / 4).toFixed(2);
    lines.push(
      `CFG_SCAN_SENSOR rom=${rom} temperature_c=${temperature} mapped_position=${index + 1}`,
    );
  }
  lines.push(`CFG_SCAN_END count=${roms.length}`);
  return lines;
}

export function configurationLines(roms = ROMS, state = "valid") {
  const geometry = state === "valid" ? "column8_20cm_v1" : "none";
  const generation = state === "valid" ? 7 : 0;
  const lines = [
    `CFG_GET_BEGIN state=${state} generation=${generation} geometry=${geometry} count=${roms.length} valid_slots=${state === "valid" ? 2 : 0} detail=${state === "valid" ? "ready" : state} restart_required=0`,
  ];
  for (const [index, rom] of roms.entries()) {
    lines.push(
      `CFG_MAP position=${index + 1} relative_height_cm=${-20 * index} rom=${rom}`,
    );
  }
  lines.push(`CFG_GET_END count=${roms.length} crc32=${state === "valid" ? "89ABCDEF" : "00000000"}`);
  return lines;
}
