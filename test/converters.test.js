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

test("converts Claude structured and sniffed artifact formats", async () => {
  const code = convertAgentArtifact({
    agent: "claude",
    content: await readFile("test/fixtures/claude-code.json", "utf8")
  });
  assert.equal(code.format, "code");
  assert.equal(code.artifactType, "snippet");
  assert.equal(code.metadata.artifactyImport.contentType, "application/vnd.ant.code");
  assert.equal(code.metadata.language, "javascript");

  const svg = convertAgentArtifact({
    agent: "claude",
    fileName: "claude-diagram.svg",
    content: await readFile("test/fixtures/claude-diagram.svg", "utf8")
  });
  assert.equal(svg.format, "svg");
  assert.equal(svg.artifactType, "diagram");

  const mermaid = convertAgentArtifact({
    agent: "claude",
    fileName: "claude-flow.mmd",
    content: await readFile("test/fixtures/claude-flow.mmd", "utf8")
  });
  assert.equal(mermaid.format, "mermaid");
  assert.equal(mermaid.artifactType, "diagram");

  const react = convertAgentArtifact({
    agent: "claude",
    content: await readFile("test/fixtures/claude-react.json", "utf8")
  });
  assert.equal(react.format, "react");
  assert.equal(react.artifactType, "component");
  assert.equal(react.metadata.language, "tsx");
});

test("converts SARIF and CSV output artifacts", () => {
  const sarifContent = JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "CodeQL",
            rules: [
              { id: "js/path-injection", shortDescription: { text: "Path injection" } }
            ]
          }
        },
        results: [
          {
            ruleId: "js/path-injection",
            level: "warning",
            message: { text: "Validate the path before use." },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/app.js" },
                  region: { startLine: 42, startColumn: 7 }
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const sarifFile = convertAgentArtifact({
    agent: "codex",
    fileName: "codeql-results.sarif",
    content: sarifContent
  });
  assert.equal(sarifFile.format, "sarif");
  assert.equal(sarifFile.contentType, "application/sarif+json; charset=utf-8");
  assert.equal(sarifFile.artifactType, "analysis-report");

  const sarifMime = convertAgentArtifact({
    agent: "generic",
    contentType: "application/sarif+json",
    content: sarifContent
  });
  assert.equal(sarifMime.format, "sarif");
  assert.equal(sarifMime.artifactType, "analysis-report");

  const sarifObject = convertAgentArtifact({
    agent: "auto",
    payload: JSON.parse(sarifContent)
  });
  assert.equal(sarifObject.format, "sarif");
  assert.equal(sarifObject.metadata.originalPayloadShape, "sarif");

  const findingsCsv = convertAgentArtifact({
    agent: "codex",
    fileName: "security-findings.csv",
    content: "severity,file,message\nwarning,src/app.js,\"Validate, then open\""
  });
  assert.equal(findingsCsv.format, "csv");
  assert.equal(findingsCsv.contentType, "text/csv; charset=utf-8");
  assert.equal(findingsCsv.artifactType, "analysis-report");

  const plainCsv = convertAgentArtifact({
    agent: "generic",
    contentType: "text/csv",
    content: "name,count\nCodex,2\nArtifacty,10"
  });
  assert.equal(plainCsv.format, "csv");
  assert.equal(plainCsv.artifactType, "table");
});

test("preserves explicit Codex continuation artifact types", async () => {
  for (const [fixture, artifactType] of [
    ["test/fixtures/codex-diff.json", "diff-walkthrough"],
    ["test/fixtures/codex-review.json", "code-review"],
    ["test/fixtures/codex-test-report.json", "test-report"]
  ]) {
    const converted = convertAgentArtifact({
      agent: "codex",
      content: await readFile(fixture, "utf8")
    });
    assert.equal(converted.sourceAgent, "codex");
    assert.equal(converted.artifactType, artifactType);
    assert.equal(converted.format, "markdown");
  }
});

