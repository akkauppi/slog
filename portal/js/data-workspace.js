import {
  SLOG_LIMITS,
  analyzeRun,
  buildRun,
  groupSessionsIntoRuns,
  parseSlog,
} from "./log-analysis.js";
import {
  DeletionOutcomeUncertainError,
  LogDeviceError,
  LogManager,
  PreservationError,
  inspectContinuationCatalog,
} from "./log-management.js";
import {
  createRunWorkbook,
  runExportFilename,
  serializeRunCsv,
} from "./session-export.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_NAMES = Object.freeze(["prepare", "records", "analyze"]);

function requiredElement(document, id) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing portal element #${id}`);
  return value;
}

function freezeChain(sessions, safe = true, issue = "") {
  return Object.freeze({
    sessions: Object.freeze(sessions),
    sessionIds: Object.freeze(sessions.map((session) => session.id)),
    safe,
    issue,
  });
}

function freezeChainCollection(chains, issues = []) {
  Object.defineProperty(chains, "issues", {
    enumerable: false,
    value: Object.freeze([...issues]),
  });
  return Object.freeze(chains);
}

function catalogIssueText(issue) {
  if (issue.code === "malformed_session_entry") {
    return `catalog entry ${issue.entry}: ${issue.message}`;
  }
  return issue.code.replaceAll("_", " ");
}

function catalogIssuesText(issues, maximum = 8) {
  const shown = issues.slice(0, maximum).map(catalogIssueText);
  if (issues.length > maximum) shown.push(`${issues.length - maximum} more issue${issues.length - maximum === 1 ? "" : "s"}`);
  return shown.join("; ");
}

function sessionReceiptKey(session) {
  return [
    session.id,
    session.bytes,
    session.state,
    session.version,
    session.bootId,
    session.continuationOf,
    session.continuationKind,
  ].join(":");
}

/** Group the already validated device catalog without guessing through branches. */
export function groupCatalogSessions(input) {
  if (!Array.isArray(input)) throw new TypeError("session catalog must be an array");
  const inspection = inspectContinuationCatalog(input);
  if (inspection.valid) {
    return freezeChainCollection(
      inspection.runs.map((sessions) => freezeChain([...sessions])),
    );
  }
  const issueText = catalogIssuesText(inspection.issues);
  // Keep every physical catalog entry visible and downloadable. Relationships
  // are deliberately not inferred when any catalog invariant is uncertain.
  return freezeChainCollection(
    input.map((session) =>
      freezeChain(
        [session],
        false,
        `Device continuation catalog is unsafe (${issueText}); grouping and removal are disabled.`,
      ),
    ),
    inspection.issues,
  );
}

function decimate(points, maximum) {
  if (points.length <= maximum) return points;
  const result = [points[0]];
  const buckets = Math.max(1, Math.floor((maximum - 2) / 2));
  const interior = points.length - 2;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = 1 + Math.floor((bucket * interior) / buckets);
    const end = 1 + Math.floor(((bucket + 1) * interior) / buckets);
    if (start >= end) continue;
    let minimum = points[start];
    let maximumPoint = points[start];
    for (let index = start + 1; index < end; index += 1) {
      if (points[index].temperatureC < minimum.temperatureC) minimum = points[index];
      if (points[index].temperatureC > maximumPoint.temperatureC) maximumPoint = points[index];
    }
    if (minimum.observedSeconds <= maximumPoint.observedSeconds) {
      result.push(minimum);
      if (maximumPoint !== minimum) result.push(maximumPoint);
    } else {
      result.push(maximumPoint);
      if (maximumPoint !== minimum) result.push(minimum);
    }
  }
  result.push(points.at(-1));
  return result;
}

/** Split one probe into independently drawable pieces; never bridge unknown or sensor gaps. */
export function buildProbeSeries(run, probeIndex, maximumPoints = 900) {
  if (!run?.points || !Number.isInteger(probeIndex) || probeIndex < 0 || probeIndex > 7) {
    throw new TypeError("a run and probe index 0–7 are required");
  }
  const pieces = [];
  let piece = [];
  let previousSegment = null;
  const unknownBeforeSegments = new Set(
    (run.breaks ?? []).map((gap) => gap.beforeSegment),
  );
  for (const point of run.points) {
    const value = point.temperaturesC[probeIndex];
    const crossesUnknownBoundary =
      previousSegment !== null &&
      point.segment !== previousSegment &&
      unknownBeforeSegments.has(point.segment);
    if (value === null || crossesUnknownBoundary) {
      if (piece.length) pieces.push(Object.freeze(decimate(piece, maximumPoints)));
      piece = [];
    }
    if (value !== null) {
      piece.push(Object.freeze({
        observedSeconds: point.observedSeconds,
        temperatureC: value,
        segment: point.segment,
      }));
    }
    previousSegment = point.segment;
  }
  if (piece.length) pieces.push(Object.freeze(decimate(piece, maximumPoints)));
  return Object.freeze(pieces);
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(2)} MiB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "−" : "";
  const absolute = Math.abs(Math.round(seconds));
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  const remaining = absolute % 60;
  if (hours) return `${sign}${hours} h ${minutes} min`;
  if (minutes) return `${sign}${minutes} min ${remaining} s`;
  return `${sign}${remaining} s`;
}

function formatTemperature(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} °C` : "—";
}

function formatRate(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} °C/min` : "—";
}

function setStatus(element, text = "", kind = "info") {
  element.hidden = !text;
  element.textContent = text;
  element.className = "message";
  element.setAttribute("role", kind === "error" ? "alert" : "status");
  if (kind === "error") element.classList.add("message--error");
  if (kind === "success") element.classList.add("message--success");
}

