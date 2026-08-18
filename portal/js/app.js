import {
  DeviceError,
  LEGACY_INCOMPATIBLE_FIRMWARE,
  ProtocolError,
  requireActiveGeneration,
  requireCompatibleDevice,
} from "./protocol.js";
import {
  CommitOutcomeUnknownError,
  CommissioningMethod,
  CommissioningPhase,
  ConnectCommissioningController,
  buildMappingDocument,
  matchPendingMapping,
  serializeMappingDocument,
} from "./commissioning.js";
import {
  CommissioningProtocolClient,
  ProtocolTimeoutError,
  SerialTransportError,
  WebSerialTransport,
  requestSerialPort,
  webSerialSupported,
} from "./serial-transport.js";
import { FlashInstallationUi } from "./flash-ui.js";
import { DiagnosticTranscript } from "./diagnostics.js";
import { DataWorkspace } from "./data-workspace.js";

const PENDING_STORAGE_KEY = "sauna-logger:probe-map:pending:v1";
const VERIFIED_STORAGE_KEY = "sauna-logger:probe-map:verified:v1";
const KEEPALIVE_INTERVAL_MS = 60_000;
const STEP_NAMES = ["connect", "prepare", "identify", "review", "verify"];
const MACRO_STEP_NAMES = ["install", "verify", "commission"];
const PRECOMMIT_PHASES = new Set([
  CommissioningPhase.AWAITING_EMPTY_BUS,
  CommissioningPhase.SCANNING_EMPTY_BUS,
  CommissioningPhase.IDENTIFYING,
  CommissioningPhase.SCANNING_PROBE,
  CommissioningPhase.AWAITING_WARM_BASELINE,
  CommissioningPhase.LEARNING_WARM_BASELINE,
  CommissioningPhase.IDENTIFYING_WARM,
  CommissioningPhase.SCANNING_WARM_PROBE,
  CommissioningPhase.READY_TO_COMMIT,
]);

const element = (id) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing portal element #${id}`);
  return value;
};

const connectionState = element("connection-state");
const disconnectButton = element("disconnect-button");
const environmentMessage = element("environment-message");
const macroProgressList = element("macro-progress-list");
const mobileMacroProgress = element("mobile-macro-progress");
const installTask = element("install-task");
const commissioningWorkflow = element("commissioning-workflow");
const progressList = element("progress-list");
const mobileProgress = element("mobile-progress");
const transactionNotice = element("transaction-notice");
const taskPanel = element("commission-task");
const taskKicker = element("task-kicker");
const taskTitle = element("task-title");
const taskDescription = element("task-description");
const taskMessage = element("task-message");
const deviceSummary = element("device-summary");
const deviceProduct = element("device-product");
const deviceFirmware = element("device-firmware");
const deviceConfiguration = element("device-configuration");
const expectedResult = element("expected-result");
const verificationStages = element("verification-stages");
const primaryAction = element("primary-action");
const secondaryAction = element("secondary-action");
const cancelAction = element("cancel-action");
const privacyNote = element("privacy-note");
const probeTableBody = element("probe-table-body");
const probeCount = element("probe-count");
const detailProtocol = element("detail-protocol");
const detailCommit = element("detail-commit");
const detailOta = element("detail-ota");
const detailGeneration = element("detail-generation");
const detailCrc = element("detail-crc");
const detailUsb = element("detail-usb");
const protocolLog = element("protocol-log");
const diagnosticActionStatus = element("diagnostic-action-status");
const copyTranscriptButton = element("copy-transcript");
const downloadDiagnosticsButton = element("download-diagnostics");
const clearTranscriptButton = element("clear-transcript");
const updateNotice = element("update-notice");
const updateAction = element("update-action");
const writeDialog = element("write-dialog");

let selectedPort = null;
let transport = null;
let client = null;
let controller = null;
let verifiedDocument = null;
let displayedTemperatures = new Map();
let keepaliveTimer = null;
let keepaliveRunning = false;
let reconnectMode = null;
let busy = false;
let expectedDisconnect = false;
let waitingServiceWorker = null;
let reloadForUpdate = false;
let updateReadyToReload = false;
let initialTaskRendered = false;
let flashUi = null;
let installedFirmwareExpectation = null;
let dataWorkspace = null;

const diagnostics = new DiagnosticTranscript({
  list: protocolLog,
  status: diagnosticActionStatus,
  capacity: 300,
  context: () => ({
    portal_url: window.location.href,
    protocol: detailProtocol.textContent,
    source_commit: detailCommit.textContent,
    ota_slot: detailOta.textContent,
    configuration_generation: detailGeneration.textContent,
    configuration_crc: detailCrc.textContent,
    usb_device: detailUsb.textContent,
  }),
});

function positionHeight(position) {
  return -20 * (position - 1);
}

function formatHeight(value) {
  return `${value < 0 ? "−" : ""}${Math.abs(value)} cm`;
}

function positionLocation(position) {
  if (position === 1) return "Top / farthest";
  if (position === 8) return "Bottom / nearest";
  return "Toward logger";
}

function formatRom(rom) {
  return rom ? rom.match(/.{1,4}/g).join(" ") : "—";
}

