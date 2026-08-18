import {
  BrowserFlashController,
  FlashPhase,
  FlashRetry,
  FlashWorkflowError,
  prepareFirmwarePackage,
} from "./flashing.js";
import { loadPinnedEsptoolJsAdapter } from "./esptool-adapter.js";
import {
  FirmwareRecoveryStore,
  RecoveryPhase,
  restoreOrRepairRecoveryPackage,
} from "./recovery-store.js";

const MANIFEST_URL = new URL("../generated/firmware/manifest.json", import.meta.url);

function element(id) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing portal element #${id}`);
  return value;
}

function firmwareErrorMessage(error, unsafe) {
  if (error?.name === "NotFoundError") {
    return "No bootloader device was selected. Put the XIAO ESP32-C3 in BOOT mode and choose it when you are ready.";
  }
  if (error?.name === "SecurityError") {
    return "The browser refused serial access. Use this top-level HTTPS or localhost page and try again.";
  }
  const code = String(error?.code ?? "");
  if (["manifest-fetch-failed", "manifest-unavailable", "http-error"].includes(code)) {
    return "This portal build does not contain a generated firmware release. Build or publish the verified package before installing.";
  }
  if (code === "recovery-package-mismatch") {
    return "This portal package does not match the interrupted installation. Recovery remains locked; reopen the same published portal release and do not erase flash.";
  }
  if (code === "recovery-package-missing") {
    return "The exact package required for recovery is not available in this browser cache. Recovery remains locked; do not erase flash or install another package.";
  }
  if (code === "recovery-cache-unavailable") {
    return "The browser could not preserve an exact offline recovery package. Firmware writing stays disabled until site storage is available.";
  }
  if (code === "recovery-lock-held") {
    return "Another portal tab is already protecting a firmware installation or recovery. Finish or close that tab before retrying here.";
  }
  if (["recovery-lock-unavailable", "recovery-lock-required"].includes(code)) {
    return "This browser cannot exclusively protect the firmware recovery lifecycle. Firmware writing stays disabled.";
  }
  if ([
    "recovery-storage-unavailable",
    "recovery-record-invalid",
    "recovery-record-missing",
    "recovery-record-conflict",
  ].includes(code)) {
    return "The browser could not safely persist the mandatory recovery record. Firmware writing stays disabled; allow site storage and reload this page.";
  }
  if (code === "device-mismatch") {
    return "This is not the ESP32-C3 that began the interrupted installation. Recovery remains locked to the original board and package.";
  }
  if (/manifest|schema|version|product|partition/i.test(code)) {
    return "The bundled firmware manifest is invalid or unsupported. Nothing was written.";
  }
  if (/chip|target|esp32/i.test(code)) {
    return "The selected device is not the required ESP32-C3 target with exactly 4 MB of flash. Nothing was written.";
  }
  if (/hash|integrity|digest|size/i.test(code)) {
    return "A bundled firmware image failed its size or SHA-256 integrity check. Nothing was written; use a complete portal release.";
  }
  if (unsafe || /write|flash|disconnect|transport|reset|close/i.test(code)) {
    return "Firmware installation was interrupted. Put the same board back into BOOT mode and recover with the same package. Do not erase flash.";
  }
  if (error instanceof FlashWorkflowError) return error.message;
  return error?.message
    ? String(error.message)
    : "Firmware installation could not continue. Nothing was written.";
}

function packageError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function firmwareExpectation(prepared) {
  const manifest = prepared.manifest;
  return {
    product: manifest.product,
    firmware: manifest.release.version,
    commit: manifest.release.source_commit,
    partition: manifest.target.partition_layout,
    ota: "app0",
  };
}

function expectationMatchesPackage(expectation, prepared) {
  const fromPackage = firmwareExpectation(prepared);
  return Object.keys(fromPackage).every(
    (key) => expectation?.[key] === fromPackage[key],
  );
}

function preparedLoadOptions(prepared) {
  const files = new Map(prepared.files.map((file) => [file.path, file]));
  return {
    manifestUrl: prepared.manifestUrl,
    digest: prepared.digest,
    loadFile: async (_url, requested) => {
      const file = files.get(requested.path);
      if (!file || file.role !== requested.role) {
        const error = new Error(`persisted ${requested.role} image is missing`);
        error.code = "recovery-package-missing";
        throw error;
      }
      return new Uint8Array(file.data);
    },
  };
}

function mayUseOfflinePackage(error) {
  return [
    "manifest-unavailable",
    "manifest-fetch-failed",
    "image-fetch-failed",
    "http-error",
  ].includes(String(error?.code ?? "")) || error instanceof TypeError;
}