function friendlyError(error) {
  if (error?.name === "AbortError" || error?.name === "NotFoundError") {
    return "No destination or device was selected.";
  }
  if (error instanceof LogDeviceError) {
    const messages = {
      active_session: "A sauna recording is active. Refresh after it ends before transferring or removing records.",
      probable_continuation: "This interrupted run is protected because the next hot start may continue it.",
      continuation_exists: "A newer continuation still exists. The portal removes whole runs newest to oldest.",
      configuration_unresolved: "Finish or recover probe setup before removing records.",
      firmware_update_required: "Update the logger firmware before removal; it does not expose continuation protection.",
      catalog_invalid: "The run list is inconsistent. You can still download raw files, but removal is disabled.",
      retention_audit_unavailable: "The logger could not verify its retention state. You can still download raw files, but removal is disabled.",
      retention_catalog_invalid: "The logger's run list is invalid or incomplete. You can still download raw files, but removal is disabled.",
      retention_pending: "Automatic retention is incomplete. Reconnect or restart the logger so it can finish before manual removal.",
      continuation_state_invalid: "Continuation protection does not match the record catalog. Nothing further was removed.",
      fs_unavailable: "The logger filesystem is unavailable. It is not formatted automatically.",
      not_found: "The record is no longer present on the logger.",
    };
    return messages[error.code] ?? error.message;
  }
  if (error instanceof PreservationError) return error.message;
  return error?.message ? String(error.message) : "The operation could not be completed.";
}

