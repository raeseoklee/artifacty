import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { convertAgentArtifact } from "../src/lib/converters.js";

test("converts Claude HTML artifact files", () => {
  const converted = convertAgentArtifact({
    agent: "claude",
    fileName: "deploy-failures.html",
    content: "<!doctype html><html><head><title>Deploy failures</title></head><body><h1>Ignored</h1></body></html>"
  });

  assert.equal(converted.title, "Deploy failures");
  assert.equal(converted.format, "html");
  assert.equal(converted.sourceAgent, "claude");
  assert.ok(converted.tags.includes("imported"));
  assert.ok(converted.tags.includes("claude"));
  assert.equal(converted.metadata.artifactyImport.fileName, "deploy-failures.html");
});

test("converts fixture-based agent artifacts", async () => {
  const claudeHtml = await readFile("test/fixtures/claude-artifact.html", "utf8");
  const claude = convertAgentArtifact({
    agent: "claude",
    fileName: "claude-artifact.html",
    content: claudeHtml
  });
  assert.equal(claude.title, "Claude Findings");
  assert.equal(claude.artifactType, "html-page");

  const codexJson = await readFile("test/fixtures/codex-handoff.json", "utf8");
  const codex = convertAgentArtifact({
    agent: "auto",
    content: codexJson
  });
  assert.equal(codex.title, "Codex Handoff");
  assert.equal(codex.artifactType, "handoff");
});

test("converts Gemini returnDisplay payloads", () => {
  const converted = convertAgentArtifact({
    agent: "gemini",
    payload: {
      returnDisplay: "# Gemini plan\n\n- Step one",
      title: "Plan candidate"
    },
    tags: ["plan"]
  });

  assert.equal(converted.title, "Plan candidate");
  assert.equal(converted.format, "markdown");
  assert.equal(converted.content, "# Gemini plan\n\n- Step one");
  assert.equal(converted.sourceAgent, "gemini");
  assert.ok(converted.tags.includes("plan"));
});

test("converts Gemini multimodal payloads into bundle artifacts", async () => {
  const payload = JSON.parse(await readFile("test/fixtures/gemini-multimodal.json", "utf8"));
  const converted = convertAgentArtifact({
    agent: "gemini",
    payload
  });
  const bundle = JSON.parse(converted.content);

  assert.equal(converted.artifactType, "bundle");
  assert.equal(converted.format, "json");
  assert.equal(bundle.assets.length, 1);
  assert.equal(bundle.assets[0].mimeType, "image/png");
  assert.equal(bundle.parts[1].type, "asset-ref");
  assert.equal(converted.metadata.assetPolicy, "base64-assets-stored-inline-in-bundle-json");
});

test("converts file bundles into Artifacty bundle JSON", () => {
  const converted = convertAgentArtifact({
    agent: "codex",
    payload: {
      title: "Patch bundle",
      files: [
        { path: "README.md", content: "# Readme" },
        { path: "src/app.js", content: "console.log('ok');" }
      ]
    }
  });
  const bundle = JSON.parse(converted.content);

  assert.equal(converted.artifactType, "bundle");
  assert.equal(bundle.files.length, 2);
  assert.equal(bundle.files[0].path, "README.md");
});

test("converts Artifacty-compatible JSON payloads", () => {
  const converted = convertAgentArtifact({
    agent: "auto",
    content: JSON.stringify({
      title: "Codex handoff",
      content: "# Handoff",
      format: "markdown",
      sourceAgent: "codex",
      tags: ["handoff"]
    })
  });

  assert.equal(converted.title, "Codex handoff");
  assert.equal(converted.format, "markdown");
  assert.equal(converted.content, "# Handoff");
  assert.equal(converted.sourceAgent, "codex");
  assert.equal(converted.schemaVersion, 1);
  assert.ok(converted.tags.includes("handoff"));
});