test("converts structured Codex continuation payloads to markdown artifacts", async () => {
  const handoff = convertAgentArtifact({
    agent: "auto",
    content: await readFile("test/fixtures/codex-structured-handoff.json", "utf8")
  });
  assert.equal(handoff.sourceAgent, "codex");
  assert.equal(handoff.artifactType, "handoff");
  assert.equal(handoff.format, "markdown");
  assert.match(handoff.content, /## Changed Files/);
  assert.match(handoff.content, /src\/lib\/converters\.js/);
  assert.match(handoff.content, /## Next Steps/);
  assert.equal(handoff.metadata.originalPayloadShape, "codex-continuation");
  assert.equal(handoff.metadata.codexContinuation.changedFiles[0].path, "src/lib/converters.js");
  assert.equal(handoff.metadata.codexContinuation.commands[0].status, "passed");

  const review = convertAgentArtifact({
    agent: "auto",
    content: await readFile("test/fixtures/codex-structured-review.json", "utf8")
  });
  assert.equal(review.artifactType, "code-review");
  assert.match(review.content, /## Findings/);
  assert.equal(review.metadata.codexContinuation.findings[0].severity, "low");

  const verification = convertAgentArtifact({
    agent: "auto",
    content: await readFile("test/fixtures/codex-structured-verification.json", "utf8")
  });
  assert.equal(verification.artifactType, "test-report");
  assert.match(verification.content, /## Tests/);
  assert.equal(verification.metadata.codexContinuation.testStatus, "passed");
  assert.equal(verification.metadata.codexContinuation.tests[0].status, "passed");

  const argumentScoped = convertAgentArtifact({
    agent: "codex",
    payload: {
      title: "Argument Scoped Handoff",
      summary: "Agent is supplied by the converter call, not the payload.",
      nextSteps: ["Continue Phase 3."]
    }
  });
  assert.equal(argumentScoped.artifactType, "handoff");
  assert.equal(argumentScoped.metadata.codexContinuation.nextSteps[0], "Continue Phase 3.");
});

test("preserves Codex continuation metadata in file bundles", async () => {
  const converted = convertAgentArtifact({
    agent: "auto",
    content: await readFile("test/fixtures/codex-bundle-metadata.json", "utf8")
  });
  const bundle = JSON.parse(converted.content);

  assert.equal(converted.sourceAgent, "codex");
  assert.equal(converted.artifactType, "bundle");
  assert.equal(bundle.files.length, 2);
  assert.equal(bundle.codexContinuation.changedFiles[0].path, "README.md");
  assert.equal(converted.metadata.codexContinuation.tests[0].command, "npm test");
  assert.equal(converted.metadata.codexContinuation.nextSteps[0], "Render code artifacts with CodeMirror.");
});

test("does not infer Codex continuation type from plain Markdown", () => {
  const converted = convertAgentArtifact({
    agent: "codex",
    content: "# Notes\n\n- This is just a Markdown note."
  });

  assert.equal(converted.sourceAgent, "codex");
  assert.equal(converted.format, "markdown");
  assert.equal(converted.artifactType, "document");
  assert.equal(converted.metadata.originalPayloadShape, undefined);
});

test("converts GitHub Copilot structured artifacts", () => {
  const review = convertAgentArtifact({
    agent: "github-copilot",
    payload: {
      title: "Copilot PR Review",
      findings: [
        { severity: "medium", file: "src/app.js", line: 42, title: "Handle missing state" }
      ],
      nextSteps: ["Patch the null state path."]
    }
  });

  assert.equal(review.sourceAgent, "copilot");
  assert.equal(review.artifactType, "code-review");
  assert.equal(review.format, "markdown");
  assert.match(review.content, /Source: GitHub Copilot/);
  assert.match(review.content, /## Findings/);
  assert.equal(review.metadata.originalPayloadShape, "copilot-continuation");
  assert.equal(review.metadata.continuation.findings[0].file, "src/app.js");
  assert.equal(review.metadata.copilotContinuation.nextSteps[0], "Patch the null state path.");
});

test("converts Cursor structured artifacts", () => {
  const handoff = convertAgentArtifact({
    agent: "auto",
    payload: {
      sourceAgent: "cursor",
      title: "Cursor Handoff",
      summary: "Editor agent finished the first pass.",
      changedFiles: [
        { path: "README.md", status: "modified" }
      ],
      commands: [
        { command: "npm test", status: "passed" }
      ],
      nextSteps: ["Run visual QA."]
    }
  });

  assert.equal(handoff.sourceAgent, "cursor");
  assert.equal(handoff.artifactType, "handoff");
  assert.equal(handoff.format, "markdown");
  assert.match(handoff.content, /Source: Cursor/);
  assert.equal(handoff.metadata.originalPayloadShape, "cursor-continuation");
  assert.equal(handoff.metadata.continuation.changedFiles[0].path, "README.md");
  assert.equal(handoff.metadata.cursorContinuation.commands[0].command, "npm test");
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

test("converts fenced Gemini JSON displays as JSON content", () => {
  const converted = convertAgentArtifact({
    agent: "auto",
    payload: {
      title: "Structured result",
      returnDisplay: "```json\n{\"status\":\"ok\",\"count\":2}\n```"
    }
  });

  assert.equal(converted.sourceAgent, "gemini");
  assert.equal(converted.format, "json");
  assert.equal(converted.content, "{\"status\":\"ok\",\"count\":2}");
  assert.equal(converted.metadata.originalPayloadShape, "gemini-returnDisplay");
});

test("converts mixed content blocks without dropping text parts", () => {
  const converted = convertAgentArtifact({
    agent: "auto",
    payload: {
      agent: "claude",
      title: "Block report",
      content: [
        { type: "text", value: "# Block report" },
        { text: "- finding one" },
        { content: "- finding two" },
        { type: "image", data: "ignored" }
      ],
      tags: ["review"]
    }
  });

  assert.equal(converted.sourceAgent, "claude");
  assert.equal(converted.format, "markdown");
  assert.equal(converted.content, "# Block report\n\n- finding one\n\n- finding two");
  assert.equal(converted.metadata.originalPayloadShape, "content-blocks");
  assert.equal(converted.metadata.partCount, 4);
  assert.ok(converted.tags.includes("review"));
});

test("preserves invalid JSON-looking text without parsing metadata", () => {
  const converted = convertAgentArtifact({
    agent: "generic",
    fileName: "broken.json",
    content: "{\"title\":\"Broken\",\"content\":}"
  });

  assert.equal(converted.sourceAgent, "generic");
  assert.equal(converted.format, "json");
  assert.equal(converted.content, "{\"title\":\"Broken\",\"content\":}");
  assert.equal(converted.metadata.originalPayloadShape, undefined);
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
