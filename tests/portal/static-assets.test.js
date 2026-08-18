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
});
