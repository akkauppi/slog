import { md5Hex, sha256Hex } from "./flashing.js";

const DEVICE_ID_DOMAIN = "sauna_logger:web-flash-device-id:v1\0";
const CANONICAL_MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;

const EXPECTED_IMAGES = [
  { role: "bootloader", address: 0x0, maximumSize: 0x8000 },
  { role: "partition_table", address: 0x8000, exactSize: 0xc00 },
  { role: "ota_data", address: 0xe000, exactSize: 0x2000 },
  { role: "application", address: 0x10000, maximumSize: 0x140000 },
];

function terminalFrom(diagnostic) {
  const write = (value) => {
    try {
      diagnostic?.({ source: "esptool", type: "message", message: String(value) });
    } catch {
      // Diagnostics must never influence loader control flow.
    }
  };
  return {
    clean() {},
    writeLine(value) { write(value); },
    write(value) { write(value); },
  };
}

function adapterError(code, message) {
  const error = new Error(message);
  error.name = "EsptoolAdapterError";
  error.code = code;
  return error;
}

async function deviceIdHash(loader) {
  if (typeof loader.chip?.readMac !== "function") {
    throw adapterError(
      "target-device-identity-unavailable",
      "the ESP32-C3 did not provide a readable device identity",
    );
  }
  const value = await loader.chip.readMac(loader);
  const canonical = typeof value === "string" ? value.toLowerCase() : "";
  if (!CANONICAL_MAC.test(canonical)) {
    throw adapterError(
      "target-device-identity-invalid",
      "the ESP32-C3 returned an invalid device identity",
    );
  }
  return sha256Hex(new TextEncoder().encode(`${DEVICE_ID_DOMAIN}${canonical}`));
}

export function createEsptoolJsAdapter(
  esptoolModule,
  { baudRate = 115200, onDiagnostic = null, logger = null } = {},
) {
  if (typeof esptoolModule?.Transport !== "function" || typeof esptoolModule?.ESPLoader !== "function") {
    throw new TypeError("esptool-js module must export Transport and ESPLoader");
  }
  if (!Number.isInteger(baudRate) || baudRate <= 0) throw new TypeError("baudRate must be a positive integer");
  if (onDiagnostic !== null && typeof onDiagnostic !== "function") throw new TypeError("onDiagnostic must be a function");
  if (logger !== null && typeof logger !== "function") throw new TypeError("logger must be a function");
  const diagnostic = onDiagnostic ?? (logger ? (entry) => logger(entry.message) : null);
  let transport = null;
  let loader = null;
  let targetValidated = false;

  return {
    async connect(port) {
      if (transport || loader) throw new Error("esptool transport is already active");
      targetValidated = false;
      transport = new esptoolModule.Transport(port, false);
      loader = new esptoolModule.ESPLoader({
        transport,
        baudrate: baudRate,
        terminal: terminalFrom(diagnostic),
        debugLogging: false,
      });
      let description;
      try {
        description = await loader.main("default_reset");
      } catch (error) {
        throw error;
      }
      if (loader.chip?.CHIP_NAME !== "ESP32-C3") {
        throw adapterError(
          "target-chip-mismatch",
          "the selected bootloader is not an ESP32-C3",
        );
      }
      if (typeof loader.readFlashId !== "function") {
        throw adapterError(
          "target-flash-size-unavailable",
          "the ESP32-C3 flash did not provide a JEDEC identifier",
        );
      }
      const jedecId = await loader.readFlashId();
      if (!Number.isInteger(jedecId) || jedecId < 0 || jedecId > 0xffffffff) {
        throw adapterError(
          "target-flash-size-unavailable",
          "the ESP32-C3 flash returned an invalid JEDEC identifier",
        );
      }
      const capacityCode = (jedecId >>> 16) & 0xff;
      const flashSize = loader.DETECTED_FLASH_SIZES?.[capacityCode];
      if (flashSize !== "4MB") {
        throw adapterError(
          "target-flash-size-mismatch",
          flashSize
            ? `the selected ESP32-C3 has ${flashSize} flash; exactly 4MB is required`
            : "the selected ESP32-C3 flash size is unknown; exactly 4MB is required",
        );
      }
      const identity = await deviceIdHash(loader);
      targetValidated = true;
      try {
        diagnostic?.({
          source: "esptool",
          type: "device",
          chip: loader.chip?.CHIP_NAME ?? null,
          flashSize,
          deviceIdHash: identity,
        });
      } catch {
        // Diagnostics must never influence target validation.
      }
      return {
        chip: loader.chip?.CHIP_NAME ?? null,
        description,
        flashSize,
        deviceIdHash: identity,
      };
    },

    async write(images, { onProgress = null } = {}) {
      if (!loader || !targetValidated) {
        throw new Error("esptool target validation is incomplete");
      }
      if (!Array.isArray(images) || images.length !== EXPECTED_IMAGES.length) {
        throw new Error("exactly four policy-approved images are required");
      }
      const fileArray = images.map((image, index) => {
        const { role, address, exactSize, maximumSize } = EXPECTED_IMAGES[index];
        if (image?.role !== role || image?.address !== address || !(image.data instanceof Uint8Array) || image.data.length === 0) {
          throw new Error(`invalid ${role} flash image`);
        }
        if (exactSize !== undefined && image.data.length !== exactSize) {
          throw new Error(`${role} flash image has an unsafe size`);
        }
        if (maximumSize !== undefined && image.data.length > maximumSize) {
          throw new Error(`${role} flash image overlaps a preserved flash range`);
        }
        return { data: new Uint8Array(image.data), address };
      });
      await loader.writeFlash({
        fileArray,
        flashMode: "dio",
        flashFreq: "80m",
        flashSize: "4MB",
        compress: true,
        eraseAll: false,
        calculateMD5Hash: md5Hex,
        reportProgress: onProgress ?? undefined,
      });
    },

    async reset() {
      if (!loader) return;
      targetValidated = false;
      await loader.after("hard_reset");
    },

    async close() {
      targetValidated = false;
      if (!transport) {
        loader = null;
        return;
      }
      await transport.disconnect();
      transport = null;
      loader = null;
    },
  };
}

export async function loadPinnedEsptoolJsAdapter(options = {}) {
  const module = await import("../vendor/esptool-js-0.6.0.js");
  return createEsptoolJsAdapter(module, options);
}