function formatTemperature(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(1)} °C`
    : "—";
}

function buildProbeTable() {
  const fragment = document.createDocumentFragment();
  for (let position = 1; position <= 8; position += 1) {
    const row = document.createElement("tr");
    row.id = `probe-row-${position}`;

    const probe = document.createElement("th");
    probe.scope = "row";
    probe.textContent = `P${position}`;

    const relative = document.createElement("td");
    const height = document.createElement("span");
    height.className = "probe-height";
    height.textContent = formatHeight(positionHeight(position));
    const location = document.createElement("span");
    location.className = "probe-location";
    location.textContent = positionLocation(position);
    relative.append(height, location);

    const status = document.createElement("td");
    status.id = `probe-status-${position}`;
    status.className = "probe-status";
    status.textContent = "Waiting";

    const temperature = document.createElement("td");
    temperature.id = `probe-temperature-${position}`;
    temperature.className = "probe-temperature";
    temperature.textContent = "—";

    const rom = document.createElement("td");
    rom.id = `probe-rom-${position}`;
    rom.className = "probe-rom";
    rom.textContent = "—";

    row.append(probe, relative, status, temperature, rom);
    fragment.append(row);
  }
  probeTableBody.replaceChildren(fragment);
}

function updateTemperatures(scan) {
  if (!scan?.probes) return;
  for (const probe of scan.probes) {
    displayedTemperatures.set(probe.rom, probe.temperatureC);
  }
}

function renderProbeMap(
  roms = [],
  { currentPosition = null, status = "identified", temperatures = true } = {},
) {
  for (let position = 1; position <= 8; position += 1) {
    const rom = roms[position - 1] ?? null;
    const row = element(`probe-row-${position}`);
    const statusCell = element(`probe-status-${position}`);
    const temperatureCell = element(`probe-temperature-${position}`);
    const romCell = element(`probe-rom-${position}`);

    row.dataset.current = String(position === currentPosition);
    statusCell.dataset.status = rom ? status : "waiting";
    statusCell.textContent = rom
      ? status === "verified"
        ? "Verified"
        : status === "installed"
          ? "Installed"
          : "Identified"
      : position === currentPosition
        ? "Next"
        : "Waiting";
    temperatureCell.textContent =
      rom && temperatures
        ? formatTemperature(displayedTemperatures.get(rom))
        : "—";
    romCell.textContent = formatRom(rom);
  }
  probeCount.textContent = `${roms.length} of 8 ${status === "verified" ? "verified" : "identified"}`;
}

function setMacroStep(name) {
  const index = MACRO_STEP_NAMES.indexOf(name);
  for (const item of macroProgressList.querySelectorAll("li")) {
    const itemIndex = MACRO_STEP_NAMES.indexOf(item.dataset.macroStep);
    if (itemIndex === index) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    item.dataset.complete = String(itemIndex < index);
  }
  mobileMacroProgress.textContent = `Stage ${index + 1} of ${MACRO_STEP_NAMES.length}`;
  installTask.hidden = name !== "install";
  commissioningWorkflow.hidden = name === "install";
}

function setStep(name) {
  const index = STEP_NAMES.indexOf(name);
  for (const item of progressList.querySelectorAll("li")) {
    const itemIndex = STEP_NAMES.indexOf(item.dataset.step);
    if (itemIndex === index) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    item.dataset.complete = String(itemIndex < index || name === "complete");
  }
  const displayedIndex = name === "complete" ? STEP_NAMES.length : index + 1;
  mobileProgress.textContent = `Probe setup · Step ${displayedIndex} of ${STEP_NAMES.length}`;
}

function setMessage(text = "", kind = "info") {
  taskMessage.hidden = true;
  taskMessage.className = "message";
  taskMessage.setAttribute("role", kind === "error" ? "alert" : "status");
  taskMessage.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  if (kind === "error") taskMessage.classList.add("message--error");
  if (kind === "success") taskMessage.classList.add("message--success");
  taskMessage.textContent = text;
  taskMessage.hidden = !text;
}

function setTask({ kicker, title, description, message = "", messageKind = "info" }) {
  taskKicker.textContent = kicker;
  taskTitle.textContent = title;
  taskDescription.textContent = description;
  setMessage(message, messageKind);
  expectedResult.hidden = true;
  expectedResult.textContent = "";
  verificationStages.hidden = true;
  configureAction(primaryAction);
  configureAction(secondaryAction);
  configureAction(cancelAction);
  if (initialTaskRendered) {
    window.requestAnimationFrame(() => taskTitle.focus({ preventScroll: true }));
  }
  initialTaskRendered = true;
}

function setExpected(text) {
  expectedResult.textContent = text;
  expectedResult.hidden = false;
}

function configureAction(
  button,
  { label = "", handler = null, disabled = false, hidden = true } = {},
) {
  button.hidden = hidden;
  if (label) button.textContent = label;
  button.dataset.available = disabled ? "false" : "true";
  button.disabled = busy || disabled;
  button.onclick = handler
    ? (event) => {
        event.preventDefault();
        void runAction(handler);
      }
    : null;
}

function setBusy(value) {
  busy = value;
  taskPanel?.setAttribute("aria-busy", String(value));
  for (const button of [
    primaryAction,
    secondaryAction,
    cancelAction,
    disconnectButton,
  ]) {
    button.disabled = value || button.dataset.available === "false";
  }
  updateAction.disabled =
    value || !waitingServiceWorker || workflowUnsafeToLeave();
}

async function runAction(action) {
  if (busy) return;
  setBusy(true);
  try {
    await action();
  } catch (error) {
    if (isTransportFailure(error)) {
      await transitionAfterTransportFailure(error);
    }
    const message = friendlyError(error);
    setMessage(message, "error");
    logActivity(`Error · ${message}`);
  } finally {
    setBusy(false);
  }
}

function isTransportFailure(error) {
  let current = error;
  const visited = new Set();
  while (current && !visited.has(current)) {
    if (
      current instanceof SerialTransportError ||
      current instanceof ProtocolTimeoutError
    ) {
      return true;
    }
    visited.add(current);
    current = current.cause;
  }
  return false;
}

function friendlyError(error, position = controller?.snapshot.nextPosition) {
  if (error?.name === "NotFoundError") return "No logger was selected.";
  if (error?.name === "SecurityError") {
    return "The browser refused access to the serial port. Use the Choose logger button from this top-level page.";
  }
  if (error instanceof DeviceError) {
    const messages = {
      active_session:
        "A sauna recording is active. Probe setup cannot begin until the recording ends.",
      commissioning_required:
        "Start a probe-setup transaction before requesting a fresh bus scan.",
      probe_set_mismatch:
        "The connected probes changed before writing. No map was written. Restore the same eight probes and scan again.",
      write_failed:
        "The write result is uncertain. Restart the logger so it can select the last complete map.",
      readback_failed:
        "The write result is uncertain. Restart the logger so it can select the last complete map.",
      restart_required:
        "The logger must be restarted and inspected before another setup can begin.",
      not_staging:
        "Probe setup expired on the logger. Clear the setup lock before starting again.",
    };
    return messages[error.code] ?? `The logger refused ${error.command}: ${error.code}.`;
  }
  const code = error?.code;
  if (code === "bus-not-empty") {
    return "Probes are still present. Disconnect every probe from D2, then check the bus again.";
  }
  if (code === "scan-overflow") {
    return "More than eight 1-Wire devices are connected. Disconnect extras before continuing.";
  }
  if (code === "missing-temperature") {
    return "A probe was found but did not return a valid temperature. Check its powered three-wire connection.";
  }
  if (code === "unstable-warm-baseline") {
    return "One or more probes are still changing temperature. Stop touching every metal tip, let all eight probes settle, then learn the baseline again.";
  }
  if (code === "probe-set-mismatch") {
    return "The connected probe set does not match the proposed map. Restore all eight connections before continuing.";
  }
  if (code === "mapped-position-mismatch") {
    return "The active probe positions do not match the map that was just written.";
  }
  if (/expected exactly one new probe, found 0/i.test(error?.message ?? "")) {
    return "No new probe found. Check 3V3, GND, and D2, then scan again.";
  }
  if (/expected exactly one new probe/i.test(error?.message ?? "")) {
    const accepted = Math.max(0, (position ?? 1) - 1);
    const prefix = accepted
      ? `Leave P1–P${accepted} connected, `
      : "Leave the bus empty, ";
    return `More than one new probe appeared. ${prefix}disconnect the newly added probes, then connect only P${position ?? "the next probe"}.`;
  }
  if (/disappeared/i.test(error?.message ?? "")) {
    return "A previously identified probe is missing. Reconnect it before scanning again.";
  }
  if (error instanceof SerialTransportError) {
    return "The logger disconnected. Reconnect it before continuing.";
  }
  if (error instanceof ProtocolError) {
    return `The logger returned an invalid response: ${error.message}`;
  }
  return error?.message ? String(error.message) : "An unexpected setup error occurred.";
}

function setConnection(
  connected,
  text = connected ? "Logger connected" : "Not connected",
  disconnectable = connected,
) {
  connectionState.dataset.connected = String(connected);
  connectionState.lastChild.textContent = ` ${text}`;
  disconnectButton.hidden = !connected || !disconnectable;
  disconnectButton.dataset.available = connected && disconnectable ? "true" : "false";
  disconnectButton.disabled = busy || !connected || !disconnectable;
}

function updateDeviceDetails(info, configuration = null) {
  if (!info) {
    deviceSummary.hidden = true;
    return;
  }
  deviceSummary.hidden = false;
  deviceProduct.textContent = info.product;
  deviceFirmware.textContent = info.firmware;
  deviceConfiguration.textContent = configuration
    ? configuration.state === "valid"
      ? `Generation ${configuration.generation}`
      : configuration.detail ?? configuration.state
    : info.configured
      ? `Generation ${info.activeGeneration}`
      : "Not configured";
  detailProtocol.textContent = String(info.protocol);
  detailCommit.textContent = info.commit;
  detailOta.textContent = info.ota;
  detailGeneration.textContent = String(
    configuration?.generation || info.activeGeneration || "—",
  );
  detailCrc.textContent =
    configuration?.state === "valid" ? configuration.crc32 : "—";
}

function formatUsbDevice(port) {
  const info = port?.getInfo?.() ?? {};
  const hexadecimal = (value) =>
    Number.isInteger(value)
      ? value.toString(16).toUpperCase().padStart(4, "0")
      : "????";
  if (!Number.isInteger(info.usbVendorId) && !Number.isInteger(info.usbProductId)) {
    return "Authorized serial port";
  }
  return `${hexadecimal(info.usbVendorId)}:${hexadecimal(info.usbProductId)}`;
}

function logActivity(text) {
  diagnostics.record({ source: "portal", direction: "event", line: text });
}

function storageRead(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function storageWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    setMessage(
      "This browser could not preserve local progress. Keep this tab open until setup finishes.",
      "error",
    );
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Local progress is a convenience; device validation remains authoritative.
  }
}

function savePending(extra = {}) {
  if (!controller) return;
  storageWrite(PENDING_STORAGE_KEY, {
    ...controller.exportDraft(),
    commissioning_method: controller.snapshot.method,
    portal_phase: controller.snapshot.phase,
    updated_at: new Date().toISOString(),
    ...extra,
  });
}

function updateTransactionUi() {
  const open = Boolean(controller?.snapshot.transactionOpen);
  transactionNotice.hidden = !open;
  updateAction.disabled = busy || !waitingServiceWorker || workflowUnsafeToLeave();
}

function setupWorkflowUnsafeToLeave() {
  if (flashUi?.unsafeToUnload) return true;
  const snapshot = controller?.snapshot;
  if (!snapshot) return false;
  if (snapshot.transactionOpen) return true;
  if (
    [
      CommissioningPhase.COMMITTING,
      CommissioningPhase.STARTING,
      CommissioningPhase.READY_TO_REBOOT,
      CommissioningPhase.REBOOTING,
      CommissioningPhase.AWAITING_RECONNECT,
      CommissioningPhase.VERIFYING,
    ].includes(snapshot.phase)
  ) {
    return true;
  }
  return (
    snapshot.phase === CommissioningPhase.RECOVERY_REQUIRED &&
    snapshot.commitMayHaveReachedDevice
  );
}

function workflowUnsafeToLeave() {
  return setupWorkflowUnsafeToLeave() || Boolean(dataWorkspace?.unsafeToLeave);
}

function showConnect({ afterInstall = false } = {}) {
  stopKeepalive();
  setMacroStep("verify");
  setStep("connect");
  setTask({
    kicker: "Stage 2 · Verify logger",
    title: afterInstall ? "Reconnect the running logger" : "Verify the running logger",
    description: afterInstall
      ? "The installer pulsed reset and closed the bootloader connection. Release BOOT, wait for the application port, then choose it. If it stays silent, press RESET once without holding BOOT; if necessary, remove all USB and external power before reconnecting."
      : "Choose the logger running the project firmware. Close PlatformIO, a serial monitor, or any other application using the port.",
  });
  configureAction(primaryAction, {
    label: "Choose logger",
    handler: chooseInitialLogger,
    hidden: false,
    disabled: !portalEnvironmentSupported(),
  });
  privacyNote.hidden = false;
  updateDeviceDetails(null);
  renderProbeMap();
  updateTransactionUi();
}

function portalEnvironmentSupported() {
  let topLevel = false;
  try {
    topLevel = window.top === window.self;
  } catch {
    topLevel = false;
  }
  return (
    window.isSecureContext &&
    topLevel &&
    ["https:", "http:"].includes(window.location.protocol) &&
    webSerialSupported()
  );
}

function explainEnvironment() {
  if (portalEnvironmentSupported()) {
    environmentMessage.hidden = true;
    return;
  }
  environmentMessage.hidden = false;
  environmentMessage.className = "message message--error";
  if (!window.isSecureContext || !["https:", "http:"].includes(location.protocol)) {
    environmentMessage.textContent =
      "USB connection needs the HTTPS portal or a localhost server; it cannot run from a file opened directly.";
  } else if (!webSerialSupported()) {
    environmentMessage.textContent =
      "USB connection is not available in this browser. Use a current desktop browser that exposes Web Serial, such as Chrome, Chromium, Edge, Brave, or Firefox 151 and newer.";
  } else {
    environmentMessage.textContent =
      "USB setup must run as a top-level page, not inside an embedded frame.";
  }
}

async function attachPort(port) {
  await closeTransport();
  selectedPort = port;
  transport = new WebSerialTransport(port, {
    onTraffic: (entry) => diagnostics.serialTraffic(entry),
  });
  await transport.open();
  client = new CommissioningProtocolClient(transport);
  setConnection(true);
  detailUsb.textContent = formatUsbDevice(port);
  logActivity(`Opened USB serial ${formatUsbDevice(port)}`);
}

async function closeTransport() {
  if (!transport) return;
  try {
    await transport.close();
  } finally {
    transport = null;
    client = null;
    setConnection(false);
    dataWorkspace?.handleConnectionClosed();
  }
}

async function discardNewRecordsTransport() {
  try {
    await closeTransport();
  } catch (error) {
    logActivity(`Could not close rejected records port cleanly · ${error.message}`);
  } finally {
    selectedPort = null;
    controller = null;
  }
}

async function connectRecordsLogger() {
  let openedForRecords = false;
  if (!transport?.isOpen) {
    const port = await requestSerialPort();
    openedForRecords = true;
    try {
      await attachPort(port);
      controller = null;
    } catch (error) {
      await discardNewRecordsTransport();
      throw error;
    }
  }
  try {
    const recordsClient = new CommissioningProtocolClient(transport);
    const info = requireCompatibleDevice(await recordsClient.info());
    updateDeviceDetails(info);
    return { transport, info };
  } catch (error) {
    if (openedForRecords) {
      await discardNewRecordsTransport();
    }
    throw error;
  }
}

async function disconnectRecordsLogger() {
  await closeTransport();
  controller = null;
  selectedPort = null;
  if (dataWorkspace?.activeView === "prepare") showConnect();
}

async function chooseInitialLogger() {
  const port = await requestSerialPort();
  await attachPort(port);
  setTask({
    kicker: "Step 1 · Connect",
    title: "Checking logger",
    description: "Reading the device identity and current probe configuration.",
  });
  controller = new ConnectCommissioningController(client);
  let verifiedExpectation = null;
  try {
    await controller.inspect();
    verifyInstalledFirmware(controller.snapshot.deviceInfo);
    if (installedFirmwareExpectation) {
      await flashUi.completeRunningFirmwareVerification(
        runningFirmwareIdentity(controller.snapshot.deviceInfo),
      );
      verifiedExpectation = installedFirmwareExpectation;
    }
  } catch (error) {
    await closeTransport();
    if (
      installedFirmwareExpectation &&
      error instanceof ProtocolError &&
      error.code === LEGACY_INCOMPATIBLE_FIRMWARE
    ) {
      try {
        await flashUi.prepareCurrentFirmwareReplacement();
        installedFirmwareExpectation = null;
        logActivity(
          "Running firmware is incompatible · prepared current firmware for the same logger",
        );
        return;
      } catch (replacementError) {
        showConnect({ afterInstall: true });
        throw replacementError;
      }
    }
    showConnect({ afterInstall: Boolean(installedFirmwareExpectation) });
    throw error;
  }
  if (verifiedExpectation) {
    logActivity(
      `Verified installed firmware ${verifiedExpectation.firmware} (${verifiedExpectation.commit})`,
    );
    installedFirmwareExpectation = null;
  }
  logActivity("Validated SYS INFO and read CFG GET");
  showInspection();
}

function verifyInstalledFirmware(info) {
  const expected = installedFirmwareExpectation;
  if (!expected) return;
  const checks = [
    ["product", info.product, expected.product],
    ["firmware version", info.firmware, expected.firmware],
    ["source commit", info.commit, expected.commit],
    ["partition layout", info.partition, expected.partition],
    ["OTA slot", info.ota, expected.ota],
  ];
  for (const [label, actual, wanted] of checks) {
    if (actual !== wanted) {
      throw new ProtocolError(
        `running ${label} ${JSON.stringify(actual)} does not match installed ${JSON.stringify(wanted)}`,
      );
    }
  }
}

function runningFirmwareIdentity(info) {
  return {
    product: info.product,
    firmware: info.firmware,
    commit: info.commit,
    partition: info.partition,
    ota: info.ota,
  };
}

function showInspection(message = "") {
  setMacroStep("commission");
  reconnectMode = null;
  expectedDisconnect = false;
  const snapshot = controller.snapshot;
  const info = snapshot.deviceInfo;
  const configuration = snapshot.existingConfiguration;
  updateDeviceDetails(info, configuration);
  updateTransactionUi();
  privacyNote.hidden = true;

  if (configuration?.state === "valid") {
    renderProbeMap(
      configuration.probes.map((probe) => probe.rom),
      { status: "installed", temperatures: false },
    );
  } else {
    renderProbeMap();
  }

  if (info.restartRequired) {
    setStep("connect");
    setTask({
      kicker: "Recovery required",
      title: "Restart before changing probes",
      description:
        "A previous write may have reached the logger. Restart it so boot can select the newest complete map before another setup begins.",
      message,
    });
    configureAction(primaryAction, {
      label: "Restart and inspect",
      handler: restartAndInspect,
      hidden: false,
    });
    return;
  }

  if (info.commissioning) {
    setStep("connect");
    setTask({
      kicker: "Incomplete setup",
      title: "Automatic logging is paused",
      description:
        "An earlier setup did not close normally. Clear its staging lock before inspecting or replacing the stored map.",
      message:
        message ||
        "Any positions saved in this browser will remain local, but they must be checked again.",
    });
    configureAction(primaryAction, {
      label: "Clear incomplete setup",
      handler: clearIncompleteSetup,
      hidden: false,
    });
    return;
  }

  const pendingDocument = storageRead(PENDING_STORAGE_KEY);
  const pendingMatch =
    configuration?.state === "valid"
      ? matchPendingMapping(pendingDocument, configuration)
      : null;
  if (pendingMatch) {
    showPendingVerification(pendingMatch);
    return;
  }

  if (configuration?.state === "valid") {
    setStep("connect");
    setTask({
      kicker: "Current configuration",
      title: "Probe map already installed",
      description: `Generation ${configuration.generation} is active. Starting setup pauses automatic logging, but this map remains stored until a new map is verified.`,
      message:
        message ||
        (storageRead(PENDING_STORAGE_KEY)
          ? "Partial setup work exists in this browser. A replacement still begins with a fresh identification transaction."
          : ""),
    });
    configureAction(primaryAction, {
      label: "Replace probe map",
      handler: () => showMethodChoice(true),
      hidden: false,
    });
    configureAction(secondaryAction, {
      label: "Leave unchanged",
      handler: leaveExistingMap,
      hidden: false,
    });
    return;
  }

  const detail = configuration?.detail ?? "unconfigured";
  if (detail === "ambiguous") {
    setTask({
      kicker: "Configuration blocked",
      title: "Conflicting probe maps found",
      description:
        "The logger contains two conflicting valid probe maps. Do not erase it. Preserve the logger and its logs for recovery.",
    });
    return;
  }
  if (detail === "storage_unavailable") {
    setTask({
      kicker: "Configuration blocked",
      title: "Probe storage is unavailable",
      description:
        "Restart the logger once. If this remains, preserve the logger and its logs for service rather than erasing flash.",
    });
    configureAction(primaryAction, {
      label: "Restart and inspect",
      handler: restartAndInspect,
      hidden: false,
    });
    return;
  }

  setStep("connect");
  setTask({
    kicker: "Logger ready",
    title: detail === "corrupt" ? "Replace the damaged probe map" : "No probe map installed",
    description:
      detail === "corrupt"
        ? "The stored probe map is damaged, so session logging is disabled. A new verified map can replace it."
        : "Session logging remains disabled until all eight physical positions have been identified and verified.",
    message,
  });
  configureAction(primaryAction, {
    label: "Choose setup method",
    handler: () => showMethodChoice(false),
    hidden: false,
  });
}

function showPendingVerification(match) {
  setStep("verify");
  setTask({
    kicker: "Setup recovery",
    title: "Finish verifying the saved probe map",
    description:
      `The active generation ${match.generation} has the same complete P1–P8 order saved by this browser. Run one fresh eight-probe bus check before treating it as verified.`,
    message:
      "The saved progress will remain until the active map and every connected probe pass this check.",
  });
  setExpected("Required: exact active order · all eight probes present · mapped positions agree");
  configureAction(primaryAction, {
    label: "Verify saved map",
    handler: finishPendingVerification,
    hidden: false,
  });
  renderProbeMap(match.roms, { status: "installed", temperatures: false });
  updateTransactionUi();
}

async function finishPendingVerification() {
  const pendingDocument = storageRead(PENDING_STORAGE_KEY);
  setMessage(
    "Checking the active order and live bus. Keep USB and all eight probes connected.",
  );
  setVerificationStage(4, 4);
  try {
    const document = await controller.verifyPendingAfterInspect(pendingDocument);
    verifiedDocument = document;
    finishSuccessfulSetup(document);
  } catch (error) {
    if (
      controller.snapshot.phase === CommissioningPhase.RECOVERY_REQUIRED &&
      controller.snapshot.transactionOpen
    ) {
      setTask({
        kicker: "Setup recovery",
        title: "Restart before retrying verification",
        description:
          "The live check opened a temporary setup transaction, but the portal could not prove that it was cleared. Restart and inspect the logger before trying again.",
        message: friendlyError(error),
        messageKind: "error",
      });
      configureAction(primaryAction, {
        label: "Restart and inspect",
        handler: restartAndInspect,
        hidden: false,
      });
      updateTransactionUi();
    }
    throw error;
  }
}

async function clearIncompleteSetup() {
  const result = await client.abort();
  if (result.restartRequired) {
    throw new ProtocolError("the logger still requires a restart after abort");
  }
  logActivity("Cleared abandoned commissioning transaction");
  controller = new ConnectCommissioningController(client);
  await controller.inspect();
  showInspection("The incomplete setup was cleared. Automatic logging may resume with the installed map.");
}

async function leaveExistingMap() {
  const { deviceInfo: info, existingConfiguration: configuration } = controller.snapshot;
  requireActiveGeneration(info, configuration.generation);
  verifiedDocument = buildMappingDocument(
    configuration.probes.map((probe) => probe.rom),
    configuration,
  );
  setTask({
    kicker: "Current configuration",
    title: "Installed map left unchanged",
    description:
      `Generation ${configuration.generation} remains active. This reads the stored order; it does not perform a disruptive live-bus scan.`,
  });
  configureAction(primaryAction, {
    label: "Download installed map",
    handler: downloadVerifiedMap,
    hidden: false,
  });
  logActivity("Left the active probe map unchanged");
}

function showMethodChoice(replaceExisting) {
  setStep("prepare");
  setTask({
    kicker: "Step 2 · Method",
    title: "Identify probes without disconnecting them",
    description:
      "For an assembled logger, keep all eight probes wired and warm their metal tips one at a time. The bench method is only for a loose harness whose probes can be connected without soldering.",
  });
  setExpected("Recommended: assembled probes · no wiring changes");
  configureAction(primaryAction, {
    label: "Identify assembled probes",
    handler: () => startSetup(replaceExisting, CommissioningMethod.WARM),
    hidden: false,
  });
  configureAction(secondaryAction, {
    label: "Bench: connect one at a time",
    handler: () => startSetup(replaceExisting, CommissioningMethod.CONNECT),
    hidden: false,
  });
  configureAction(cancelAction, {
    label: "Back",
    handler: () => showInspection(),
    hidden: false,
  });
  privacyNote.hidden = true;
  updateTransactionUi();
}

async function startSetup(replaceExisting, method) {
  try {
    await controller.start({ replaceExisting, method });
  } catch (error) {
    controller = new ConnectCommissioningController(client);
    try {
      await controller.inspect();
      showInspection();
    } catch {
      // Keep the original BEGIN failure as the actionable diagnosis.
    }
    throw error;
  }
  displayedTemperatures = new Map();
  storageRemove(PENDING_STORAGE_KEY);
  savePending();
  startKeepalive();
  logActivity(
    `Opened ${method} commissioning transaction; automatic logging paused`,
  );
  if (method === CommissioningMethod.WARM) showWarmPrepare();
  else showPrepare();
}

function showPrepare(message = "") {
  setStep("prepare");
  setTask({
    kicker: "Step 2 · Prepare",
    title: "Disconnect all probes",
    description:
      "Disconnect every probe from D2. Leave the logger connected by USB. The empty bus establishes a safe starting point.",
    message,
  });
  setExpected("Expected: 0 probes");
  configureAction(primaryAction, {
    label: "Check bus",
    handler: checkEmptyBus,
    hidden: false,
  });
  configureAction(cancelAction, {
    label: "Cancel setup",
    handler: cancelSetup,
    hidden: false,
  });
  privacyNote.hidden = true;
  renderProbeMap();
  updateTransactionUi();
}

async function checkEmptyBus() {
  await controller.confirmEmptyBus();
  updateTemperatures(controller.snapshot.lastScan);
  savePending();
  logActivity("Confirmed empty 1-Wire bus");
  showIdentify();
}

function showWarmPrepare(message = "") {
  setStep("prepare");
  setTask({
    kicker: "Step 2 · Prepare assembled probes",
    title: "Let all eight probes settle",
    description:
      "Keep every probe connected. Do this before heating the sauna, stop touching the metal tips, and let each probe hold a steady temperature. The probes do not need to read exactly the same.",
    message,
  });
  setExpected("Expected: 8 connected probes · each stable within 0.5 °C");
  configureAction(primaryAction, {
    label: "Learn five-scan baseline",
    handler: learnWarmBaseline,
    hidden: false,
  });
  configureAction(cancelAction, {
    label: "Cancel setup",
    handler: cancelSetup,
    hidden: false,
  });
  privacyNote.hidden = true;
  renderProbeMap();
  updateTransactionUi();
}

async function learnWarmBaseline() {
  await controller.captureWarmBaseline();
  updateTemperatures(controller.snapshot.lastScan);
  savePending();
  logActivity("Learned stable five-scan baseline for eight assembled probes");
  showWarmIdentify();
}

function warmCandidateMessage(result) {
  if (!result) return "";
  if (result.accepted) {
    return `P${result.position} identified · ${formatRom(result.accepted.rom)} · ${formatTemperature(result.accepted.temperatureC)} · rise ${result.accepted.riseC.toFixed(1)} °C`;
  }
  const candidate = result.candidates?.at(-1);
  if (!candidate) {
    return `P${result.position} was not identified. Keep warming only that tip, then check again.`;
  }
  return `Not clear yet · strongest rise ${candidate.riseC.toFixed(1)} °C · lead ${candidate.marginC.toFixed(1)} °C. Keep warming only P${result.position}, then check again.`;
}

function showWarmIdentify(lastResult = null) {
  const snapshot = controller.snapshot;
  const position = snapshot.nextPosition;
  const height = formatHeight(positionHeight(position));
  const location =
    position === 1
      ? "Top / farthest from the logger"
      : position === 8
        ? "Bottom / nearest the logger"
        : "Next position toward the logger";
  setStep("identify");
  setTask({
    kicker: `Step 3 · Identify assembled probes · ${snapshot.mappedRoms.length} of 8`,
    title: `Warm the metal tip of P${position}`,
    description:
      `${location} · ${height}. Keep every wire connected. Warm only this tip by hand or with a warm, not hot, cloth; then check it. Previously identified probes may remain warm.`,
    message: warmCandidateMessage(lastResult),
    messageKind: lastResult?.accepted ? "success" : "info",
  });
  setExpected("Required twice: rise ≥ 3.0 °C · clear lead ≥ 1.0 °C");
  configureAction(primaryAction, {
    label: `Check warmed P${position}`,
    handler: identifyNextWarm,
    hidden: false,
  });
  configureAction(cancelAction, {
    label: "Cancel setup",
    handler: cancelSetup,
    hidden: false,
  });
  renderProbeMap(snapshot.mappedRoms, {
    currentPosition: position,
    status: "identified",
  });
  updateTransactionUi();
}

async function identifyNextWarm() {
  const result = await controller.identifyNextWarmedProbe();
  updateTemperatures(controller.snapshot.lastScan);
  savePending();
  if (!result.accepted) {
    logActivity(`Warm check for P${result.position} was inconclusive`);
    showWarmIdentify(result);
    return;
  }
  logActivity(`Identified warmed P${result.position} as ${result.accepted.rom}`);
  const accepted = { position: result.position, ...result.accepted };
  if (controller.snapshot.phase === CommissioningPhase.READY_TO_COMMIT) {
    showReview(accepted);
  } else {
    showWarmIdentify(result);
  }
}

function showIdentify(accepted = null) {
  const snapshot = controller.snapshot;
  const position = snapshot.nextPosition;
  const height = formatHeight(positionHeight(position));
  const location =
    position === 1
      ? "Top / farthest from the logger"
      : position === 8
        ? "Bottom / nearest the logger"
        : "Next position toward the logger";
  setStep("identify");
  setTask({
    kicker: `Step 3 · Identify · ${snapshot.mappedRoms.length} of 8`,
    title: `Connect P${position}`,
    description: `${location} · ${height}. Leave every accepted probe connected. Connect only P${position}, then scan.`,
    message: accepted
      ? `P${accepted.position} identified · ${formatRom(accepted.rom)} · ${formatTemperature(accepted.temperatureC)}`
      : "",
    messageKind: accepted ? "success" : "info",
  });
  setExpected(`Expected: ${position} connected probe${position === 1 ? "" : "s"}`);
  configureAction(primaryAction, {
    label: `Scan for P${position}`,
    handler: identifyNext,
    hidden: false,
  });
  configureAction(cancelAction, {
    label: "Cancel setup",
    handler: cancelSetup,
    hidden: false,
  });
  renderProbeMap(snapshot.mappedRoms, {
    currentPosition: position,
    status: "identified",
  });
  updateTransactionUi();
}

async function identifyNext() {
  const result = await controller.identifyNextProbe();
  updateTemperatures(controller.snapshot.lastScan);
  savePending();
  logActivity(`Identified P${result.position} as ${result.rom}`);
  if (controller.snapshot.phase === CommissioningPhase.READY_TO_COMMIT) {
    showReview(result);
  } else {
    showIdentify(result);
  }
}

function showReview(lastAccepted = null) {
  const roms = controller.snapshot.mappedRoms;
  setStep("review");
  setTask({
    kicker: "Step 4 · Review",
    title: "Review probe order",
    description:
      "P1 must be the top probe farthest from the logger. Positions descend in 20 cm steps toward P8. The complete bus will be checked again before writing.",
    message: lastAccepted
      ? `P${lastAccepted.position} identified · ${formatRom(lastAccepted.rom)} · ${formatTemperature(lastAccepted.temperatureC)}`
      : "Eight positions are ready for review.",
    messageKind: "success",
  });
  configureAction(primaryAction, {
    label: "Write map and restart",
    handler: () => {
      writeDialog.returnValue = "";
      writeDialog.showModal();
    },
    hidden: false,
  });
  configureAction(secondaryAction, {
    label: "Start identification again",
    handler: restartIdentification,
    hidden: false,
  });
  configureAction(cancelAction, {
    label: "Cancel setup",
    handler: cancelSetup,
    hidden: false,
  });
  renderProbeMap(roms, { status: "identified" });
  updateTransactionUi();
}

async function restartIdentification() {
  const method = controller.snapshot.method;
  await controller.abort();
  stopKeepalive();
  controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start({
    replaceExisting: controller.snapshot.existingConfiguration?.state === "valid",
    method,
  });
  displayedTemperatures = new Map();
  savePending();
  startKeepalive();
  logActivity(`Restarted ${method} position identification`);
  if (method === CommissioningMethod.WARM) showWarmPrepare();
  else showPrepare();
}

async function cancelSetup() {
  await controller.abort();
  stopKeepalive();
  storageRemove(PENDING_STORAGE_KEY);
  logActivity("Cancelled setup; logger acknowledged the abort");
  controller = new ConnectCommissioningController(client);
  await controller.inspect();
  showInspection("Setup was cancelled. Automatic logging may resume with the previously installed map.");
}

function setVerificationStage(completed, active = null) {
  verificationStages.hidden = false;
  [...verificationStages.children].forEach((item, index) => {
    let status = "pending";
    if (index < completed) {
      item.dataset.status = "complete";
      status = "complete";
    } else if (index === active) {
      item.dataset.status = "active";
      status = "in progress";
    } else {
      delete item.dataset.status;
    }
    item.setAttribute("aria-label", `${item.textContent}: ${status}`);
  });
}

function showWriting() {
  setStep("verify");
  setTask({
    kicker: "Step 5 · Write and verify",
    title: "Writing probe map",
    description:
      "Keep USB connected. If power is interrupted, reconnect and this page will inspect the stored result.",
  });
  setVerificationStage(0, 0);
  renderProbeMap(controller.snapshot.mappedRoms, { status: "identified" });
  updateTransactionUi();
}

async function performCommit() {
  stopKeepalive();
  showWriting();
  try {
    const configuration = await controller.commit();
    updateDeviceDetails(controller.snapshot.deviceInfo, configuration);
    savePending({
      commit_generation: configuration.generation,
      commit_crc32: configuration.crc32,
    });
    setVerificationStage(3, 3);
    logActivity(
      `Read back generation ${configuration.generation}, CRC ${configuration.crc32}`,
    );

    try {
      expectedDisconnect = true;
      await controller.reboot();
      logActivity("Logger acknowledged restart");
    } catch (error) {
      logActivity(`Restart acknowledgement uncertain · ${error.message}`);
    } finally {
      await closeTransport();
    }
    reconnectMode = "verify-known";
    showAwaitingReconnect();
  } catch (error) {
    if (error instanceof CommitOutcomeUnknownError) {
      savePending({ commit_outcome: "unknown" });
      logActivity("Commit result is unknown; blind retry disabled");
      await closeTransport();
      reconnectMode = "recover-unknown";
      showAwaitingReconnect(
        "Connection was lost while writing. Reconnect so the portal can inspect the stored result; do not start a new setup.",
      );
      return;
    }
    if (controller.snapshot.phase === CommissioningPhase.READY_TO_COMMIT) {
      startKeepalive();
      showReview();
      throw error;
    }
    if (
      controller.snapshot.phase === CommissioningPhase.FAILED &&
      !controller.snapshot.transactionOpen
    ) {
      const explanation = friendlyError(error);
      controller = new ConnectCommissioningController(client);
      await controller.inspect();
      showInspection();
      setMessage(
        `${explanation} The logger acknowledged cancellation, so no new map was activated.`,
        "error",
      );
      return;
    }
    if (
      controller.snapshot.phase === CommissioningPhase.RECOVERY_REQUIRED &&
      !controller.snapshot.commitMayHaveReachedDevice
    ) {
      setTask({
        kicker: "Setup recovery",
        title: "Clear the interrupted setup",
        description:
          "The map write did not begin, but the portal could not prove that the staging lock was cleared. Keep the logger connected and retry the safe abort.",
        message: friendlyError(error),
        messageKind: "error",
      });
      configureAction(primaryAction, {
        label: "Clear setup lock",
        handler: cancelSetup,
        hidden: false,
      });
      updateTransactionUi();
      return;
    }
    stopKeepalive();
    updateTransactionUi();
    throw error;
  }
}

function showAwaitingReconnect(message = "") {
  setConnection(false);
  setStep("verify");
  setTask({
    kicker: "Step 5 · Reconnect",
    title: "Reconnect the logger",
    description:
      "Keep the USB cable connected while the logger re-enumerates. Try the previously authorized port first, or choose it again if necessary.",
    message,
    messageKind: message ? "error" : "info",
  });
  setVerificationStage(reconnectMode === "verify-known" ? 4 : 3, 4);
  configureAction(primaryAction, {
    label: "Reconnect logger",
    handler: reconnectSamePort,
    hidden: false,
    disabled: !selectedPort,
  });
  configureAction(secondaryAction, {
    label: "Choose port again",
    handler: reconnectChosenPort,
    hidden: false,
  });
  transactionNotice.hidden = true;
  updateTransactionUi();
}

async function reconnectSamePort() {
  if (!selectedPort) throw new SerialTransportError("no previously authorized port");
  await attachPort(selectedPort);
  await finishReconnect();
}

async function reconnectChosenPort() {
  const port = await requestSerialPort();
  await attachPort(port);
  await finishReconnect();
}

async function finishReconnect() {
  try {
    if (reconnectMode === "recover-precommit") {
      await recoverPrecommit();
      return;
    }
    if (reconnectMode === "verify-known") {
      const document = await controller.verifyAfterReconnect(client);
      verifiedDocument = document;
      finishSuccessfulSetup(document);
      return;
    }
    if (reconnectMode === "recover-unknown") {
      await recoverUnknownCommit();
      return;
    }
    controller = new ConnectCommissioningController(client);
    await controller.inspect();
    showInspection("The logger restarted. Its boot-selected configuration is shown below.");
  } finally {
    if (transport?.isOpen) expectedDisconnect = false;
  }
}

async function recoverUnknownCommit() {
  const intendedRoms = controller.snapshot.mappedRoms;
  let info = requireCompatibleDevice(await client.info());
  const configuration = await client.getConfiguration();
  updateDeviceDetails(info, configuration);

  if (info.restartRequired) {
    expectedDisconnect = true;
    try {
      await client.reboot();
    } catch (error) {
      logActivity(`Restart acknowledgement uncertain · ${error.message}`);
    } finally {
      await closeTransport();
    }
    reconnectMode = "recover-unknown";
    showAwaitingReconnect(
      "The logger found a complete map that still needed activation. It has restarted; reconnect once more to inspect the active result.",
    );
    return;
  }

  if (info.commissioning) {
    const abortResult = await client.abort();
    if (abortResult.restartRequired) {
      throw new ProtocolError("the logger still requires a restart after recovery abort");
    }
    info = requireCompatibleDevice(await client.info());
  }

  const actualRoms =
    configuration.state === "valid"
      ? configuration.probes.map((probe) => probe.rom)
      : [];
  const intendedIsActive =
    actualRoms.length === intendedRoms.length &&
    actualRoms.every((rom, index) => rom === intendedRoms[index]);

  if (!intendedIsActive) {
    if (info.commissioning) await client.abort();
    storageRemove(PENDING_STORAGE_KEY);
    controller = new ConnectCommissioningController(client);
    await controller.inspect();
    showInspection(
      "The previous complete probe map remains active. The attempted replacement was not applied.",
    );
    return;
  }

  const document = await controller.verifyRecoveredAfterReconnect(client);
  verifiedDocument = document;
  finishSuccessfulSetup(document);
}

function finishSuccessfulSetup(document) {
  stopKeepalive();
  storageRemove(PENDING_STORAGE_KEY);
  storageWrite(VERIFIED_STORAGE_KEY, document);
  reconnectMode = null;
  expectedDisconnect = false;
  const generation = document.configuration_generation;
  const roms = document.sensors.map((sensor) => sensor.rom);
  setStep("complete");
  setTask({
    kicker: "Verification complete",
    title: "Probe setup complete",
    description: `Generation ${generation} is active. All eight mapped probes are present, and automatic logging is enabled.`,
    message: "The boot-selected map and live probe bus both match the reviewed order.",
    messageKind: "success",
  });
  setVerificationStage(6);
  configureAction(primaryAction, {
    label: "Download sensor-map.json",
    handler: downloadVerifiedMap,
    hidden: false,
  });
  configureAction(secondaryAction, {
    label: "Set up another logger",
    handler: resetForAnotherLogger,
    hidden: false,
  });
  renderProbeMap(roms, { status: "verified", temperatures: true });
  updateDeviceDetails(controller?.snapshot.deviceInfo, {
    state: "valid",
    generation,
    crc32: document.configuration_crc32,
  });
  updateTransactionUi();
  logActivity(`Verified active generation ${generation} and all eight probes`);
}

function downloadVerifiedMap() {
  if (!verifiedDocument) throw new Error("no verified mapping is available");
  const contents = serializeMappingDocument(verifiedDocument);
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "sensor-map.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  logActivity("Created local sensor-map.json download");
}

async function restartAndInspect() {
  reconnectMode = "inspect";
  expectedDisconnect = true;
  try {
    await client.reboot();
  } catch (error) {
    logActivity(`Restart acknowledgement uncertain · ${error.message}`);
  } finally {
    await closeTransport();
  }
  showAwaitingReconnect();
}

async function resetForAnotherLogger() {
  await closeTransport();
  selectedPort = null;
  controller = null;
  verifiedDocument = null;
  displayedTemperatures = new Map();
  reconnectMode = null;
  expectedDisconnect = false;
  showConnect();
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = window.setInterval(() => void keepaliveTick(), KEEPALIVE_INTERVAL_MS);
  updateTransactionUi();
}

function stopKeepalive() {
  if (keepaliveTimer !== null) window.clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  keepaliveRunning = false;
}

async function keepaliveTick() {
  if (
    keepaliveRunning ||
    !controller ||
    !PRECOMMIT_PHASES.has(controller.snapshot.phase)
  ) {
    return;
  }
  keepaliveRunning = true;
  try {
    await controller.keepalive();
    logActivity("Renewed commissioning lease");
  } catch (error) {
    stopKeepalive();
    setMessage(friendlyError(error), "error");
    configureAction(primaryAction, {
      label: "Clear setup lock",
      handler: cancelSetup,
      hidden: false,
    });
  } finally {
    keepaliveRunning = false;
    updateTransactionUi();
  }
}

async function disconnectLogger() {
  if (controller?.snapshot.commitMayHaveReachedDevice) {
    await closeTransport();
    reconnectMode =
      reconnectMode ||
      (controller.snapshot.committedConfiguration
        ? "verify-known"
        : "recover-unknown");
    showAwaitingReconnect(
      "Verification is not complete. Reconnect and inspect the active result before another setup.",
    );
    return;
  }
  if (controller?.snapshot.transactionOpen) {
    await controller.abort();
    stopKeepalive();
    logActivity("Logger acknowledged setup cancellation before disconnect");
  }
  await closeTransport();
  controller = null;
  selectedPort = null;
  showConnect();
}

function handlePhysicalDisconnect(event) {
  if (
    expectedDisconnect ||
    (reconnectMode && !transport?.isOpen) ||
    !selectedPort
  ) {
    return;
  }
  const eventTarget = event?.target;
  const disconnectedPort =
    event?.port ?? (typeof eventTarget?.open === "function" ? eventTarget : null);
  if (disconnectedPort && disconnectedPort !== selectedPort) return;
  setConnection(false, "Logger disconnected");
  logActivity("USB logger disconnected");
  dataWorkspace?.handleConnectionClosed();
  if (controller?.snapshot.phase === CommissioningPhase.COMPLETE) {
    return;
  }
  if (controller?.snapshot.commitMayHaveReachedDevice) {
    reconnectMode =
      reconnectMode ||
      (controller.snapshot.committedConfiguration
        ? "verify-known"
        : "recover-unknown");
    showAwaitingReconnect(
      "Connection was lost after writing may have begun. Reconnect and inspect the stored result.",
    );
  } else if (controller?.snapshot.transactionOpen) {
    stopKeepalive();
    reconnectMode = "recover-precommit";
    showAwaitingReconnect(
      "Your identified positions remain saved in this browser. Reconnect to clear the interrupted setup safely.",
    );
  } else if (controller) {
    controller = null;
    showConnect();
    setMessage("The logger disconnected. Choose it again when it is available.", "error");
  }
}

async function transitionAfterTransportFailure(error) {
  await closeTransport();
  if (reconnectMode) {
    showAwaitingReconnect(friendlyError(error));
    return;
  }
  if (controller?.snapshot.phase === CommissioningPhase.COMPLETE) return;
  if (controller?.snapshot.commitMayHaveReachedDevice) {
    reconnectMode = "recover-unknown";
    showAwaitingReconnect(
      "Connection was lost after writing may have begun. Reconnect and inspect the stored result.",
    );
    return;
  }
  if (controller?.snapshot.transactionOpen) {
    stopKeepalive();
    reconnectMode = "recover-precommit";
    showAwaitingReconnect(
      "Your identified positions remain saved in this browser. Reconnect to clear the interrupted setup safely.",
    );
    return;
  }
  controller = null;
  showConnect();
}

async function recoverPrecommit() {
  const info = requireCompatibleDevice(await client.info());
  if (info.restartRequired) {
    reconnectMode = "inspect";
    await restartAndInspect();
    return;
  }
  if (info.commissioning) await client.abort();
  controller = new ConnectCommissioningController(client);
  await controller.inspect();
  showInspection(
    "The interrupted staging transaction was cleared. Choose a setup method and start identification again; local partial work was not written to the logger.",
  );
}

function initializeServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register(
        "./service-worker.js",
        { scope: "./" },
      );
      if (registration.waiting) showWaitingUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            showWaitingUpdate(worker);
          }
        });
      });
    } catch (error) {
      logActivity(`Offline cache unavailable · ${error.message}`);
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!reloadForUpdate) return;
    if (!workflowUnsafeToLeave()) {
      window.location.reload();
      return;
    }
    reloadForUpdate = false;
    updateReadyToReload = true;
    setBusy(false);
  });
}

function showWaitingUpdate(worker) {
  waitingServiceWorker = worker;
  updateNotice.hidden = false;
  updateAction.disabled = busy || workflowUnsafeToLeave();
}

function initializeFlashUi() {
  setMacroStep("install");
  flashUi = new FlashInstallationUi({
    environmentSupported: portalEnvironmentSupported,
    onActivity: logActivity,
    onConnection: setConnection,
    onDiagnostic: (entry) => diagnostics.record(entry),
    onReadyForVerification: (expectation) => {
      installedFirmwareExpectation = expectation;
      setConnection(false);
      showConnect({ afterInstall: true });
    },
    onShowInstall: () => setMacroStep("install"),
    onSkip: () => {
      installedFirmwareExpectation = null;
      setConnection(false);
      showConnect();
    },
    onStateChange: () => {
      updateAction.disabled =
        busy || !waitingServiceWorker || workflowUnsafeToLeave();
    },
  });
  flashUi.start();
}

writeDialog.addEventListener("close", () => {
  if (writeDialog.returnValue === "confirm") void runAction(performCommit);
});

disconnectButton.dataset.available = "true";
disconnectButton.addEventListener("click", () => {
  if (dataWorkspace?.activeView === "records") {
    void dataWorkspace.disconnect();
    return;
  }
  void runAction(disconnectLogger);
});

updateAction.addEventListener("click", () => {
  if (workflowUnsafeToLeave()) return;
  if (updateReadyToReload) {
    window.location.reload();
    return;
  }
  if (!waitingServiceWorker) return;
  reloadForUpdate = true;
  setBusy(true);
  waitingServiceWorker.postMessage({ type: "ACTIVATE_UPDATE" });
});

copyTranscriptButton.addEventListener("click", async () => {
  try {
    await diagnostics.copy();
  } catch (error) {
    diagnostics.reportActionError(error);
  }
});

downloadDiagnosticsButton.addEventListener("click", () => {
  try {
    diagnostics.download();
  } catch (error) {
    diagnostics.reportActionError(error);
  }
});

clearTranscriptButton.addEventListener("click", () => diagnostics.clear());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void keepaliveTick();
});

window.addEventListener("beforeunload", (event) => {
  if (!workflowUnsafeToLeave()) return;
  event.preventDefault();
  event.returnValue = "";
});

if (webSerialSupported()) {
  navigator.serial.addEventListener("disconnect", handlePhysicalDisconnect);
}

buildProbeTable();
explainEnvironment();
initializeServiceWorker();
dataWorkspace = new DataWorkspace({
  document,
  window,
  connectLogger: connectRecordsLogger,
  disconnectLogger: disconnectRecordsLogger,
  environmentSupported: portalEnvironmentSupported,
  canNavigate: () => !setupWorkflowUnsafeToLeave(),
  onNavigationBlocked: (message) => {
    if (dataWorkspace?.activeView === "prepare") setMessage(message, "error");
  },
  onUnsafeChange: () => {
    disconnectButton.disabled = busy || Boolean(dataWorkspace?.operation);
    updateAction.disabled =
      busy ||
      Boolean(dataWorkspace?.operation) ||
      !waitingServiceWorker ||
      workflowUnsafeToLeave();
  },
  onActivity: logActivity,
});
logActivity("Portal opened · managed workflows active · manual commands not provided");
initializeFlashUi();
