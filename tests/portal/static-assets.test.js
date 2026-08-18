import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const portalRoot = path.join(repositoryRoot, "portal");

async function appShell() {
  const source = await readFile(
    path.join(portalRoot, "service-worker.js"),
    "utf8",
  );
  const shellBlock = source.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellBlock, "service worker must declare APP_SHELL");
  const assets = [...shellBlock[1].matchAll(/"(\.\/[^\"]*)"/g)].map(
    (match) => match[1],
  );
  return { source, assets };
}

test("every precached portal asset exists", async () => {
  const { assets: assetNames } = await appShell();
  assert.ok(assetNames.includes("./index.html"));
  assert.ok(assetNames.includes("./js/app.js"));

  for (const name of assetNames) {
    if (name === "./") continue;
    const asset = await stat(path.join(portalRoot, name.slice(2)));
    assert.ok(asset.isFile(), `${name} must be a file`);
  }
});

test("HTML and module dependencies are available in the offline shell", async () => {
  const { assets } = await appShell();
  const cached = new Set(assets);
  const html = await readFile(path.join(portalRoot, "index.html"), "utf8");
  const linked = [...html.matchAll(/(?:src|href)=["'](\.\/[^"']+)["']/g)].map(
    (match) => match[1],
  );
  for (const name of linked) {
    assert.ok(cached.has(name), `${name} must be precached`);
  }

  const pending = ["./js/app.js"];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    assert.ok(cached.has(name), `${name} must be precached`);
    const source = await readFile(path.join(portalRoot, name.slice(2)), "utf8");
    for (const match of source.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) {
      const resolved = `./${path.posix.normalize(
        path.posix.join(path.posix.dirname(name.slice(2)), match[1]),
      )}`;
      pending.push(resolved);
    }
  }

  const manifest = JSON.parse(
    await readFile(path.join(portalRoot, "manifest.webmanifest"), "utf8"),
  );
  for (const icon of manifest.icons ?? []) {
    assert.ok(cached.has(icon.src), `${icon.src} must be precached`);
  }
});

