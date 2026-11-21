import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { REACT_BUNDLE_BANNER, REACT_BUNDLE_FILE, buildReactBundle } from "../scripts/build-react.mjs";

const root = path.resolve(import.meta.dirname, "..");
const installed = existsSync(path.join(root, "node_modules", "react", "package.json"));

test("committed React bundle declares a React 19 version that package.json allows", async () => {
  const bundle = await readFile(REACT_BUNDLE_FILE, "utf8");
  const banner = REACT_BUNDLE_BANNER.exec(bundle.split("\n")[0]);
  assert.ok(banner, "bundle must start with the artifacty version banner");
  assert.match(banner[1], /^19\./);
  assert.equal(banner[2], banner[1], "react and react-dom versions must match");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.match(manifest.optionalDependencies.react, /^\^19\./);
  assert.match(manifest.optionalDependencies["react-dom"], /^\^19\./);
  assert.equal(manifest.dependencies?.react, undefined, "react stays optional");
});

test("committed React bundle matches the installed react version", { skip: !installed && "react is an optional dependency and is not installed" }, async () => {
  const bundle = await readFile(REACT_BUNDLE_FILE, "utf8");
  const banner = REACT_BUNDLE_BANNER.exec(bundle.split("\n")[0]);
  const { version } = JSON.parse(await readFile(path.join(root, "node_modules", "react", "package.json"), "utf8"));
  assert.equal(banner[1], version, "bundle is stale: run npm run build:react");
  assert.equal(bundle, await buildReactBundle(), "bundle content is stale: run npm run build:react");
});

test("React bundle runs as a classic script and exposes React and ReactDOM", async () => {
  const sandbox = { window: {}, console, setTimeout, clearTimeout };
  vm.runInNewContext(await readFile(REACT_BUNDLE_FILE, "utf8"), sandbox);
  const { React, ReactDOM } = sandbox.window;
  assert.match(React.version, /^19\./);
  assert.equal(typeof React.useState, "function");
  assert.equal(typeof ReactDOM.createRoot, "function");
  assert.equal(typeof ReactDOM.createPortal, "function");
});