function svgElement(document, name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

export class DataWorkspace {
  constructor({
    document,
    window,
    connectLogger,
    disconnectLogger,
    environmentSupported = () => true,
    canNavigate = () => true,
    onNavigationBlocked = () => {},
    onUnsafeChange = () => {},
    onActivity = () => {},
  }) {
    this.document = document;
    this.window = window;
    this.connectLogger = connectLogger;
    this.disconnectLogger = disconnectLogger;
    this.environmentSupported = environmentSupported;
    this.canNavigate = canNavigate;
    this.onNavigationBlocked = onNavigationBlocked;
    this.onUnsafeChange = onUnsafeChange;
    this.onActivity = onActivity;
    this.activeView = "prepare";
    this.operation = null;
    this.manager = null;
    this.deviceInfo = null;
    this.status = null;
    this.catalog = [];
    this.chains = [];
    this.receipts = new Map();
    this.downloads = new Map();
    this.analysisRuns = [];
    this.selectedRun = 0;
    this.pendingRemoval = null;

    this.views = new Map(
      VIEW_NAMES.map((name) => [name, requiredElement(document, `${name}-view`)]),
    );
    this.navButtons = [...document.querySelectorAll("[data-portal-view]")];
    this.recordsMessage = requiredElement(document, "records-message");
    this.recordsConnect = requiredElement(document, "records-connect");
    this.recordsRefresh = requiredElement(document, "records-refresh");
    this.recordsIdentity = requiredElement(document, "records-device-identity");
    this.storageSummary = requiredElement(document, "storage-summary");
    this.recordsActive = requiredElement(document, "records-active");
    this.recordsStorage = requiredElement(document, "records-storage");
    this.recordsReserve = requiredElement(document, "records-reserve");
    this.recordsRetention = requiredElement(document, "records-retention");
    this.retentionNote = requiredElement(document, "records-retention-note");
    this.recordsCount = requiredElement(document, "records-count");
    this.recordsCatalog = requiredElement(document, "records-catalog");
    this.fileInput = requiredElement(document, "analysis-files");
    this.analysisMessage = requiredElement(document, "analysis-message");
    this.analysisIssues = requiredElement(document, "analysis-group-issues");
    this.analysisOutput = requiredElement(document, "analysis-output");
    this.runSelect = requiredElement(document, "analysis-run-select");
    this.exportCsvButton = requiredElement(document, "analysis-export-csv");
    this.exportExcelButton = requiredElement(document, "analysis-export-excel");
    this.probeSelect = requiredElement(document, "analysis-probe-select");
    this.chart = requiredElement(document, "analysis-chart");
    this.gapNote = requiredElement(document, "analysis-gap-note");
    this.probeTable = requiredElement(document, "analysis-probe-table");
    this.integrityList = requiredElement(document, "analysis-integrity-list");
    this.removeDialog = requiredElement(document, "remove-run-dialog");
    this.removeDescription = requiredElement(document, "remove-run-description");

    for (const button of this.navButtons) {
      button.addEventListener("click", () => this.requestView(button.dataset.portalView));
    }
    this.recordsConnect.addEventListener("click", () => void this.connect());
    this.recordsRefresh.addEventListener("click", () => void this.refresh());
    this.fileInput.addEventListener("change", () => void this.openFiles(this.fileInput.files));
    this.runSelect.addEventListener("change", () => {
      this.selectedRun = Number(this.runSelect.value);
      this.renderAnalysis();
    });
    this.exportCsvButton.addEventListener("click", () => this.downloadRunExport("csv"));
    this.exportExcelButton.addEventListener("click", () => this.downloadRunExport("xlsx"));
    this.probeSelect.addEventListener("change", () => this.renderChart());
    this.removeDialog.addEventListener("close", () => {
      if (this.removeDialog.returnValue === "confirm" && this.pendingRemoval) {
        void this.removeRun(this.pendingRemoval);
      }
      this.pendingRemoval = null;
    });
    this.updateControls();
  }

  get unsafeToLeave() {
    return this.operation === "transfer" || this.operation === "delete";
  }

  requestView(name, { focus = true } = {}) {
    if (!VIEW_NAMES.includes(name) || name === this.activeView) return false;
    if (this.operation || !this.canNavigate(name)) {
      const message = this.operation
        ? "Finish the current record operation before changing sections."
        : "Finish or safely cancel the current logger setup before changing sections.";
      this.onNavigationBlocked(message);
      setStatus(
        this.activeView === "records" ? this.recordsMessage : this.analysisMessage,
        message,
        "error",
      );
      return false;
    }
    this.activeView = name;
    for (const [viewName, view] of this.views) view.hidden = viewName !== name;
    for (const button of this.navButtons) {
      if (button.dataset.portalView === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (focus) {
      const heading = this.views.get(name).querySelector("h1");
      this.window.requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
    }
    if (name === "records" && !this.environmentSupported()) {
      setStatus(
        this.recordsMessage,
        "USB record management needs a secure top-level page in a desktop browser with Web Serial. Offline file analysis remains available.",
        "error",
      );
    }
    return true;
  }

  async connect() {
    if (this.operation) return;
    this.beginOperation("connect");
    setStatus(this.recordsMessage, "Checking the logger identity and storage status.");
    try {
      const connection = await this.connectLogger();
      this.manager = new LogManager(connection.transport);
      this.deviceInfo = connection.info;
      this.receipts.clear();
      this.downloads.clear();
      this.recordsIdentity.textContent = `${connection.info.firmware} · ${connection.info.ota}`;
      this.onActivity(`Records opened for verified ${connection.info.product} ${connection.info.firmware}`);
      await this.refreshUnlocked();
    } catch (error) {
      setStatus(this.recordsMessage, friendlyError(error), "error");
    } finally {
      this.endOperation();
    }
  }

  async disconnect() {
    if (this.unsafeToLeave) return;
    try {
      await this.disconnectLogger();
    } finally {
      this.handleConnectionClosed();
    }
  }

  handleConnectionClosed(message = "Logger disconnected. Reconnect to refresh its file list.") {
    this.manager = null;
    this.deviceInfo = null;
    this.status = null;
    this.catalog = [];
    this.chains = [];
    this.receipts.clear();
    this.downloads.clear();
    this.recordsIdentity.textContent = "Not connected";
    this.storageSummary.hidden = true;
    this.retentionNote.hidden = true;
    this.recordsCount.textContent = "No file list loaded";
    this.recordsCatalog.replaceChildren(this.emptyState("Connect a logger to inspect its records."));
    if (this.activeView === "records") setStatus(this.recordsMessage, message, "error");
    this.updateControls();
  }

  async refresh() {
    if (!this.manager || this.operation) return;
    this.beginOperation("refresh");
    try {
      await this.refreshUnlocked();
    } catch (error) {
      setStatus(this.recordsMessage, friendlyError(error), "error");
    } finally {
      this.endOperation();
    }
  }

  async refreshUnlocked() {
    const status = await this.manager.status();
    const catalog = status.filesystemReady ? await this.manager.list() : [];
    this.status = status;
    this.catalog = catalog;
    this.downloads.clear();
    const currentReceiptKeys = new Set(catalog.map(sessionReceiptKey));
    for (const key of this.receipts.keys()) {
      if (!currentReceiptKeys.has(key)) this.receipts.delete(key);
    }
    this.chains = groupCatalogSessions(catalog);
    this.renderStorage();
    this.renderCatalog();
    if (status.active) {
      setStatus(
        this.recordsMessage,
        `Session ${status.activeSessionId} is recording. You can view the file list, but downloads and removal stay disabled until recording ends.`,
      );
    } else if (!status.filesystemReady) {
      setStatus(this.recordsMessage, "The logger filesystem is unavailable and was not formatted.", "error");
    } else {
      setStatus(this.recordsMessage, `Loaded ${catalog.length} stored segment${catalog.length === 1 ? "" : "s"}.`, "success");
    }
  }

  renderStorage() {
    const status = this.status;
    if (!status) return;
    this.storageSummary.hidden = false;
    this.recordsActive.textContent = status.active
      ? `Session ${status.activeSessionId} active`
      : "Idle";
    this.recordsStorage.textContent = status.filesystemReady
      ? `${formatBytes(status.freeBytes)} free of ${formatBytes(status.totalBytes)}`
      : "Filesystem unavailable";
    this.recordsReserve.textContent = status.retention.reserveOk
      ? `${formatBytes(status.retention.reserveRequiredBytes)} ready`
      : `${formatBytes(status.retention.reserveRequiredBytes)} not available`;
    this.recordsReserve.dataset.state = status.retention.reserveOk ? "ready" : "attention";
    this.recordsRetention.textContent = `${status.retention.deletedRuns} run${status.retention.deletedRuns === 1 ? "" : "s"} · ${status.retention.deletedSegments} segment${status.retention.deletedSegments === 1 ? "" : "s"} retired`;

    const notes = [];
    if (status.retention.pendingRun) {
      notes.push(
        `Automatic retirement of run ${status.retention.pendingRun} is pending at segment ${status.retention.pendingSegment}.`,
      );
    }
    if (status.continuationPendingSessionId) {
      notes.push(`The run containing session ${status.continuationPendingSessionId} is protected because the next hot start may continue it.`);
    } else if (status.continuationPendingSessionId === null) {
      notes.push("This firmware does not expose safe continuation eligibility; manual removal is disabled until it is updated.");
    }
    if (status.commissioning || status.restartRequired) {
      notes.push("Probe configuration is unresolved; finish recovery before manual removal.");
    }
    if (status.coredumpPresent) {
      notes.push(`A ${formatBytes(status.coredumpBytes)} crash dump is present. This portal never erases it.`);
    }
    if (!status.retention.reserveOk) {
      notes.push("A new session may be refused until a full 12-hour reserve can be made.");
    }
    if (!status.retention.auditOk || status.retention.catalogInvalid || status.retention.catalogOverflow) {
      notes.push("The on-device retention audit needs attention; manual removal is disabled.");
    }
    if (status.retention.lastRefusal && status.retention.lastRefusal !== "none") {
      notes.push(`Latest start refusal: ${status.retention.lastRefusal.replaceAll("_", " ")}.`);
    }
    this.retentionNote.textContent = notes.join(" ");
    this.retentionNote.hidden = notes.length === 0;
  }

  emptyState(text) {
    const paragraph = this.document.createElement("p");
    paragraph.className = "empty-state";
    paragraph.textContent = text;
    return paragraph;
  }

  renderCatalog() {
    this.recordsCatalog.replaceChildren();
    const inspection = inspectContinuationCatalog(this.catalog);
    this.recordsCount.textContent = inspection.valid
      ? `${this.chains.length} run${this.chains.length === 1 ? "" : "s"} · ${this.catalog.length} segment${this.catalog.length === 1 ? "" : "s"} · oldest first`
      : `${this.catalog.length} valid ungrouped file${this.catalog.length === 1 ? "" : "s"} · ${inspection.issues.length} list issue${inspection.issues.length === 1 ? "" : "s"}`;
    if (!inspection.valid) {
      const issue = this.document.createElement("p");
      issue.className = "retention-note";
      issue.textContent = `The logger's file list is inconsistent: ${catalogIssuesText(inspection.issues)}. Valid files can still be downloaded, but grouping and removal are disabled.`;
      this.recordsCatalog.append(issue);
    }
    if (this.chains.length === 0) {
      this.recordsCatalog.append(this.emptyState(
        inspection.valid
          ? "No sauna records are stored on this logger."
          : "No valid targetable session entries were returned.",
      ));
      return;
    }
    for (const [chainIndex, chain] of this.chains.entries()) {
      const article = this.document.createElement("article");
      article.className = "record-chain";
      const header = this.document.createElement("div");
      header.className = "record-chain__header";
      const titleGroup = this.document.createElement("div");
      const label = this.document.createElement("p");
      label.className = "section-label";
      label.textContent = chain.safe
        ? `Run ${chainIndex + 1}`
        : `Ungrouped file ${chainIndex + 1}`;
      const title = this.document.createElement("h3");
      title.textContent = chain.sessionIds.map((id) => `#${id}`).join(" → ");
      titleGroup.append(label, title);
      const state = this.document.createElement("p");
      state.className = "record-chain__state";
      const chainBytes = chain.sessions.reduce((sum, session) => sum + session.bytes, 0);
      state.textContent = `${chain.sessions.some((session) => session.state === "interrupted")
        ? "Includes interrupted segment"
        : "Finalized"} · ${formatBytes(chainBytes)}`;
      header.append(titleGroup, state);
      article.append(header);

      if (!chain.safe) {
        const issue = this.document.createElement("p");
        issue.className = "retention-note";
        issue.textContent = chain.issue;
        article.append(issue);
      }

      const tableWrap = this.document.createElement("div");
      tableWrap.className = "table-wrap";
      const table = this.document.createElement("table");
      const head = this.document.createElement("thead");
      head.innerHTML = "<tr><th scope=\"col\">Segment</th><th scope=\"col\">State</th><th scope=\"col\">Size</th><th scope=\"col\">Continuation</th><th scope=\"col\">Saved copy</th><th scope=\"col\">Action</th></tr>";
      const body = this.document.createElement("tbody");
      for (const session of chain.sessions) body.append(this.renderSessionRow(session));
      table.append(head, body);
      tableWrap.append(table);
      article.append(tableWrap);

      const actions = this.document.createElement("div");
      actions.className = "actions record-chain__actions";
      const analyze = this.actionButton(
        chain.safe ? "Analyze run" : "Analyze segment",
        "button--secondary",
        () => void this.analyzeDeviceRun(chain),
      );
      analyze.disabled = !this.canTransfer();
      actions.append(analyze);
      const remove = this.actionButton("Remove run from logger", "button--quiet", () => this.confirmRemove(chain));
      const removal = this.removalReadiness(chain);
      remove.disabled = !removal.ready;
      remove.title = removal.ready ? "" : removal.reason;
      actions.append(remove);
      article.append(actions);

      if (!removal.ready) {
        const explanation = this.document.createElement("p");
        explanation.className = "record-chain__removal-note";
        explanation.textContent = removal.reason;
        article.append(explanation);
      }
      this.recordsCatalog.append(article);
    }
  }

  actionButton(label, kind, handler) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = `button ${kind}`;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  renderSessionRow(session) {
    const row = this.document.createElement("tr");
    const id = this.document.createElement("th");
    id.scope = "row";
    id.textContent = `#${session.id}`;
    const state = this.document.createElement("td");
    state.textContent = session.state === "finalized" ? "Finalized" : "Interrupted";
    const size = this.document.createElement("td");
    size.textContent = formatBytes(session.bytes);
    const continuation = this.document.createElement("td");
    continuation.textContent = session.continuationOf
      ? `Continues #${session.continuationOf}`
      : "Root";
    const archive = this.document.createElement("td");
    const receipt = this.receipts.get(sessionReceiptKey(session));
    archive.textContent = receipt ? `Verified · ${receipt.filename}` : "No verified copy";
    archive.dataset.state = receipt ? "ready" : "attention";
    const action = this.document.createElement("td");
    action.className = "record-actions";
    if (typeof this.window.showSaveFilePicker === "function") {
      const preserve = this.actionButton(
        receipt ? "Save again" : "Save and verify",
        "button--secondary",
        () => void this.preserveSession(session),
      );
      preserve.disabled = !this.canTransfer();
      action.append(preserve);
    }
    const download = this.actionButton("Quick download", "button--quiet", () => void this.downloadSession(session));
    download.disabled = !this.canTransfer();
    action.append(download);
    row.append(id, state, size, continuation, archive, action);
    return row;
  }

  canTransfer() {
    return Boolean(
      this.manager &&
      this.status?.filesystemReady &&
      !this.status.active &&
      !this.operation,
    );
  }

  removalReadiness(chain) {
    if (!chain.safe) return { ready: false, reason: chain.issue };
    if (!this.manager) return { ready: false, reason: "Connect the logger before removal." };
    if (this.status?.active) return { ready: false, reason: "Removal is disabled while recording." };
    if (this.status?.commissioning || this.status?.restartRequired) {
      return { ready: false, reason: "Finish or recover probe setup before removal." };
    }
    if (this.status?.continuationPendingSessionId === null) {
      return { ready: false, reason: "Update the logger firmware before removal; safe continuation state is not available." };
    }
    if (this.status?.retention.pendingSegment || this.status?.retention.pendingRun) {
      return { ready: false, reason: "Automatic retention is incomplete; let the logger finish that journal before manual removal." };
    }
    if (!this.status?.retention.auditOk || this.status?.retention.catalogInvalid || this.status?.retention.catalogOverflow) {
      return { ready: false, reason: "Resolve the device retention audit before manual removal." };
    }
    if (
      this.status?.continuationPendingSessionId &&
      chain.sessionIds.includes(this.status.continuationPendingSessionId)
    ) {
      return { ready: false, reason: "This interrupted run is protected as a probable hot-start continuation." };
    }
    const missing = chain.sessions.filter(
      (session) => !this.receipts.has(sessionReceiptKey(session)),
    );
    if (missing.length) {
      const capability = typeof this.window.showSaveFilePicker === "function"
        ? `Save and verify every segment first (missing ${missing.map((session) => `#${session.id}`).join(", ")}).`
        : "This browser cannot verify saved files. Quick downloads are available, but removal stays disabled.";
      return { ready: false, reason: capability };
    }
    return { ready: true, reason: "" };
  }

  beginOperation(kind) {
    if (this.operation) throw new Error("another data operation is already active");
    this.operation = kind;
    this.onUnsafeChange(this.unsafeToLeave);
    this.updateControls();
  }

  endOperation() {
    this.operation = null;
    this.onUnsafeChange(false);
    this.updateControls();
    if (this.manager && this.catalog) this.renderCatalog();
  }

  updateControls() {
    const connected = Boolean(this.manager);
    this.recordsConnect.hidden = connected;
    this.recordsConnect.disabled = Boolean(this.operation) || !this.environmentSupported();
    this.recordsRefresh.hidden = !connected;
    this.recordsRefresh.disabled = Boolean(this.operation);
    for (const button of this.navButtons) button.disabled = Boolean(this.operation);
  }

  async validatedDownload(session, { parse = false } = {}) {
    const existing = this.downloads.get(session);
    if (existing && (!parse || existing.parsed)) return existing;
    const download = existing?.download ?? await this.manager.download(session.id);
    if (download.size !== session.bytes) {
      throw new Error(`session ${session.id} changed size during transfer`);
    }
    let parsed = existing?.parsed ?? null;
    if (parse) {
      parsed = parseSlog(download.bytes());
      if (parsed.sessionId !== session.id) {
        throw new Error(`download for session ${session.id} contains session ${parsed.sessionId}`);
      }
    }
    const value = Object.freeze({ download, parsed });
    this.downloads.set(session, value);
    return value;
  }

  async preserveSession(session) {
    if (!this.canTransfer() || typeof this.window.showSaveFilePicker !== "function") return;
    this.beginOperation("transfer");
    try {
      // The picker is deliberately invoked before any asynchronous serial work,
      // while this click still carries browser user activation.
      const handle = await this.window.showSaveFilePicker({
        suggestedName: `session-${session.id}.slog`,
        excludeAcceptAllOption: true,
        types: [{
          description: "Sauna logger raw file",
          accept: { "application/octet-stream": [".slog"] },
        }],
      });
      setStatus(this.recordsMessage, `Downloading and validating session ${session.id}…`);
      const { download } = await this.validatedDownload(session);
      const receipt = await this.manager.preserveToFile(download, handle);
      this.receipts.set(sessionReceiptKey(session), receipt);
      this.onActivity(`Saved session ${session.id} after CRC and file readback verification`);
      setStatus(
        this.recordsMessage,
        `Session ${session.id} was CRC-checked, saved as ${receipt.filename}, and verified byte for byte.`,
        "success",
      );
    } catch (error) {
      setStatus(this.recordsMessage, friendlyError(error), error?.name === "AbortError" ? "info" : "error");
    } finally {
      this.endOperation();
      this.renderCatalog();
    }
  }

  async downloadSession(session) {
    if (!this.canTransfer()) return;
    this.beginOperation("transfer");
    try {
      setStatus(this.recordsMessage, `Downloading and validating session ${session.id}…`);
      const { download } = await this.validatedDownload(session);
      const url = URL.createObjectURL(new Blob([download.bytes()], { type: "application/octet-stream" }));
      const link = this.document.createElement("a");
      link.href = url;
      link.download = download.suggestedName;
      link.click();
      this.window.setTimeout(() => URL.revokeObjectURL(url), 0);
      this.onActivity(`Created CRC-validated browser download for session ${session.id}`);
      setStatus(
        this.recordsMessage,
        `Session ${session.id} passed its CRC check and was downloaded. The browser does not let this page verify the saved file, so this download does not enable removal.`,
        "success",
      );
    } catch (error) {
      setStatus(this.recordsMessage, friendlyError(error), "error");
    } finally {
      this.endOperation();
      this.renderCatalog();
    }
  }

  async analyzeDeviceRun(chain) {
    if (!this.canTransfer()) return;
    this.beginOperation("transfer");
    try {
      setStatus(this.recordsMessage, `Downloading ${chain.sessionIds.length} segment${chain.sessionIds.length === 1 ? "" : "s"} for local analysis…`);
      const parsed = [];
      for (const session of chain.sessions) {
        parsed.push((await this.validatedDownload(session, { parse: true })).parsed);
      }
      if (chain.safe) {
        this.loadParsedSessions(parsed, chain.sessions.map((session) => `session-${session.id}.slog`));
      } else {
        this.loadIsolatedSession(parsed[0], chain.issue);
      }
      setStatus(this.recordsMessage, "The run was transferred with CRC validation and opened in Analyze.", "success");
      this.onActivity(`Opened run ${chain.sessionIds.join("->")} in local analysis`);
    } catch (error) {
      setStatus(this.recordsMessage, friendlyError(error), "error");
      return;
    } finally {
      this.endOperation();
      this.renderCatalog();
    }
    this.requestView("analyze");
  }

  confirmRemove(chain) {
    const readiness = this.removalReadiness(chain);
    if (!readiness.ready || this.operation) return;
    this.pendingRemoval = chain;
    this.removeDescription.textContent = `Run ${chain.sessionIds.map((id) => `#${id}`).join(" → ")} contains ${chain.sessions.length} saved and verified segment${chain.sessions.length === 1 ? "" : "s"}. Removal from the logger cannot be undone.`;
    this.removeDialog.returnValue = "";
    this.removeDialog.showModal();
  }

  async removeRun(chain) {
    const readiness = this.removalReadiness(chain);
    if (!readiness.ready || this.operation) return;
    this.beginOperation("delete");
    let removed = 0;
    let attempted = null;
    let failure = null;
    let refreshFailure = null;
    try {
      for (const session of [...chain.sessions].reverse()) {
        attempted = session;
        setStatus(this.recordsMessage, `Verifying saved session ${session.id} again, then removing it…`);
        await this.manager.deletePreserved(
          this.receipts.get(sessionReceiptKey(session)),
        );
        removed += 1;
        this.receipts.delete(sessionReceiptKey(session));
        this.downloads.delete(session);
        this.onActivity(`Removed preserved session ${session.id} from logger`);
        attempted = null;
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await this.refreshUnlocked();
      } catch (error) {
        refreshFailure = error;
      }
      this.endOperation();
      if (refreshFailure) {
        const preceding = failure instanceof DeletionOutcomeUncertainError
          ? `Deletion confirmation for session ${failure.sessionId} was lost. Your verified local files were not changed.`
          : failure
            ? friendlyError(failure)
            : "Removal acknowledgements completed.";
        setStatus(
          this.recordsMessage,
          `${preceding} The catalog could not be refreshed, so the final on-device removal state is uncertain: ${friendlyError(refreshFailure)}`,
          "error",
        );
      } else if (failure) {
        const refreshedCatalogTrusted = inspectContinuationCatalog(this.catalog).valid;
        if (failure instanceof DeletionOutcomeUncertainError) {
          const uncertainSessionId = failure.sessionId;
          const uncertainSession = chain.sessions.find((session) => session.id === uncertainSessionId);
          const uncertainSessionIsAbsent =
            refreshedCatalogTrusted &&
            !this.catalog.some((session) => session.id === uncertainSessionId);
          if (uncertainSessionIsAbsent && uncertainSession) {
            removed += 1;
            this.receipts.delete(sessionReceiptKey(uncertainSession));
            this.downloads.delete(uncertainSession);
          }
          const remaining = chain.sessions.filter((session) =>
            this.catalog.some((entry) => entry.id === session.id)
          ).length;
          const refreshedState = !refreshedCatalogTrusted
            ? "The refreshed catalog is unsafe, so it cannot prove which segments remain on the logger."
            : uncertainSessionIsAbsent
              ? `The refreshed catalog no longer lists session ${uncertainSessionId}; ${remaining ? `${remaining} older segment${remaining === 1 ? " remains" : "s remain"}.` : "the whole run is gone."}`
              : `The refreshed catalog still lists session ${uncertainSessionId}; ${remaining} segment${remaining === 1 ? " remains" : "s remain"} from this run.`;
          setStatus(
            this.recordsMessage,
            `Deletion confirmation for session ${uncertainSessionId} was lost. ${refreshedState} Your verified local files were not changed.`,
            refreshedCatalogTrusted && remaining === 0 ? "success" : "error",
          );
        } else {
          const catalogState = !refreshedCatalogTrusted
            ? "The refreshed catalog is unsafe, so the exact remaining device state cannot be summarized."
            : attempted && this.catalog.some((session) => session.id === attempted.id)
              ? `The refreshed catalog still lists session ${attempted.id}.`
              : attempted
                ? `The refreshed catalog no longer lists session ${attempted.id}.`
                : "The refreshed catalog shows the remaining records.";
          const acknowledgedState = removed
            ? `${removed} newest segment${removed === 1 ? " was" : "s were"} acknowledged and removed before this refusal.`
            : "No earlier segment removal was acknowledged before this refusal.";
          setStatus(
            this.recordsMessage,
            `${friendlyError(failure)} ${acknowledgedState} ${catalogState} Saved raw files were not changed.`,
            "error",
          );
        }
      } else {
        setStatus(
          this.recordsMessage,
          `Removed all ${removed} segments newest to oldest. Saved raw files were not changed.`,
          "success",
        );
      }
    }
  }

  async openFiles(fileList) {
    const files = [...(fileList ?? [])];
    if (files.length === 0) return;
    if (files.length > SLOG_LIMITS.maximumRunSegments) {
      setStatus(
        this.analysisMessage,
        `Choose at most ${SLOG_LIMITS.maximumRunSegments} raw segments at once.`,
        "error",
      );
      return;
    }
    const sessions = [];
    const names = [];
    const failures = [];
    setStatus(this.analysisMessage, `Reading ${files.length} raw file${files.length === 1 ? "" : "s"} locally…`);
    for (const file of files) {
      try {
        if (file.size > SLOG_LIMITS.maximumBytes) {
          throw new Error(`${formatBytes(file.size)} exceeds the ${formatBytes(SLOG_LIMITS.maximumBytes)} per-file limit`);
        }
        sessions.push(parseSlog(await file.arrayBuffer()));
        names.push(file.name);
      } catch (error) {
        failures.push(`${file.name}: ${friendlyError(error)}`);
      }
    }
    this.loadParsedSessions(sessions, names, failures);
    this.fileInput.value = "";
  }

  loadIsolatedSession(session, reason) {
    const run = buildRun([session]);
    this.analysisRuns = [Object.freeze({
      run,
      analysis: analyzeRun(run),
      displayLabel: `Isolated session ${session.sessionId}`,
      isolatedReason: reason,
    })];
    this.selectedRun = 0;
    this.analysisOutput.hidden = false;
    this.runSelect.replaceChildren();
    const option = this.document.createElement("option");
    option.value = "0";
    option.textContent = `Isolated session ${session.sessionId}`;
    this.runSelect.append(option);
    const heading = this.document.createElement("h3");
    heading.textContent = "Continuation not inferred";
    const explanation = this.document.createElement("p");
    explanation.textContent = `${reason} This raw segment is shown alone; any time before or after it is excluded.`;
    this.analysisIssues.replaceChildren(heading, explanation);
    this.analysisIssues.hidden = false;
    setStatus(
      this.analysisMessage,
      `Opened CRC-checked session ${session.sessionId} as an isolated segment.`,
      "success",
    );
    this.renderAnalysis();
  }

  loadParsedSessions(sessions, names = [], failures = []) {
    this.analysisRuns = [];
    this.selectedRun = 0;
    this.analysisIssues.hidden = true;
    this.analysisIssues.replaceChildren();
    if (sessions.length === 0) {
      this.analysisOutput.hidden = true;
      setStatus(this.analysisMessage, failures.join(" ") || "No valid sauna log was opened.", "error");
      return;
    }

    let grouped;
    try {
      grouped = groupSessionsIntoRuns(sessions);
      this.analysisRuns = grouped.runs.map((runSessions) => {
        const run = buildRun(runSessions);
        return Object.freeze({ run, analysis: analyzeRun(run) });
      });
    } catch (error) {
      this.analysisOutput.hidden = true;
      setStatus(this.analysisMessage, friendlyError(error), "error");
      return;
    }

    const groupIssues = grouped.groups.filter((group) => group.status !== "ready");
    for (const group of groupIssues) {
      const reason = group.issues.map((issue) => issue.message).join(" ");
      for (const session of group.sessions) {
        const run = buildRun([session]);
        this.analysisRuns.push(Object.freeze({
          run,
          analysis: analyzeRun(run),
          displayLabel: `Isolated session ${session.sessionId}`,
          isolatedReason: reason,
        }));
      }
    }
    if (groupIssues.length || failures.length) {
      const heading = this.document.createElement("h3");
      heading.textContent = "Files kept separate or rejected";
      const list = this.document.createElement("ul");
      for (const failure of failures) {
        const item = this.document.createElement("li");
        item.textContent = failure;
        list.append(item);
      }
      for (const group of groupIssues) {
        for (const issue of group.issues) {
          const item = this.document.createElement("li");
          item.textContent = issue.message;
          list.append(item);
        }
      }
      this.analysisIssues.append(heading, list);
      this.analysisIssues.hidden = false;
    }

    if (this.analysisRuns.length === 0) {
      this.analysisOutput.hidden = true;
      setStatus(
        this.analysisMessage,
        "The files are valid, but their continuation links are incomplete or unclear, so they could not be grouped into a run.",
        "error",
      );
      return;
    }
    this.analysisOutput.hidden = false;
    this.runSelect.replaceChildren();
    for (const [index, item] of this.analysisRuns.entries()) {
      const option = this.document.createElement("option");
      option.value = String(index);
      option.textContent = item.displayLabel ?? item.analysis.label;
      this.runSelect.append(option);
    }
    setStatus(
      this.analysisMessage,
      `Opened ${sessions.length} checked segment${sessions.length === 1 ? "" : "s"}: ${grouped.runs.length} complete run${grouped.runs.length === 1 ? "" : "s"} and ${this.analysisRuns.length - grouped.runs.length} ungrouped segment${this.analysisRuns.length - grouped.runs.length === 1 ? "" : "s"}.`,
      "success",
    );
    this.renderAnalysis();
  }

  renderAnalysis() {
    const selected = this.analysisRuns[this.selectedRun];
    if (!selected) return;
    const { run, analysis } = selected;
    requiredElement(this.document, "analysis-segments").textContent = analysis.segments.map((id) => `#${id}`).join(" → ");
    requiredElement(this.document, "analysis-duration").textContent = formatDuration(analysis.observed_duration_seconds);
    requiredElement(this.document, "analysis-start").textContent = this.startDescription(analysis);
    const warningCount =
      analysis.warnings.length +
      run.sessions.filter((session) => !session.finalized).length +
      analysis.unknown_gap_count +
      (analysis.degraded_sample_count ? 1 : 0) +
      (analysis.rtc_xtal_fallback_observed ? 1 : 0) +
      (run.sessions.some((session) => session.integrity.ignoredTrailingBytes) ? 1 : 0) +
      (selected.isolatedReason ? 1 : 0);
    requiredElement(this.document, "analysis-integrity").textContent = warningCount
      ? `${warningCount} item${warningCount === 1 ? "" : "s"} to review`
      : "CRC-valid and finalized";
    this.renderChart();
    this.renderIntegrity(run, analysis, selected.isolatedReason);
  }

  downloadRunExport(format) {
    const selected = this.analysisRuns[this.selectedRun];
    if (!selected) return;
    const { run } = selected;
    const excel = format === "xlsx";
    const contents = excel ? createRunWorkbook(run) : serializeRunCsv(run);
    const type = excel
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/csv;charset=utf-8";
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = this.document.createElement("a");
    link.href = url;
    link.download = runExportFilename(run, excel ? "xlsx" : "csv");
    link.click();
    this.window.setTimeout(() => URL.revokeObjectURL(url), 0);
    const label = excel ? "Excel workbook" : "CSV file";
    setStatus(this.analysisMessage, `${label} created for the selected run.`, "success");
    this.onActivity(`Created ${label.toLowerCase()} for sessions ${run.sessions.map((session) => session.sessionId).join("->")}`);
  }

  startDescription(analysis) {
    const state = analysis.start_state === "already_hot_or_warming"
      ? "Already hot or warming"
      : analysis.start_state === "below_trigger_at_first_sample"
        ? "Started below 40 °C"
        : "No committed samples";
    const coverage = analysis.pretrigger_coverage === "full"
      ? "full lead-in captured"
      : analysis.pretrigger_coverage === "partial"
        ? "partial lead-in captured"
        : "no lead-in captured";
    return `${state} · ${coverage}`;
  }

  renderProbeTable(analysis) {
    this.probeTable.replaceChildren();
    const selected = Number(this.probeSelect.value);
    for (const probe of analysis.probes) {
      const row = this.document.createElement("tr");
      row.dataset.selected = String(probe.position === selected);
      const name = this.document.createElement("th");
      name.scope = "row";
      name.textContent = `P${probe.position}`;
      const values = [
        `${probe.relative_height_cm < 0 ? "−" : ""}${Math.abs(probe.relative_height_cm)} cm`,
        `${probe.valid_samples} / ${probe.missing_samples}`,
        formatTemperature(probe.maximum_c),
        formatTemperature(probe.mean_c),
        formatDuration(probe.peak_observed_seconds),
        formatDuration(probe.threshold_crossing_observed_seconds["40"]),
        Number.isFinite(probe.minutes_above["80"])
          ? `${probe.minutes_above["80"].toFixed(1)} min`
          : "—",
        formatRate(probe.maximum_heating_rate_c_per_min),
      ];
      row.append(name, ...values.map((value) => {
        const cell = this.document.createElement("td");
        cell.textContent = value;
        return cell;
      }));
      row.addEventListener("click", () => {
        this.probeSelect.value = String(probe.position);
        this.renderChart();
      });
      this.probeTable.append(row);
    }
  }

  renderIntegrity(run, analysis, isolatedReason = "") {
    this.integrityList.replaceChildren();
    const blocks = run.sessions.reduce((sum, session) => sum + session.integrity.validBlockCount, 0);
    const records = run.sessions.reduce((sum, session) => sum + session.integrity.committedRecordCount, 0);
    const ignored = run.sessions.reduce((sum, session) => sum + session.integrity.ignoredTrailingBytes, 0);
    const finalized = run.sessions.filter((session) => session.finalized).length;
    const items = [
      `Header CRC validated for ${run.sessions.length} raw segment${run.sessions.length === 1 ? "" : "s"}.`,
      `${blocks} complete CRC-valid data block${blocks === 1 ? "" : "s"}; ${records} committed sample${records === 1 ? "" : "s"}.`,
      `${finalized} finalized segment${finalized === 1 ? "" : "s"}; ${run.sessions.length - finalized} interrupted segment${run.sessions.length - finalized === 1 ? "" : "s"}.`,
      this.startDescription(analysis) + ".",
    ];
    if (isolatedReason) {
      items.push(`${isolatedReason} This segment is analyzed alone; linked time outside it is excluded.`);
    }
    if (ignored) items.push(`${ignored} trailing byte${ignored === 1 ? " was" : "s were"} ignored after the last complete CRC-valid structure.`);
    if (analysis.unknown_gap_count) {
      items.push(`${analysis.unknown_gap_count} continuation gap${analysis.unknown_gap_count === 1 ? " has" : "s have"} unknown duration. The chart joins neither time nor temperature across them.`);
    }
    if (analysis.degraded_sample_count) {
      items.push(`${analysis.degraded_sample_count} sample${analysis.degraded_sample_count === 1 ? " reports" : "s report"} a degraded mapped-probe set.`);
    }
    if (analysis.rtc_xtal_fallback_observed) {
      items.push("At least one sample reports an RTC crystal fallback; relative sample timing remains the recorded source of truth.");
    }
    items.push(...analysis.warnings);
    for (const text of items) {
      const item = this.document.createElement("li");
      item.textContent = text;
      this.integrityList.append(item);
    }
  }

  renderChart() {
    const selected = this.analysisRuns[this.selectedRun];
    if (!selected) return;
    const { run } = selected;
    this.renderProbeTable(selected.analysis);
    const selectedProbe = Number(this.probeSelect.value) - 1;
    let minimumTemperature = Infinity;
    let maximumTemperature = -Infinity;
    let validTemperatureCount = 0;
    for (const point of run.points) {
      for (const value of point.temperaturesC) {
        if (value === null) continue;
        minimumTemperature = Math.min(minimumTemperature, value);
        maximumTemperature = Math.max(maximumTemperature, value);
        validTemperatureCount += 1;
      }
    }
    this.chart.replaceChildren();
    if (!run.points.length || validTemperatureCount === 0) {
      this.gapNote.hidden = true;
      this.gapNote.textContent = "";
      this.chart.append(this.emptyState("No committed temperature samples are available."));
      return;
    }

    const width = 960;
    const height = 420;
    const margin = { top: 22, right: 24, bottom: 50, left: 58 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    let xMin = Infinity;
    let xMaxRaw = -Infinity;
    for (const point of run.points) {
      if (!Number.isFinite(point.observedSeconds)) continue;
      xMin = Math.min(xMin, point.observedSeconds);
      xMaxRaw = Math.max(xMaxRaw, point.observedSeconds);
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(xMaxRaw)) {
      this.gapNote.hidden = true;
      this.gapNote.textContent = "";
      this.chart.append(this.emptyState("Committed sample timestamps are invalid."));
      return;
    }
    const xMax = xMaxRaw > xMin ? xMaxRaw : xMin + 1;
    let yMin = Math.floor(minimumTemperature / 10) * 10;
    let yMax = Math.ceil(maximumTemperature / 10) * 10;
    if (yMax <= yMin) yMax = yMin + 10;
    const x = (value) => margin.left + ((value - xMin) / (xMax - xMin)) * plotWidth;
    const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
    const svg = svgElement(this.document, "svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-labelledby": "timeline-title timeline-description",
    });
    const title = svgElement(this.document, "title", { id: "timeline-title" });
    title.textContent = `Eight probe temperature timeline, P${selectedProbe + 1} highlighted`;
    const description = svgElement(this.document, "desc", { id: "timeline-description" });
    description.textContent = `${run.points.length} committed observations. ${run.breaks.length} unknown-duration continuation gap${run.breaks.length === 1 ? "" : "s"} reported; no line crosses a gap.`;
    svg.append(title, description);

    const grid = svgElement(this.document, "g", { class: "timeline__grid", "aria-hidden": "true" });
    for (let tick = 0; tick <= 4; tick += 1) {
      const temperature = yMin + ((yMax - yMin) * tick) / 4;
      const yy = y(temperature);
      grid.append(svgElement(this.document, "line", { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy }));
      const label = svgElement(this.document, "text", { x: margin.left - 10, y: yy + 4, "text-anchor": "end" });
      label.textContent = `${Math.round(temperature)} °C`;
      grid.append(label);
    }
    for (let tick = 0; tick <= 4; tick += 1) {
      const seconds = xMin + ((xMax - xMin) * tick) / 4;
      const xx = x(seconds);
      grid.append(svgElement(this.document, "line", { x1: xx, y1: margin.top, x2: xx, y2: height - margin.bottom }));
      const label = svgElement(this.document, "text", { x: xx, y: height - 23, "text-anchor": "middle" });
      label.textContent = formatDuration(seconds);
      grid.append(label);
    }
    const axisLabel = svgElement(this.document, "text", { x: margin.left + plotWidth / 2, y: height - 3, "text-anchor": "middle" });
    axisLabel.textContent = "Observed time (unknown continuation duration excluded)";
    grid.append(axisLabel);
    svg.append(grid);

    const traces = svgElement(this.document, "g", { class: "timeline__traces", "aria-hidden": "true" });
    const order = [...Array(8).keys()].filter((probe) => probe !== selectedProbe).concat(selectedProbe);
    for (const probe of order) {
      for (const piece of buildProbeSeries(run, probe)) {
        if (piece.length === 1) {
          traces.append(svgElement(this.document, "circle", {
            class: "timeline__trace",
            "data-selected": String(probe === selectedProbe),
            cx: x(piece[0].observedSeconds).toFixed(2),
            cy: y(piece[0].temperatureC).toFixed(2),
            r: 2.5,
          }));
          continue;
        }
        const path = svgElement(this.document, "path", {
          class: "timeline__trace",
          "data-selected": String(probe === selectedProbe),
          d: piece.map((point, index) => `${index ? "L" : "M"}${x(point.observedSeconds).toFixed(2)},${y(point.temperatureC).toFixed(2)}`).join(" "),
        });
        traces.append(path);
      }
    }
    svg.append(traces);

    const gaps = svgElement(this.document, "g", { class: "timeline__gaps", "aria-hidden": "true" });
    run.breaks.filter((gap) => Number.isFinite(gap.observedSeconds)).forEach((gap, index) => {
      const xx = x(gap.observedSeconds);
      gaps.append(svgElement(this.document, "line", { x1: xx, y1: margin.top, x2: xx, y2: height - margin.bottom }));
      const label = svgElement(this.document, "text", { x: xx + 5, y: margin.top + 13 + (index % 3) * 14 });
      label.textContent = "Unknown continuation gap";
      gaps.append(label);
    });
    svg.append(gaps);
    this.chart.append(svg);

    this.gapNote.hidden = run.breaks.length === 0;
    this.gapNote.textContent = run.breaks.length
      ? `${run.breaks.length} continuation boundar${run.breaks.length === 1 ? "y has" : "ies have"} unknown duration and is excluded from observed time. A vertical marker is shown wherever the boundary can be placed.`
      : "";
  }
}