async function downloadCurrentFirmwarePackage() {
  if (!globalThis.location || MANIFEST_URL.origin !== globalThis.location.origin) {
    throw packageError(
      "manifest-fetch-failed",
      "firmware manifest is not on the portal origin",
    );
  }
  let response;
  try {
    response = await fetch(MANIFEST_URL, {
      // A mutable manifest is the atomic pointer to immutable package paths.
      // Do not let a sub-second local rebuild reuse a conditional HTTP-cache
      // response with the previous pointer.
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
  } catch (cause) {
    throw packageError("manifest-fetch-failed", "firmware manifest could not be fetched", cause);
  }
  if (!response.ok) {
    throw packageError(
      "manifest-unavailable",
      `firmware manifest returned HTTP ${response.status}`,
    );
  }
  if (
    response.redirected ||
    (response.url && new URL(response.url).origin !== MANIFEST_URL.origin)
  ) {
    throw packageError("manifest-fetch-failed", "firmware manifest redirected away from the portal");
  }
  let manifest;
  try {
    manifest = await response.json();
  } catch (cause) {
    throw packageError("manifest-invalid-json", "firmware manifest is not valid JSON", cause);
  }
  return prepareFirmwarePackage(manifest, {
    manifestUrl: MANIFEST_URL,
    loadFile: async (url) => {
      if (url.origin !== MANIFEST_URL.origin) {
        throw packageError("image-fetch-failed", "firmware image is not on the portal origin");
      }
      let imageResponse;
      try {
        imageResponse = await fetch(url, {
          cache: "no-cache",
          credentials: "same-origin",
          redirect: "error",
        });
      } catch (cause) {
        throw packageError("image-fetch-failed", "firmware image could not be fetched", cause);
      }
      if (!imageResponse.ok) {
        throw packageError(
          "image-fetch-failed",
          `firmware image returned HTTP ${imageResponse.status}`,
        );
      }
      if (
        imageResponse.redirected ||
        (imageResponse.url && new URL(imageResponse.url).origin !== MANIFEST_URL.origin)
      ) {
        throw packageError("image-fetch-failed", "firmware image redirected away from the portal");
      }
      return imageResponse.arrayBuffer();
    },
  });
}

/**
 * Owns only the bootloader/install surface. Probe commissioning remains in
 * app.js and its dedicated controller.
 */
export class FlashInstallationUi {
  constructor({
    environmentSupported,
    onActivity = () => {},
    onConnection = () => {},
    onDiagnostic = () => {},
    onReadyForVerification,
    onShowInstall = () => {},
    onStateChange = () => {},
    onSkip,
    recoveryStore = null,
    lockManager = globalThis.navigator?.locks,
  }) {
    this.environmentSupported = environmentSupported;
    this.onActivity = onActivity;
    this.onConnection = onConnection;
    this.onDiagnostic = onDiagnostic;
    this.onReadyForVerification = onReadyForVerification;
    this.onShowInstall = onShowInstall;
    this.onStateChange = onStateChange;
    this.onSkip = onSkip;

    this.task = element("install-task");
    this.kicker = element("install-kicker");
    this.title = element("install-title");
    this.description = element("install-description");
    this.message = element("install-message");
    this.bootInstructions = element("boot-instructions");
    this.summary = element("firmware-summary");
    this.release = element("install-release");
    this.target = element("install-target");
    this.manifestVersion = element("install-manifest");
    this.hash = element("install-hash");
    this.stages = element("installation-stages");
    this.progressDetail = element("install-progress-detail");
    this.primary = element("install-primary");
    this.secondary = element("install-secondary");
    this.tertiary = element("install-tertiary");
    this.note = element("install-note");
    this.dialog = element("install-dialog");

    this.controller = null;
    this.prepared = null;
    this.persistedPrepared = null;
    this.busy = false;
    this.recoveryStore = null;
    this.recovery = null;
    this.recoveryLoadError = null;
    this.verificationReplacement = null;
    try {
      this.recoveryStore = recoveryStore ?? new FirmwareRecoveryStore({
        baseUrl: MANIFEST_URL,
        lockManager,
      });
      this.recovery = this.recoveryStore.readMarker();
    } catch (error) {
      // If site storage cannot be inspected, the page cannot prove that no
      // interrupted write exists. Keep every skip/write path locked.
      this.recoveryLoadError = error;
    }
    this.firstRender = true;
    this.lastProgressKey = null;

    this.dialog.addEventListener("close", () => {
      if (this.dialog.returnValue === "confirm") void this.#performFlash();
    });
  }

  get unsafeToUnload() {
    return Boolean(
      this.recovery ||
      this.recoveryLoadError ||
      this.controller?.snapshot.unsafeToUnload,
    );
  }

  get active() {
    return !this.task.hidden;
  }

  start() {
    this.#showPreparingPackage();
    void this.#preparePackage();
  }

  async cancelIfAllowed() {
    if (!this.controller?.snapshot.canCancel) return false;
    await this.#cancelBeforeWrite();
    return true;
  }

  async completeRunningFirmwareVerification(expectation) {
    if (!this.recovery || !this.recoveryStore) {
      throw new Error("no mandatory firmware verification is pending");
    }
    await this.recoveryStore.completeVerifiedFirmware({
      packageSha256: this.recovery.packageSha256,
      deviceIdHash: this.recovery.deviceIdHash,
      expectation,
    });
    this.recovery = null;
    this.#stateChanged();
  }

  async prepareCurrentFirmwareReplacement() {
    if (
      !this.recovery ||
      this.recovery.phase !== RecoveryPhase.VERIFICATION_REQUIRED ||
      !this.recoveryStore
    ) {
      throw packageError(
        "recovery-phase-invalid",
        "current firmware replacement requires a completed write awaiting verification",
      );
    }
    if (this.busy) {
      throw packageError(
        "operation-in-progress",
        "another firmware operation is already running",
      );
    }
    this.#setBusy(true);
    try {
      await this.recoveryStore.acquireLifecycleIfAvailable();
      const verificationMarker = this.recoveryStore.readMarker();
      if (
        !verificationMarker ||
        verificationMarker.phase !== RecoveryPhase.VERIFICATION_REQUIRED ||
        JSON.stringify(verificationMarker) !== JSON.stringify(this.recovery)
      ) {
        throw packageError(
          "recovery-record-conflict",
          "the mandatory verification record changed before replacement",
        );
      }

      // Validate and durably cache the new release without changing the old
      // verification marker. The old package remains authoritative through
      // download, BOOT selection, same-device checking, and confirmation.
      const downloaded = await downloadCurrentFirmwarePackage();
      const persisted = await this.recoveryStore.persistPreparedPackage(downloaded);
      const adapter = await loadPinnedEsptoolJsAdapter({
        onDiagnostic: (entry) => this.#handleCoreDiagnostic(entry),
      });
      const controller = new BrowserFlashController({
        adapter,
        requestPort: () => navigator.serial.requestPort(),
        onDiagnostic: (entry) => this.#handleCoreDiagnostic(entry),
        onStateChange: () => this.#stateChanged(),
      });
      const prepared = await controller.prepare(
        persisted.manifest,
        preparedLoadOptions(persisted),
      );
      const rechecked = this.recoveryStore.readMarker();
      if (
        !rechecked ||
        JSON.stringify(rechecked) !== JSON.stringify(verificationMarker)
      ) {
        throw packageError(
          "recovery-record-conflict",
          "the mandatory verification record changed while the current package was checked",
        );
      }

      this.verificationReplacement = verificationMarker;
      this.recovery = rechecked;
      this.persistedPrepared = persisted;
      this.prepared = prepared;
      this.controller = controller;
      this.onActivity(
        `Validated current firmware ${prepared.manifest.release.version} for same-logger replacement`,
      );
      this.onShowInstall();
      this.#showReadyToConnect();
      return {
        packageSha256: prepared.packageSha256,
        expectation: firmwareExpectation(prepared),
      };
    } finally {
      this.#setBusy(false);
    }
  }

  #requireDurableVerificationMarker(expected) {
    if (!this.recoveryStore) {
      throw packageError(
        "recovery-record-missing",
        "mandatory firmware verification marker is missing",
      );
    }
    let durable = this.recoveryStore.readMarker();
    if (!durable) durable = this.recoveryStore.writeMarker(expected);
    if (
      durable.phase !== RecoveryPhase.VERIFICATION_REQUIRED ||
      JSON.stringify(durable) !== JSON.stringify(expected)
    ) {
      throw packageError(
        "recovery-record-conflict",
        "the mandatory verification record changed before replacement",
      );
    }
    this.recovery = durable;
    return durable;
  }

  #requireDurableWriteMarker() {
    if (!this.recovery || !this.recoveryStore) {
      const error = new Error("mandatory firmware recovery marker is missing");
      error.code = "recovery-record-missing";
      throw error;
    }
    let durable = this.recoveryStore.readMarker();
    if (!durable) {
      // Site data may have been evicted after the first successful commit.
      // Re-establish the exact in-memory marker synchronously before writing.
      durable = this.recoveryStore.writeMarker(this.recovery);
    }
    if (
      durable.phase !== RecoveryPhase.WRITE_REQUIRED ||
      JSON.stringify(durable) !== JSON.stringify(this.recovery)
    ) {
      const error = new Error(
        "another tab changed the mandatory firmware recovery record",
      );
      error.code = "recovery-record-conflict";
      throw error;
    }
    this.recovery = durable;
  }

  #setMessage(text = "", kind = "info") {
    this.message.hidden = true;
    this.message.className = "message";
    this.message.setAttribute("role", kind === "error" ? "alert" : "status");
    this.message.setAttribute(
      "aria-live",
      kind === "error" ? "assertive" : "polite",
    );
    if (kind === "error") this.message.classList.add("message--error");
    if (kind === "success") this.message.classList.add("message--success");
    this.message.textContent = text;
    this.message.hidden = !text;
  }

  #setTask({ kicker, title, description, message = "", kind = "info" }) {
    this.kicker.textContent = kicker;
    this.title.textContent = title;
    this.description.textContent = description;
    this.#setMessage(message, kind);
    this.summary.hidden = true;
    this.stages.hidden = true;
    this.progressDetail.hidden = true;
    this.#button(this.primary);
    this.#button(this.secondary);
    this.#button(this.tertiary);
    if (!this.firstRender) {
      window.requestAnimationFrame(() => this.title.focus({ preventScroll: true }));
    }
    this.firstRender = false;
  }

  #button(
    button,
    { label = "", handler = null, disabled = false, hidden = true } = {},
  ) {
    button.hidden = hidden;
    if (label) button.textContent = label;
    button.dataset.available = disabled ? "false" : "true";
    button.disabled = this.busy || disabled;
    button.onclick = handler
      ? (event) => {
          event.preventDefault();
          if (!this.busy) void handler();
        }
      : null;
  }

  #setBusy(value) {
    this.busy = value;
    this.task.setAttribute("aria-busy", String(value));
    for (const button of [this.primary, this.secondary, this.tertiary]) {
      button.disabled = value || button.dataset.available === "false";
    }
    this.#stateChanged();
  }

  #stateChanged() {
    this.onStateChange({
      unsafeToUnload: this.unsafeToUnload,
      phase: this.controller?.snapshot.phase ?? FlashPhase.IDLE,
    });
  }

  #setStage(completed, active = null) {
    this.stages.hidden = false;
    [...this.stages.children].forEach((item, index) => {
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

  #showSummary() {
    if (!this.prepared) return;
    const manifest = this.prepared.manifest;
    const sourceCommit = manifest.release.source_commit;
    const developmentBuild =
      sourceCommit === "unknown" || sourceCommit.endsWith("-dirty");
    this.release.textContent = developmentBuild
      ? `${manifest.release.version} · development build`
      : manifest.release.version;
    this.target.textContent = `${manifest.target.chip} · ${manifest.target.board}`;
    this.manifestVersion.textContent = `Version ${manifest.schema_version}`;
    this.hash.textContent = `${this.prepared.files.length} SHA-256 checks · ${this.prepared.packageSha256.slice(0, 12)}…`;
    this.summary.hidden = false;
  }

  #showPreparingPackage() {
    this.#setTask({
      kicker: "Stage 1 · Install firmware",
      title: "Check the bundled firmware",
      description:
        "The portal validates its versioned manifest and every image before it enables device selection.",
      message: this.recovery || this.recoveryLoadError
        ? "An earlier installation may not have finished. This exact package must be checked before recovery."
        : "No serial permission has been requested yet.",
    });
    this.bootInstructions.hidden = false;
    this.note.hidden = false;
    this.#setStage(0, 0);
    this.#button(this.primary, {
      label: "Checking firmware package…",
      hidden: false,
      disabled: true,
    });
    this.#button(this.secondary, {
      label: "Firmware already installed",
      handler: () => this.onSkip(),
      hidden: Boolean(this.recovery || this.recoveryLoadError),
      disabled: !this.environmentSupported(),
    });
  }

  async #preparePackage() {
    this.#setBusy(true);
    try {
      if (this.recoveryLoadError) throw this.recoveryLoadError;

      let persisted;
      if (this.recovery) {
        await this.recoveryStore.acquireLifecycleIfAvailable();
        const durable = this.recoveryStore.readMarker();
        if (!durable || JSON.stringify(durable) !== JSON.stringify(this.recovery)) {
          throw packageError(
            "recovery-record-conflict",
            "the mandatory recovery record changed before ownership was acquired",
          );
        }
        this.recovery = durable;
        if (this.recovery.phase === RecoveryPhase.VERIFICATION_REQUIRED) {
          // The completed write is already committed in the durable marker.
          // Runtime verification needs only its expected identity; avoiding a
          // package restore here also lets a legacy completed install take the
          // guarded same-device transition to the current package.
          this.onActivity(
            `Restored mandatory firmware verification ${this.recovery.expectation.firmware}`,
          );
          this.onReadyForVerification({ ...this.recovery.expectation });
          return;
        }
        persisted = await restoreOrRepairRecoveryPackage({
          store: this.recoveryStore,
          marker: this.recovery,
          downloadPackage: downloadCurrentFirmwarePackage,
        });
      } else {
        try {
          const downloaded = await downloadCurrentFirmwarePackage();
          persisted = await this.recoveryStore.persistPreparedPackage(downloaded);
        } catch (error) {
          if (!mayUseOfflinePackage(error)) throw error;
          persisted = await this.recoveryStore.restoreLatestPreparedPackage();
          this.onActivity(
            `Network firmware unavailable · using validated offline package ${persisted.packageSha256.slice(0, 12)}…`,
          );
        }
      }

      const adapter = await loadPinnedEsptoolJsAdapter({
        onDiagnostic: (entry) => this.#handleCoreDiagnostic(entry),
      });
      this.controller = new BrowserFlashController({
        adapter,
        requestPort: () => navigator.serial.requestPort(),
        onDiagnostic: (entry) => this.#handleCoreDiagnostic(entry),
        onStateChange: () => this.#stateChanged(),
      });
      this.persistedPrepared = persisted;
      this.prepared = await this.controller.prepare(
        persisted.manifest,
        {
          ...preparedLoadOptions(persisted),
          allowLegacyWriteRecovery:
            this.recovery?.phase === RecoveryPhase.WRITE_REQUIRED,
        },
      );
      if (this.recovery) {
        if (
          this.prepared.packageSha256 !== this.recovery.packageSha256 ||
          !expectationMatchesPackage(this.recovery.expectation, this.prepared)
        ) {
          const error = new Error(
            "the persisted verification target differs from its firmware package",
          );
          error.code = "recovery-package-mismatch";
          throw error;
        }
        this.controller.markRecoveryRequired(
          this.recovery.packageSha256,
          this.recovery.deviceIdHash,
        );
      }
      const sourceCommit = this.prepared.manifest.release.source_commit;
      this.onActivity(
        `Validated firmware ${this.prepared.manifest.release.version} · source ${sourceCommit.slice(0, 12)} · package ${this.prepared.packageSha256.slice(0, 12)} · ${this.prepared.files.length} image hashes`,
      );
      this.#showReadyToConnect();
    } catch (error) {
      this.#showPackageFailure(error);
    } finally {
      this.#setBusy(false);
    }
  }

  #showReadyToConnect() {
    const recovering = Boolean(this.recovery);
    const replacingVerification = Boolean(this.verificationReplacement);
    this.#setTask({
      kicker: recovering ? "Stage 1 · Recovery" : "Stage 1 · Install firmware",
      title: replacingVerification
        ? "Install current firmware on the same logger"
        : recovering
          ? "Recover the same firmware package"
          : "Enter BOOT mode",
      description: replacingVerification
        ? "Put the logger that failed the running-firmware check into BOOT mode. The portal will reject every other physical ESP32-C3 before writing."
        : recovering
          ? "Put the same XIAO ESP32-C3 into BOOT mode. The portal will reuse only the package whose integrity was checked above."
        : "Disconnect USB, hold BOOT while reconnecting it, then release BOOT after the computer detects the board.",
      message: replacingVerification
        ? "The current package is validated and cached. The previous verification record is still protected until this logger is identified."
        : "The bundled package passed its manifest, size, and SHA-256 checks.",
      kind: "success",
    });
    this.bootInstructions.hidden = false;
    this.note.hidden = false;
    this.#showSummary();
    this.#setStage(1);
    this.#button(this.primary, {
      label: replacingVerification
        ? "Choose original logger bootloader"
        : recovering
          ? "Choose device for recovery"
          : "Choose bootloader device",
      // connect() must be the first awaited operation in this user gesture.
      handler: () => this.#connectBootloader(),
      hidden: false,
      disabled: !this.environmentSupported(),
    });
    this.#button(this.secondary, {
      label: "Firmware already installed",
      handler: () => this.onSkip(),
      hidden: recovering,
      disabled: !this.environmentSupported(),
    });
  }

  #showPackageFailure(error) {
    const retryOwnership = error?.code === "recovery-lock-held";
    this.#setTask({
      kicker: "Stage 1 · Firmware unavailable",
      title: "No installable release is available",
      description:
        "Device selection stays disabled because the portal could not validate a complete same-origin firmware package.",
      message: firmwareErrorMessage(error, false),
      kind: "error",
    });
    this.bootInstructions.hidden = true;
    this.note.hidden = false;
    this.#button(this.primary, {
      label: retryOwnership ? "Retry protected recovery" : "Choose bootloader device",
      handler: retryOwnership
        ? () => {
            this.#showPreparingPackage();
            return this.#preparePackage();
          }
        : null,
      hidden: false,
      disabled: !retryOwnership,
    });
    this.#button(this.secondary, {
      label: "Firmware already installed",
      handler: () => this.onSkip(),
      hidden: Boolean(this.recovery || this.recoveryLoadError),
      disabled: !this.environmentSupported(),
    });
    this.onActivity(`Firmware package unavailable · ${firmwareErrorMessage(error, false)}`);
  }

  async #connectBootloader() {
    this.#setBusy(true);
    this.#setTask({
      kicker: "Stage 1 · Connect bootloader",
      title: "Check the selected board",
      description:
        "The browser chooser opens now. The portal will identify the chip before enabling any write.",
    });
    this.#showSummary();
    this.#setStage(1, 1);
    try {
      // Nothing asynchronous may precede this call: Web Serial requires the
      // requestPort() nested inside connect() to retain this click gesture.
      await this.controller.connect();
      if (
        this.verificationReplacement &&
        this.controller.snapshot.deviceIdHash !==
          this.verificationReplacement.deviceIdHash
      ) {
        throw packageError(
          "device-mismatch",
          "the selected bootloader is not the logger awaiting verification",
        );
      }
      this.onConnection(true, "ESP32-C3 bootloader", false);
      this.onActivity(`Validated bootloader target ${this.controller.snapshot.chip}`);
      if (this.controller.snapshot.phase === FlashPhase.READY_TO_FLASH) {
        this.#showReadyToFlash();
      } else if (
        this.controller.snapshot.phase === FlashPhase.WRITE_OUTCOME_UNCERTAIN
      ) {
        this.#showRecovery(this.controller.snapshot.error);
      } else {
        throw new FlashWorkflowError(
          "invalid-state",
          `bootloader connection stopped in ${this.controller.snapshot.phase}`,
        );
      }
    } catch (error) {
      if (this.controller?.snapshot.canCancel) {
        await this.#showCancelableError(error);
      } else if (this.controller?.snapshot.retry === FlashRetry.CONNECT) {
        this.#showRecovery(error);
      } else {
        this.#showReadyToConnect();
        this.#setMessage(firmwareErrorMessage(error, this.unsafeToUnload), "error");
      }
    } finally {
      this.#setBusy(false);
      this.#stateChanged();
    }
  }

  #showReadyToFlash() {
    const replacingVerification = Boolean(this.verificationReplacement);
    this.#setTask({
      kicker: "Stage 1 · Confirm installation",
      title: replacingVerification
        ? "Original logger and current firmware verified"
        : "ESP32-C3 and firmware verified",
      description: replacingVerification
        ? "Review the current fixed release. The previous verification record remains protected until you confirm this same-board write."
        : "Review the fixed release below. Installation writes only its declared images; there is no whole-flash erase or replacement-file option.",
    });
    this.bootInstructions.hidden = true;
    this.note.hidden = false;
    this.#showSummary();
    this.#setStage(2);
    this.#button(this.primary, {
      label: "Review and install",
      handler: () => {
        this.dialog.returnValue = "";
        this.dialog.showModal();
      },
      hidden: false,
    });
    this.#button(this.secondary, {
      label: "Cancel before writing",
      handler: () => this.#cancelBeforeWrite(),
      hidden: false,
    });
    this.#stateChanged();
  }

  async #showCancelableError(error) {
    this.#setTask({
      kicker: "Stage 1 · Device check failed",
      title: "The selected board was not accepted",
      description:
        "Nothing has been written. Close this bootloader connection before choosing another device.",
      message: firmwareErrorMessage(error, this.unsafeToUnload),
      kind: "error",
    });
    this.#showSummary();
    this.#button(this.primary, {
      label: "Close bootloader connection",
      handler: () => this.#cancelBeforeWrite(),
      hidden: false,
    });
  }

  async #cancelBeforeWrite() {
    if (!this.controller?.snapshot.canCancel || this.busy) return;
    const replacingVerification = Boolean(this.verificationReplacement);
    this.#setBusy(true);
    try {
      await this.controller.cancel();
      if (!replacingVerification) {
        await this.recoveryStore?.releaseLifecycle();
      }
      this.onConnection(false, "Not connected", false);
      this.onActivity("Canceled firmware installation before writing");
      // A canceled controller cannot connect again. Reconstruct it from the
      // immutable cached package before exposing another device chooser.
      this.controller = null;
      this.prepared = null;
      this.persistedPrepared = null;
      this.verificationReplacement = null;
      this.#showPreparingPackage();
      await this.#preparePackage();
    } catch (error) {
      this.#showRecovery(error);
    } finally {
      this.#setBusy(false);
      this.#stateChanged();
    }
  }

  async #performFlash() {
    if (this.busy) return;
    this.#setBusy(true);
    this.lastProgressKey = null;
    const verificationReplacement = this.verificationReplacement;
    try {
      await this.recoveryStore.acquireLifecycleIfAvailable();
      if (verificationReplacement) {
        this.#requireDurableVerificationMarker(verificationReplacement);
      } else {
        this.recovery = await this.recoveryStore.beginWrite({
          packageSha256: this.prepared.packageSha256,
          deviceIdHash: this.controller.snapshot.deviceIdHash,
          expectation: firmwareExpectation(this.prepared),
        });
      }
    } catch (error) {
      try {
        this.recovery = this.recoveryStore.readMarker();
      } catch (storageError) {
        this.recoveryLoadError = storageError;
      }
      await this.#showCancelableError(error);
      this.#setBusy(false);
      this.#stateChanged();
      return;
    }
    this.#setTask({
      kicker: "Stage 1 · Installing",
      title: "Writing firmware",
      description:
        "Keep USB connected. If power is interrupted, return this board to BOOT mode and recover with the same package; do not erase flash.",
    });
    this.#showSummary();
    this.#setStage(2, 2);
    this.#stateChanged();
    try {
      if (!verificationReplacement) this.#requireDurableWriteMarker();
      await this.controller.flash({
        beforeWrite: verificationReplacement
          ? async ({ packageSha256, deviceIdHash }) => {
              const replacement = await this.recoveryStore.beginReplacementWrite({
                verificationMarker: verificationReplacement,
                packageSha256,
                deviceIdHash,
                expectation: firmwareExpectation(this.prepared),
              });
              this.recovery = replacement;
              this.verificationReplacement = null;
            }
          : null,
        onProgress: (progress) => this.#renderProgress(progress),
      });
      this.recovery = this.recoveryStore.markVerificationRequired();
      this.onConnection(false, "Not connected", false);
      this.onActivity("Firmware write, verification, reset, and close completed");
      this.#showComplete();
    } catch (error) {
      if (this.controller?.snapshot.canCancel) {
        await this.#showCancelableError(error);
      } else {
        this.#showRecovery(error);
      }
    } finally {
      this.#setBusy(false);
      this.#stateChanged();
    }
  }

  #renderProgress(progress) {
    const total = progress.overallTotal || 0;
    const written = Math.min(progress.overallWritten || 0, total);
    const percent = total > 0 ? Math.floor((written / total) * 100) : 0;
    if (total > 0 && written >= total) this.#setStage(3, 3);
    else this.#setStage(2, 2);
    this.progressDetail.textContent = `${progress.fileRole} · ${progress.fileIndex} of ${progress.fileCount} · ${percent}%`;
    this.progressDetail.setAttribute(
      "aria-label",
      `Firmware installation progress: ${progress.fileRole}, image ${progress.fileIndex} of ${progress.fileCount}, ${percent} percent`,
    );
    this.progressDetail.hidden = false;
  }

  #handleCoreDiagnostic(entry) {
    if (!entry || typeof entry !== "object") return;
    if (entry.type === "message") {
      this.onDiagnostic({
        source: entry.source ?? "esptool",
        direction: "diagnostic",
        line: entry.message,
      });
      return;
    }
    if (entry.type === "phase") {
      const retry = entry.retry && entry.retry !== FlashRetry.NONE
        ? ` · retry=${entry.retry}`
        : "";
      const error = entry.error?.code ? ` · error=${entry.error.code}` : "";
      this.onDiagnostic({
        source: entry.source ?? "flasher",
        direction: "state",
        line: `phase=${entry.phase}${retry}${error}`,
      });
      return;
    }
    if (entry.type === "progress") {
      const total = entry.overallTotal || 0;
      const percent = total > 0
        ? Math.floor((Math.min(entry.overallWritten || 0, total) / total) * 100)
        : 0;
      const progressBucket = Math.min(100, Math.floor(percent / 10) * 10);
      const key = `${entry.fileRole}:${progressBucket}`;
      if (key === this.lastProgressKey) return;
      this.lastProgressKey = key;
      this.onDiagnostic({
        source: entry.source ?? "flasher",
        direction: "progress",
        line: `${entry.fileRole} · image ${entry.fileIndex}/${entry.fileCount} · overall ${progressBucket}%`,
      });
    }
  }

  #showRecovery(error) {
    const snapshot = this.controller?.snapshot;
    const retry = snapshot?.retry ?? FlashRetry.NONE;
    const recoveryRecordBlocked = [
      "recovery-record-conflict",
      "recovery-record-invalid",
      "recovery-record-missing",
      "recovery-storage-unavailable",
    ].includes(String(error?.code ?? ""));
    const actionableRetry = recoveryRecordBlocked ? FlashRetry.NONE : retry;
    const installationUncertain = Boolean(
      snapshot?.writeMayHaveStarted || this.recovery,
    );
    this.#setTask({
      kicker: installationUncertain
        ? "Stage 1 · Recovery required"
        : "Stage 1 · Device check",
      title: installationUncertain
        ? "Installation outcome is not yet verified"
        : "No firmware was written",
      description: installationUncertain
        ? "Keep this package and board together. Follow the action below; recovery never substitutes another file and never erases the whole flash."
        : "Finish the safe reset or close action below, then return to the BOOT instructions before choosing another device.",
      message: firmwareErrorMessage(error, installationUncertain),
      kind: "error",
    });
    this.bootInstructions.hidden = [
      FlashRetry.RESET,
      FlashRetry.CLOSE,
    ].includes(retry);
    this.note.hidden = false;
    this.#showSummary();
    this.#setStage(installationUncertain ? 2 : 1, installationUncertain ? 2 : 1);
    const label = actionableRetry === FlashRetry.RESET
      ? "Retry reset"
      : actionableRetry === FlashRetry.CLOSE
        ? "Retry close"
        : actionableRetry === FlashRetry.CONNECT
          ? "Return to BOOT instructions"
          : actionableRetry === FlashRetry.REFLASH_SAME_PACKAGE
            ? "Recover installation"
            : installationUncertain
              ? "Reload protected recovery"
              : "Recovery unavailable";
    this.#button(this.primary, {
      label,
      handler: actionableRetry === FlashRetry.NONE
        ? () => window.location.reload()
        : () => this.#retry(),
      hidden: false,
      disabled: actionableRetry === FlashRetry.NONE && !installationUncertain,
    });
    this.#stateChanged();
  }

  async #retry() {
    if (this.busy) return;
    const installationUncertain = Boolean(
      this.recovery || this.controller?.snapshot.writeMayHaveStarted,
    );
    this.#setBusy(true);
    this.#setTask({
      kicker: installationUncertain
        ? "Stage 1 · Recovering"
        : "Stage 1 · Closing safely",
      title: installationUncertain
        ? "Recover the verified installation"
        : "Finish the device check",
      description: installationUncertain
        ? "Keep USB connected. The portal is continuing only the recovery action selected by the flash controller."
        : "The portal is completing the reset or close action before another bootloader can be chosen.",
    });
    this.#showSummary();
    this.#setStage(2, 2);
    try {
      if (this.controller.snapshot.retry === FlashRetry.REFLASH_SAME_PACKAGE) {
        // Synchronous localStorage work preserves the chooser user gesture.
        this.#requireDurableWriteMarker();
      }
      // retry() may synchronously request a port for CONNECT recovery, so no
      // awaited work may be added above this call.
      await this.controller.retry({
        onProgress: (progress) => this.#renderProgress(progress),
      });
      if (this.controller.snapshot.phase === FlashPhase.READY_TO_CONNECT) {
        this.#showReadyToConnect();
      } else if (this.controller.snapshot.phase === FlashPhase.READY_TO_FLASH) {
        this.#showReadyToFlash();
      } else if (
        this.controller.snapshot.phase === FlashPhase.READY_FOR_COMMISSIONING
      ) {
        this.recovery = this.recoveryStore.markVerificationRequired();
        this.onConnection(false, "Not connected", false);
        this.#showComplete();
      } else if (this.controller.snapshot.phase === FlashPhase.CANCELED) {
        if (this.recovery) {
          throw new Error("an interrupted installation cannot be canceled");
        }
        this.onConnection(false, "Not connected", false);
        this.controller = null;
        this.prepared = null;
        this.persistedPrepared = null;
        this.#showPreparingPackage();
        await this.#preparePackage();
      } else {
        throw new Error(
          `recovery stopped in ${this.controller.snapshot.phase}`,
        );
      }
    } catch (error) {
      this.#showRecovery(error);
    } finally {
      this.#setBusy(false);
      this.#stateChanged();
    }
  }

  #showComplete() {
    this.#setTask({
      kicker: "Stage 1 · Installation complete",
      title: "Firmware written and verified",
      description:
        "The installer verified the images, reset the board, and closed the bootloader connection. Keep USB connected and verify the running logger next.",
      message: "Installation completed without a whole-flash erase.",
      kind: "success",
    });
    this.bootInstructions.hidden = true;
    this.note.hidden = true;
    this.#showSummary();
    this.#setStage(4);
    this.#button(this.primary, {
      label: "Connect and verify logger",
      handler: () => {
        if (this.recovery?.phase !== RecoveryPhase.VERIFICATION_REQUIRED) {
          throw new Error("mandatory firmware verification record is missing");
        }
        this.onReadyForVerification({ ...this.recovery.expectation });
      },
      hidden: false,
    });
    this.#stateChanged();
  }
}