test("the portal has no third-party runtime assets", async () => {
  const html = await readFile(path.join(portalRoot, "index.html"), "utf8");
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//i);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /\.\/js\/app\.js/);
  assert.match(html, /\.\/styles\.css/);

  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.equal(new Set(ids).size, ids.length, "HTML ids must be unique");
  assert.match(html, /id="task-title" tabindex="-1"/);
  assert.match(html, /id="transaction-notice"[\s\S]*?role="status"/);
  assert.match(html, /<summary>Advanced mode<\/summary>/);
  assert.match(html, /id="copy-transcript"/);
  assert.match(html, /id="download-diagnostics"/);
  assert.match(html, /id="clear-transcript"/);
  assert.match(
    html,
    /id="install-progress-detail"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"/,
  );
  assert.match(html, /free-form terminal[\s\S]*?not provided in this release/i);
  assert.match(html, /probe ROM addresses[\s\S]*?Review it before sharing/i);
  assert.doesNotMatch(html, /<input\b|<textarea\b/i);
  assert.doesNotMatch(html, /type=["']file["']/i);
});

test("persisted flash recovery stays locked to the prepared package", async () => {
  const source = await readFile(
    path.join(portalRoot, "js/flash-ui.js"),
    "utf8",
  );
  const store = await readFile(
    path.join(portalRoot, "js/recovery-store.js"),
    "utf8",
  );
  const app = await readFile(path.join(portalRoot, "js/app.js"), "utf8");
  assert.match(
    source,
    /this\.prepared = await this\.controller\.prepare[\s\S]*?this\.controller\.markRecoveryRequired\([\s\S]*?this\.recovery\.packageSha256,[\s\S]*?this\.recovery\.deviceIdHash/,
  );
  assert.match(
    source,
    /if \(!this\.controller\?\.snapshot\.canCancel \|\| this\.busy\) return;/,
  );
  assert.match(source, /hidden: recovering/);
  assert.match(
    source,
    /await this\.recoveryStore\.beginWrite\([\s\S]*?await this\.controller\.flash\(/,
    "the recovery package and marker must persist before the controller can write",
  );
  assert.match(
    source,
    /await this\.recoveryStore\.acquireLifecycleIfAvailable\(\);[\s\S]*?await this\.recoveryStore\.beginWrite\([\s\S]*?await this\.controller\.flash\(/,
    "the origin-wide lifecycle lock must be held before marker creation and writing",
  );
  assert.match(
    source,
    /if \(this\.recovery\) \{[\s\S]*?acquireLifecycleIfAvailable\(\)[\s\S]*?restoreOrRepairRecoveryPackage\([\s\S]*?this\.controller\.prepare\(/,
    "recovered flows must acquire ownership and repair only before a chooser is shown",
  );
  assert.match(
    source,
    /await this\.controller\.cancel\(\);[\s\S]*?this\.controller = null;[\s\S]*?await this\.#preparePackage\(\);/,
    "a canceled controller must be rebuilt before another chooser is enabled",
  );
  assert.doesNotMatch(source, /removeItem\(|storageRemove\(/);
  assert.match(store, /phase:\s*RecoveryPhase\.VERIFICATION_REQUIRED/);
  assert.match(
    app,
    /verifyInstalledFirmware\(controller\.snapshot\.deviceInfo\);[\s\S]*?await flashUi\.completeRunningFirmwareVerification/,
  );
  assert.match(store, /RECOVERY_PACKAGE_CACHE_PREFIX\s*=\s*\n?\s*"sauna-firmware-recovery-v1-"/);
  assert.match(store, /RECOVERY_LIFECYCLE_LOCK/);
  assert.match(store, /\{ mode: "exclusive", ifAvailable: true \}/);
  assert.match(
    store,
    /async beginReplacementWrite\([\s\S]*?previous\.phase !== RecoveryPhase\.VERIFICATION_REQUIRED[\s\S]*?connectedDeviceIdHash !== previous\.deviceIdHash[\s\S]*?restorePreparedPackage\(packageSha256\)[\s\S]*?phase: RecoveryPhase\.WRITE_REQUIRED/,
    "only an exact same-device post-write verification may advance to a replacement write",
  );
  assert.match(
    source,
    /async prepareCurrentFirmwareReplacement\(\)[\s\S]*?downloadCurrentFirmwarePackage\(\)[\s\S]*?persistPreparedPackage\(downloaded\)[\s\S]*?this\.verificationReplacement = verificationMarker/,
    "the current package must be validated and cached without replacing the old marker",
  );
  assert.match(
    source,
    /await this\.controller\.connect\(\);[\s\S]*?this\.controller\.snapshot\.deviceIdHash !==[\s\S]*?this\.verificationReplacement\.deviceIdHash/,
    "replacement must identify the original bootloader before confirmation",
  );
  assert.match(
    source,
    /beforeWrite: verificationReplacement[\s\S]*?beginReplacementWrite\([\s\S]*?this\.verificationReplacement = null/,
    "the durable marker advances only in the controller's final pre-write gate",
  );
  assert.match(
    source,
    /const replacingVerification = Boolean\(this\.verificationReplacement\);[\s\S]*?await this\.controller\.cancel\(\);[\s\S]*?if \(!replacingVerification\) \{[\s\S]*?releaseLifecycle\(\)[\s\S]*?this\.verificationReplacement = null[\s\S]*?await this\.#preparePackage\(\)/,
    "canceling a same-logger replacement must preserve the old marker and lifecycle lock",
  );
  assert.match(
    app,
    /error instanceof ProtocolError[\s\S]*?error\.code === LEGACY_INCOMPATIBLE_FIRMWARE[\s\S]*?prepareCurrentFirmwareReplacement\(\)/,
    "only the stable legacy/incompatible error enables the replacement UX",
  );
});

test("the pinned esptool-js runtime is precached and unchanged", async () => {
  const bundleName = "./vendor/esptool-js-0.6.0.js";
  const expectedSha256 =
    "7c361337d5bba7271cb0d9741f165a3b87137ff9284c13f112a6e197c48cd0da";
  const { assets } = await appShell();
  assert.ok(assets.includes(bundleName), `${bundleName} must be precached`);

  const bundle = await readFile(path.join(portalRoot, bundleName.slice(2)));
  assert.equal(createHash("sha256").update(bundle).digest("hex"), expectedSha256);

  const provenance = await readFile(
    path.join(portalRoot, "vendor/README.md"),
    "utf8",
  );
  assert.match(provenance, new RegExp(expectedSha256));
  assert.match(provenance, /esptool-js@0\.6\.0/);
});

test("the visual system globally removes rounded corners", async () => {
  const css = await readFile(path.join(portalRoot, "styles.css"), "utf8");
  assert.match(css, /border-radius:\s*0\s*!important/);
  const values = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map(
    (match) => match[1].replace(/\s*!important\s*$/, "").trim(),
  );
  assert.ok(values.length > 0);
  assert.deepEqual(new Set(values), new Set(["0"]));
  assert.doesNotMatch(css, /box-shadow\s*:/);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/);
});

test("manifest colors and service-worker cache use the portal release tokens", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(portalRoot, "manifest.webmanifest"), "utf8"),
  );
  assert.equal(manifest.background_color, "#f3f3f0");
  assert.equal(manifest.theme_color, "#171717");

  const { source: worker, assets } = await appShell();
  const declaredRevision = worker.match(
    /const APP_SHELL_REVISION = "([0-9a-f]{12})"/,
  );
  assert.ok(declaredRevision, "service worker must declare a content revision");
  const digest = createHash("sha256");
  for (const name of assets.filter((asset) => asset !== "./").sort()) {
    digest.update(`${name}\0`);
    digest.update(await readFile(path.join(portalRoot, name.slice(2))));
  }
  assert.equal(declaredRevision[1], digest.digest("hex").slice(0, 12));
  assert.match(worker, /cache\.match\(request\)/);
  assert.doesNotMatch(worker, /caches\.match\(request\)/);
  assert.match(
    worker,
    /url\.href\.startsWith\(FIRMWARE_ROOT\)[\s\S]*?event\.respondWith\(fetch\(request\)\);[\s\S]*?return;/,
    "published firmware must bypass the mutable app-shell cache",
  );
});
