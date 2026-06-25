import path from "node:path";
import { createHash } from "node:crypto";
import { ARTIFACT_TYPES, contentTypeForFormat, normalizeFormat } from "./storage.js";

const CONTINUATION_AGENTS = new Set(["codex", "copilot", "cursor"]);
const KNOWN_AGENTS = new Set(["auto", "artifacty", "claude", "codex", "copilot", "cursor", "gemini", "generic"]);

export function convertAgentArtifact(input = {}) {
  const originalAgent = normalizeAgent(input.agent || input.sourceAgent || input.source_agent || "auto");
  const payload = input.payload ?? input.content ?? "";
  const parsed = parsePayload(payload);
  const decoded = decodePayload(parsed, originalAgent);
  const sourcePath = optionalString(input.sourcePath || input.path || input.file);
  const fileName = optionalString(input.fileName || input.filename || (sourcePath ? path.basename(sourcePath) : ""));
  const explicitContentType = optionalString(input.contentType || input.mimeType || input.mime_type);
  const content = String(decoded.content ?? input.content ?? payload ?? "");
  const format = normalizeFormat(
    input.format ||
      decoded.format ||
      detectFormat({ content, contentType: explicitContentType || decoded.contentType, fileName })
  );
  const sourceAgent = optionalString(input.sourceAgent || input.source_agent || decoded.sourceAgent) ||
    (originalAgent === "auto" ? detectAgent(parsed, fileName) : originalAgent);

  const title =
    optionalString(input.title) ||
    optionalString(decoded.title) ||
    inferTitle({ content, format, fileName, sourceAgent });

  const contentType = explicitContentType || decoded.contentType || contentTypeForFormat(format);
  const artifactType = normalizeArtifactType(
    input.artifactType ||
      input.artifact_type ||
      decoded.artifactType ||
      inferArtifactType({ format, content, fileName, metadata: decoded.metadata })
  );
  const tags = uniqueStrings([
    "imported",
    sourceAgent,
    ...normalizeTags(decoded.tags),
    ...normalizeTags(input.tags)
  ]);

  return {
    title,
    content,
    format,
    contentType,
    artifactType,
    schemaVersion: 1,
    sourceAgent,
    tags,
    metadata: {
      ...normalizeMetadata(decoded.metadata),
      ...normalizeMetadata(input.metadata),
      artifactyImport: {
        converter: "agent-artifact-v1",
        originalAgent,
        sourceAgent,
        fileName: fileName || undefined,
        sourcePath: sourcePath || undefined,
        contentType,
        artifactType,
        convertedAt: new Date().toISOString()
      }
    }
  };
}

export function detectFormat({ content = "", contentType = "", fileName = "" } = {}) {
  const type = optionalString(contentType).toLowerCase();
  if (type.includes("vnd.ant.code") || type.includes("source-code")) {
    return "code";
  }
  if (type.includes("sarif")) {
    return "sarif";
  }
  if (type.includes("csv")) {
    return "csv";
  }
  if (type.includes("svg")) {
    return "svg";
  }
  if (type.includes("vnd.ant.mermaid") || type.includes("mermaid")) {
    return "mermaid";
  }
  if (type.includes("vnd.ant.react") || type.includes("jsx")) {
    return "react";
  }
  if (type.includes("html")) {
    return "html";
  }
  if (type.includes("markdown")) {
    return "markdown";
  }
  if (type.includes("json")) {
    return "json";
  }
  if (type.startsWith("text/")) {
    return "text";
  }

  const lowerName = optionalString(fileName).toLowerCase();
  if (lowerName.endsWith(".sarif") || lowerName.endsWith(".sarif.json")) {
    return "sarif";
  }
  if (lowerName.endsWith(".csv")) {
    return "csv";
  }

  const extension = path.extname(lowerName);
  if (extension === ".html" || extension === ".htm") {
    return "html";
  }
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".svg") {
    return "svg";
  }
  if (extension === ".mmd" || extension === ".mermaid") {
    return "mermaid";
  }
  if (extension === ".jsx" || extension === ".tsx") {
    return "react";
  }
  if (isCodeExtension(extension)) {
    return "code";
  }
  if (extension === ".txt" || extension === ".log") {
    return "text";
  }

  const trimmed = optionalString(content);
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(trimmed)) {
    return "svg";
  }
  if (looksLikeMermaid(trimmed)) {
    return "mermaid";
  }
  if (looksLikeReact(trimmed)) {
    return "react";
  }
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return "html";
  }
  if (looksLikeSarif(trimmed)) {
    return "sarif";
  }
  if (looksLikeJson(trimmed)) {
    return "json";
  }
  if (looksLikeCsv(trimmed)) {
    return "csv";
  }
  if (/^#{1,3}\s+\S/m.test(trimmed) || /^[-*]\s+\S/m.test(trimmed)) {
    return "markdown";
  }
  return "text";
}

function decodePayload(parsed, agent) {
  if (parsed.kind === "json" && parsed.value && typeof parsed.value === "object") {
    return decodeObjectPayload(parsed.value, agent);
  }

  return {
    content: parsed.text,
    format: undefined,
    contentType: undefined,
    title: undefined,
    sourceAgent: agent === "auto" ? undefined : agent,
    tags: [],
    metadata: {}
  };
}

function decodeObjectPayload(value, agent) {
  const artifactObject = value.artifact && typeof value.artifact === "object" ? value.artifact : value;

  if (Array.isArray(artifactObject.files) || artifactObject.bundle) {
    return decodeBundlePayload(artifactObject, agent);
  }

  const continuation = decodeContinuationPayload(artifactObject, agent);
  if (continuation) {
    return continuation;
  }

  if (isSarifObject(artifactObject)) {
    return {
      content: JSON.stringify(artifactObject, null, 2),
      format: "sarif",
      contentType: "application/sarif+json; charset=utf-8",
      title: artifactObject.title || artifactObject.name || "SARIF report",
      sourceAgent: artifactObject.sourceAgent || artifactObject.source_agent || artifactObject.agent || (agent === "auto" ? undefined : agent),
      artifactType: artifactObject.artifactType || artifactObject.artifact_type || "analysis-report",
      tags: artifactObject.tags,
      metadata: {
        originalPayloadShape: "sarif"
      }
    };
  }

  if (typeof artifactObject.content === "string" && !Array.isArray(artifactObject.content)) {
    const sourceContentType = artifactObject.contentType ||
      artifactObject.content_type ||
      artifactObject.mimeType ||
      artifactObject.mime_type ||
      artifactObject.type;
    return {
      content: artifactObject.content,
      format: safeFormat(artifactObject.format || sourceContentType),
      contentType: sourceContentType,
      title: artifactObject.title || artifactObject.name,
      sourceAgent: artifactObject.sourceAgent || artifactObject.source_agent || artifactObject.agent,
      artifactType: artifactObject.artifactType || artifactObject.artifact_type,
      tags: artifactObject.tags,
      metadata: {
        originalPayloadShape: "content",
        originalId: artifactObject.id,
        originalContentType: sourceContentType,
        language: artifactObject.language
      }
    };
  }

  if (typeof artifactObject.code === "string") {
    return objectContent(artifactObject, "code", artifactObject.code, "code");
  }

  if (typeof artifactObject.svg === "string") {
    return objectContent(artifactObject, "svg", artifactObject.svg, "svg");
  }

  if (typeof artifactObject.mermaid === "string") {
    return objectContent(artifactObject, "mermaid", artifactObject.mermaid, "mermaid");
  }

  if (typeof artifactObject.react === "string" || typeof artifactObject.jsx === "string") {
    return objectContent(artifactObject, "react", artifactObject.react || artifactObject.jsx, "react");
  }

  if (typeof artifactObject.sarif === "string") {
    return objectContent(artifactObject, "sarif", artifactObject.sarif, "sarif");
  }

  if (typeof artifactObject.csv === "string") {
    return objectContent(artifactObject, "csv", artifactObject.csv, "csv");
  }

  if (typeof artifactObject.html === "string") {
    return objectContent(artifactObject, "html", artifactObject.html, "html");
  }

  if (typeof artifactObject.markdown === "string") {
    return objectContent(artifactObject, "markdown", artifactObject.markdown, "markdown");
  }

  if (typeof artifactObject.text === "string") {
    return objectContent(artifactObject, "text", artifactObject.text, "text");
  }

  if (typeof artifactObject.returnDisplay === "string") {
    const content = stripMarkdownCodeFence(artifactObject.returnDisplay);
    return {
      content,
      format: detectFormat({ content }) === "json" ? "json" : "markdown",
      title: artifactObject.title || artifactObject.name || "Gemini artifact",
      sourceAgent: agent === "auto" ? "gemini" : agent,
      artifactType: "document",
      tags: artifactObject.tags,
      metadata: {
        originalPayloadShape: "gemini-returnDisplay"
      }
    };
  }

  if (Array.isArray(artifactObject.llmContent)) {
    const multimodal = collectMultimodalParts(artifactObject.llmContent);
    const hasAssets = multimodal.assets.length > 0;
    const content = hasAssets
      ? JSON.stringify(createBundleDocument({
        title: artifactObject.title || artifactObject.name || "Gemini multimodal artifact",
        text: multimodal.text,
        assets: multimodal.assets,
        parts: multimodal.parts
      }), null, 2)
      : multimodal.text;
    return {
      content,
      format: hasAssets ? "json" : detectFormat({ content }),
      contentType: hasAssets ? "application/vnd.artifacty.bundle+json; charset=utf-8" : undefined,
      title: artifactObject.title || artifactObject.name,
      sourceAgent: agent === "auto" ? "gemini" : agent,
      artifactType: hasAssets ? "bundle" : "document",
      tags: artifactObject.tags,
      metadata: {
        originalPayloadShape: "gemini-llmContent",
        partCount: artifactObject.llmContent.length,
        assetCount: multimodal.assets.length,
        assetPolicy: hasAssets ? "base64-assets-stored-inline-in-bundle-json" : undefined
      }
    };
  }

  if (Array.isArray(artifactObject.content)) {
    const content = collectTextParts(artifactObject.content);
    return {
      content,
      format: detectFormat({ content }),
      title: artifactObject.title || artifactObject.name,
      sourceAgent: artifactObject.sourceAgent || artifactObject.agent,
      artifactType: "document",
      tags: artifactObject.tags,
      metadata: {
        originalPayloadShape: "content-blocks",
        partCount: artifactObject.content.length
      }
    };
  }

  return {
    content: JSON.stringify(value, null, 2),
    format: "json",
    contentType: "application/json; charset=utf-8",
    title: artifactObject.title || artifactObject.name,
    sourceAgent: artifactObject.sourceAgent || artifactObject.agent || (agent === "auto" ? undefined : agent),
    artifactType: "unknown",
    tags: artifactObject.tags,
    metadata: {
      originalPayloadShape: "json-object"
    }
  };
}

function objectContent(object, shape, content, format) {
  const sourceContentType = object.contentType || object.content_type || object.mimeType || object.mime_type || object.type;
  return {
    content,
    format,
    contentType: sourceContentType,
    title: object.title || object.name,
    sourceAgent: object.sourceAgent || object.source_agent || object.agent,
    artifactType: object.artifactType || object.artifact_type,
    tags: object.tags,
    metadata: {
      originalPayloadShape: shape,
      originalId: object.id,
      originalContentType: sourceContentType,
      language: object.language
    }
  };
}

function decodeBundlePayload(object, agent) {
  const bundle = object.bundle && typeof object.bundle === "object" ? object.bundle : object;
  const files = Array.isArray(bundle.files) ? bundle.files : [];
  const sourceAgent = object.sourceAgent || object.source_agent || object.agent || agent;
  const continuationAgent = detectContinuationAgent({ agent: sourceAgent }, "auto");
  const continuationMetadata = continuationAgent
    ? collectContinuationMetadata(continuationAgent, { agent: sourceAgent }, bundle, object)
    : {};
  const normalizedFiles = files.map((file, index) => {
    const content = typeof file.content === "string" ? file.content : "";
    return {
      path: optionalString(file.path || file.name || `file-${index + 1}`),
      content,
      contentType: optionalString(file.contentType || file.mimeType) || contentTypeForFormat(detectFormat({
        content,
        fileName: file.path || file.name
      })),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content).digest("hex")
    };
  });

  return {
    content: JSON.stringify({
      schemaVersion: 1,
      artifactType: "bundle",
      title: object.title || bundle.title || "Artifact bundle",
      files: normalizedFiles,
      ...bundleDocumentMetadata(continuationMetadata)
    }, null, 2),
    format: "json",
    contentType: "application/vnd.artifacty.bundle+json; charset=utf-8",
    title: object.title || bundle.title || "Artifact bundle",
    sourceAgent: object.sourceAgent || object.source_agent || object.agent || (agent === "auto" ? undefined : agent),
    artifactType: "bundle",
    tags: object.tags || bundle.tags,
    metadata: {
      originalPayloadShape: "artifact-bundle",
      fileCount: normalizedFiles.length,
      bundlePolicy: "text-files-stored-inline-in-bundle-json",
      ...continuationMetadata
    }
  };
}

function decodeContinuationPayload(object, agent) {
  const sourceAgent = detectContinuationAgent(object, agent);
  if (!sourceAgent || hasDirectContentField(object)) {
    return null;
  }

  const artifactType = inferContinuationType(object);
  if (!artifactType) {
    return null;
  }

  const metadata = collectContinuationMetadata(sourceAgent, { agent }, object);
  return {
    content: renderContinuationMarkdown(sourceAgent, object, artifactType, metadata),
    format: "markdown",
    contentType: "text/markdown; charset=utf-8",
    title: object.title || object.name || titleForContinuationType(sourceAgent, artifactType),
    sourceAgent,
    artifactType,
    tags: uniqueStrings([
      artifactType,
      sourceAgent,
      ...normalizeTags(object.tags)
    ]),
    metadata: {
      originalPayloadShape: `${sourceAgent}-continuation`,
      continuationKind: artifactType,
      ...metadata
    }
  };
}

function hasDirectContentField(object) {
  return typeof object.content === "string" ||
    Array.isArray(object.content) ||
    typeof object.markdown === "string" ||
    typeof object.text === "string" ||
    typeof object.html === "string" ||
    typeof object.code === "string" ||
    typeof object.svg === "string" ||
    typeof object.mermaid === "string" ||
    typeof object.react === "string" ||
    typeof object.jsx === "string" ||
    typeof object.sarif === "string" ||
    typeof object.csv === "string";
}

function detectContinuationAgent(object, agent) {
  const explicit = normalizeAgent(
    object.sourceAgent ||
      object.source_agent ||
      object.agent ||
      object.producer ||
      object.createdBy ||
      object.created_by ||
      agent
  );
  return CONTINUATION_AGENTS.has(explicit) ? explicit : "";
}

function inferContinuationType(object) {
  const explicit = optionalString(object.artifactType || object.artifact_type || object.kind || object.category || object.purpose || object.type).toLowerCase();
  if (explicit.includes("review")) {
    return "code-review";
  }
  if (explicit.includes("test") || explicit.includes("verification") || explicit.includes("report")) {
    return "test-report";
  }
  if (explicit.includes("diff") || explicit.includes("patch")) {
    return "diff-walkthrough";
  }
  if (explicit.includes("handoff") || explicit.includes("continuation")) {
    return "handoff";
  }

  if (hasNonEmptyArray(object.findings) || hasNonEmptyArray(object.review?.findings)) {
    return "code-review";
  }
  if (object.verification || hasNonEmptyArray(object.tests) || hasNonEmptyArray(object.testResults) || hasNonEmptyArray(object.test_results) || optionalString(object.testStatus)) {
    return "test-report";
  }
  if (optionalString(object.diff || object.patch)) {
    return "diff-walkthrough";
  }
  if (
    optionalString(object.goal || object.currentState || object.current_state || object.summary) ||
    hasNonEmptyArray(object.decisions) ||
    hasNonEmptyArray(object.blockers) ||
    hasNonEmptyArray(object.nextSteps) ||
    hasNonEmptyArray(object.next_steps) ||
    hasNonEmptyArray(object.changedFiles) ||
    hasNonEmptyArray(object.changed_files)
  ) {
    return "handoff";
  }

  return null;
}

function collectContinuationMetadata(sourceAgent, ...sources) {
  const objects = sources.filter((item) => item && typeof item === "object");
  const source = Object.assign({}, ...objects);
  const continuation = pruneEmpty({
    summary: optionalString(source.summary),
    goal: optionalString(source.goal),
    currentState: optionalString(source.currentState || source.current_state),
    changedFiles: normalizeChangedFiles(firstPresent(source.changedFiles, source.changed_files, source.filesChanged, source.files_changed)),
    commands: normalizeEvents(firstPresent(source.commands, source.commandsRun, source.commands_run, source.verification?.commands)),
    tests: normalizeEvents(firstPresent(source.tests, source.testResults, source.test_results, source.verification?.tests)),
    testStatus: optionalString(source.testStatus || source.test_status || source.verification?.status || source.status),
    blockers: normalizeStringList(firstPresent(source.blockers, source.blockedBy, source.blocked_by)),
    nextSteps: normalizeStringList(firstPresent(source.nextSteps, source.next_steps)),
    decisions: normalizeStringList(source.decisions),
    findings: normalizeFindings(firstPresent(source.findings, source.review?.findings)),
    diff: optionalString(source.diff || source.patch),
    residualRisk: optionalString(source.residualRisk || source.residual_risk)
  });

  if (Object.keys(continuation).length === 0) {
    return {};
  }

  const metadata = { continuation };
  metadata[`${sourceAgent}Continuation`] = continuation;
  return metadata;
}

function bundleDocumentMetadata(metadata) {
  const result = {};
  if (metadata.continuation) {
    result.continuation = metadata.continuation;
  }
  if (metadata.codexContinuation) {
    result.codexContinuation = metadata.codexContinuation;
  }
  if (metadata.copilotContinuation) {
    result.copilotContinuation = metadata.copilotContinuation;
  }
  if (metadata.cursorContinuation) {
    result.cursorContinuation = metadata.cursorContinuation;
  }
  return result;
}

function renderContinuationMarkdown(sourceAgent, object, artifactType, metadata) {
  const continuation = metadata.continuation || metadata[`${sourceAgent}Continuation`] || {};
  const title = object.title || object.name || titleForContinuationType(sourceAgent, artifactType);
  const lines = [`# ${title}`, "", `Source: ${displayAgentName(sourceAgent)}`, `Artifact type: ${artifactType}`, ""];

  addTextSection(lines, "Summary", continuation.summary);
  addTextSection(lines, "Goal", continuation.goal);
  addTextSection(lines, "Current State", continuation.currentState);
  addRecordSection(lines, "Changed Files", continuation.changedFiles, formatChangedFile);
  addRecordSection(lines, "Commands", continuation.commands, formatEvent);
  addRecordSection(lines, "Tests", continuation.tests, formatEvent);
  addTextSection(lines, "Test Status", continuation.testStatus);
  addRecordSection(lines, "Findings", continuation.findings, formatFinding);
  addListSection(lines, "Decisions", continuation.decisions);
  addListSection(lines, "Blockers", continuation.blockers);
  addListSection(lines, "Next Steps", continuation.nextSteps);
  addTextSection(lines, "Residual Risk", continuation.residualRisk);

  if (continuation.diff) {
    lines.push("## Diff", "", "```diff", continuation.diff, "```", "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function titleForContinuationType(sourceAgent, artifactType) {
  const displayName = displayAgentName(sourceAgent);
  if (artifactType === "code-review") {
    return `${displayName} Code Review`;
  }
  if (artifactType === "test-report") {
    return `${displayName} Verification Report`;
  }
  if (artifactType === "diff-walkthrough") {
    return `${displayName} Diff Walkthrough`;
  }
  return `${displayName} Handoff`;
}

function displayAgentName(sourceAgent) {
  if (sourceAgent === "copilot") {
    return "GitHub Copilot";
  }
  if (sourceAgent === "cursor") {
    return "Cursor";
  }
  if (sourceAgent === "codex") {
    return "Codex";
  }
  return sourceAgent || "Agent";
}

function addTextSection(lines, title, value) {
  if (!value) {
    return;
  }
  lines.push(`## ${title}`, "", value, "");
}

function addListSection(lines, title, values) {
  if (!values?.length) {
    return;
  }
  lines.push(`## ${title}`, "", ...values.map((value) => `- ${value}`), "");
}

function addRecordSection(lines, title, values, formatter) {
  if (!values?.length) {
    return;
  }
  lines.push(`## ${title}`, "", ...values.map((value) => `- ${formatter(value)}`), "");
}

function formatChangedFile(file) {
  return [
    file.path ? `\`${file.path}\`` : "",
    file.status,
    file.summary
  ].filter(Boolean).join(" — ");
}

function formatEvent(event) {
  return [
    event.command ? `\`${event.command}\`` : event.name || event.title || "",
    event.status,
    event.summary
  ].filter(Boolean).join(" — ");
}

function formatFinding(finding) {
  return [
    finding.severity,
    finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "",
    finding.title || finding.message || finding.summary
  ].filter(Boolean).join(" — ");
}

function normalizeChangedFiles(value) {
  return normalizeRecordList(value).map((item) => pruneEmpty({
    path: typeof item === "string" ? optionalString(item) : optionalString(item.path || item.file || item.name),
    status: optionalString(item.status || item.changeType || item.change_type),
    summary: optionalString(item.summary || item.description),
    additions: integerOrUndefined(item.additions),
    deletions: integerOrUndefined(item.deletions)
  })).filter((item) => Object.keys(item).length > 0);
}

function normalizeEvents(value) {
  return normalizeRecordList(value).map((item) => {
    if (typeof item === "string") {
      return { command: item };
    }
    return pruneEmpty({
      command: optionalString(item.command || item.cmd || item.name),
      title: optionalString(item.title),
      status: optionalString(item.status || item.result),
      summary: optionalString(item.summary || item.output || item.message)
    });
  }).filter((item) => Object.keys(item).length > 0);
}

function normalizeFindings(value) {
  return normalizeRecordList(value).map((item) => pruneEmpty({
    severity: optionalString(item.severity || item.priority),
    file: optionalString(item.file || item.path),
    line: integerOrUndefined(item.line || item.start),
    title: optionalString(item.title),
    message: typeof item === "string" ? optionalString(item) : optionalString(item.message || item.body),
    summary: optionalString(item.summary)
  })).filter((item) => Object.keys(item).length > 0);
}

function normalizeStringList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") {
        return optionalString(item);
      }
      if (item && typeof item === "object") {
        return optionalString(item.summary || item.title || item.message || JSON.stringify(item));
      }
      return optionalString(item);
    }).filter(Boolean);
  }
  return [optionalString(value)].filter(Boolean);
}

function normalizeRecordList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object") {
    return [value];
  }
  return [String(value)];
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function integerOrUndefined(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function pruneEmpty(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined || item === null || item === "") {
        return false;
      }
      if (Array.isArray(item) && item.length === 0) {
        return false;
      }
      return true;
    })
  );
}

function detectAgent(parsed, fileName) {
  if (parsed.kind === "json" && parsed.value && typeof parsed.value === "object") {
    const value = parsed.value.artifact || parsed.value;
    const explicit = normalizeAgent(value.agent || value.sourceAgent || value.source_agent || "auto");
    if (explicit !== "auto") {
      return explicit;
    }
    if (typeof value.returnDisplay === "string" || Array.isArray(value.llmContent)) {
      return "gemini";
    }
  }

  const lowerName = optionalString(fileName).toLowerCase();
  if (lowerName.includes("claude")) {
    return "claude";
  }
  if (lowerName.includes("gemini")) {
    return "gemini";
  }
  if (lowerName.includes("codex")) {
    return "codex";
  }
  if (lowerName.includes("copilot")) {
    return "copilot";
  }
  if (lowerName.includes("cursor")) {
    return "cursor";
  }
  return "generic";
}

function safeFormat(value) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "md") {
    return "markdown";
  }
  if (normalized === "jsx" || normalized === "tsx" || normalized.includes("vnd.ant.react")) {
    return "react";
  }
  if (normalized === "svg" || normalized.includes("svg")) {
    return "svg";
  }
  if (normalized === "mmd" || normalized === "mermaid" || normalized.includes("vnd.ant.mermaid")) {
    return "mermaid";
  }
  if (normalized === "code" || normalized.includes("vnd.ant.code") || normalized.includes("source-code")) {
    return "code";
  }
  if (normalized === "sarif" || normalized.includes("sarif")) {
    return "sarif";
  }
  if (normalized === "csv" || normalized.includes("csv")) {
    return "csv";
  }
  if (normalized === "html" || normalized.includes("html")) {
    return "html";
  }
  if (normalized === "markdown" || normalized.includes("markdown")) {
    return "markdown";
  }
  if (normalized === "json" || normalized.includes("json")) {
    return "json";
  }
  if (normalized === "text" || normalized.includes("text")) {
    return "text";
  }
  return undefined;
}

function inferTitle({ content, format, fileName, sourceAgent }) {
  if (format === "html") {
    const htmlTitle = extractHtmlTitle(content);
    if (htmlTitle) {
      return htmlTitle;
    }
  }

  if (format === "markdown") {
    const markdownTitle = extractMarkdownTitle(content);
    if (markdownTitle) {
      return markdownTitle;
    }
  }

  if (fileName) {
    return titleFromFileName(fileName);
  }

  return `${sourceAgent || "Imported"} artifact`;
}

function extractHtmlTitle(content) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content);
  if (titleMatch) {
    return cleanTitle(titleMatch[1]);
  }

  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content);
  if (h1Match) {
    return cleanTitle(h1Match[1]);
  }

  return "";
}

function extractMarkdownTitle(content) {
  const match = /^#\s+(.+)$/m.exec(content);
  return match ? cleanTitle(match[1]) : "";
}

function titleFromFileName(fileName) {
  const parsed = path.parse(fileName);
  return parsed.name
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Imported artifact";
}

function collectTextParts(parts) {
  return parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      if (part.type === "text" && typeof part.value === "string") {
        return part.value;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function collectMultimodalParts(parts) {
  const collected = {
    text: "",
    parts: [],
    assets: []
  };

  for (const [index, part] of parts.entries()) {
    if (typeof part === "string") {
      collected.parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }
    const text = typeof part.text === "string"
      ? part.text
      : typeof part.content === "string"
        ? part.content
        : part.type === "text" && typeof part.value === "string"
          ? part.value
          : "";
    if (text) {
      collected.parts.push({ type: "text", text });
      continue;
    }
    const inline = part.inlineData || part.inline_data || part.data;
    if (inline && typeof inline === "object") {
      const data = optionalString(inline.data || inline.base64 || inline.content);
      const mimeType = optionalString(inline.mimeType || inline.mime_type || part.mimeType || "application/octet-stream");
      if (data) {
        const asset = {
          id: `asset-${collected.assets.length + 1}`,
          sourcePartIndex: index,
          mimeType,
          encoding: "base64",
          data,
          sizeBytes: Buffer.byteLength(data, "base64"),
          sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")
        };
        collected.assets.push(asset);
        collected.parts.push({ type: "asset-ref", assetId: asset.id, mimeType });
      }
    }
  }

  collected.text = collected.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  return collected;
}

function createBundleDocument({ title, text, assets, parts }) {
  return {
    schemaVersion: 1,
    artifactType: "bundle",
    title,
    text,
    parts,
    assets,
    assetPolicy: "base64-assets-stored-inline; consumers must treat decoded assets as untrusted"
  };
}

function inferArtifactType({ format, content, fileName, metadata }) {
  if (metadata?.originalPayloadShape === "artifact-bundle") {
    return "bundle";
  }
  if (format === "html") {
    return "html-page";
  }
  if (format === "svg" || format === "mermaid") {
    return "diagram";
  }
  if (format === "react") {
    return "component";
  }
  if (format === "code") {
    return "snippet";
  }
  if (format === "sarif") {
    return "analysis-report";
  }
  if (format === "csv") {
    return looksLikeAnalysisCsv(content) ||
      /findings?|security|review|scan/i.test(optionalString(fileName))
      ? "analysis-report"
      : "table";
  }
  const lowerName = optionalString(fileName).toLowerCase();
  if (lowerName.includes("handoff")) {
    return "handoff";
  }
  if (lowerName.includes("review")) {
    return "code-review";
  }
  if (lowerName.includes("test") || lowerName.includes("report")) {
    return "test-report";
  }
  return "document";
}

function looksLikeAnalysisCsv(content) {
  const [header = ""] = optionalString(content).split(/\r?\n/, 1);
  const normalized = header.toLowerCase();
  return normalized.includes("severity") &&
    (normalized.includes("message") || normalized.includes("description")) &&
    (normalized.includes("file") || normalized.includes("path") || normalized.includes("rule"));
}

function normalizeArtifactType(value) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) {
    return "document";
  }
  const allowed = new Set(ARTIFACT_TYPES);
  return allowed.has(normalized) ? normalized : "unknown";
}

function parsePayload(payload) {
  if (payload && typeof payload === "object") {
    return {
      kind: "json",
      value: payload,
      text: JSON.stringify(payload, null, 2)
    };
  }

  const text = String(payload ?? "");
  const trimmed = text.trim();
  if (looksLikeJson(trimmed)) {
    try {
      return {
        kind: "json",
        value: JSON.parse(trimmed),
        text
      };
    } catch {
      return { kind: "text", text };
    }
  }
  return { kind: "text", text };
}

function looksLikeJson(value) {
  const trimmed = optionalString(value);
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function looksLikeSarif(value) {
  if (!looksLikeJson(value)) {
    return false;
  }
  try {
    return isSarifObject(JSON.parse(optionalString(value)));
  } catch {
    return false;
  }
}

function isSarifObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.runs) &&
    (typeof value.version === "string" || optionalString(value.$schema).toLowerCase().includes("sarif"));
}

function looksLikeCsv(value) {
  const lines = optionalString(value)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 5);
  if (lines.length < 2 || lines[0].trimStart().startsWith("|")) {
    return false;
  }
  const counts = lines.map(csvFieldCount);
  return counts[0] > 1 && counts.every((count) => count === counts[0]);
}

function csvFieldCount(line) {
  let count = 1;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

function looksLikeMermaid(value) {
  const firstMeaningfulLine = optionalString(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%"));
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|mindmap|journey)\b/.test(firstMeaningfulLine || "");
}

function looksLikeReact(value) {
  const text = optionalString(value);
  return /\b(import\s+React|from\s+['"]react['"]|export\s+default\s+function|export\s+default\s+\()/m.test(text) ||
    /<[A-Z][A-Za-z0-9]*[\s/>]/.test(text);
}

function isCodeExtension(extension) {
  return new Set([
    ".js",
    ".ts",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".php",
    ".swift",
    ".kt",
    ".sh",
    ".bash",
    ".zsh",
    ".sql",
    ".toml",
    ".yaml",
    ".yml"
  ]).has(extension);
}

function stripMarkdownCodeFence(value) {
  const trimmed = value.trim();
  const match = /^```(?:\w+)?\n([\s\S]*?)\n```$/.exec(trimmed);
  return match ? match[1] : value;
}

function cleanTitle(value) {
  return optionalString(value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " "));
}

function normalizeAgent(value) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) {
    return "auto";
  }
  if (normalized === "claude-code" || normalized === "anthropic") {
    return "claude";
  }
  if (normalized === "gemini-cli" || normalized === "google") {
    return "gemini";
  }
  if (normalized === "github-copilot" || normalized === "copilot-chat" || normalized === "vscode-copilot" || normalized === "vs-code-copilot") {
    return "copilot";
  }
  if (normalized === "cursor-ai") {
    return "cursor";
  }
  if (normalized === "openai" || normalized === "chatgpt") {
    return "codex";
  }
  if (KNOWN_AGENTS.has(normalized)) {
    return normalized;
  }
  return normalized.replace(/[^a-z0-9-]+/g, "-") || "generic";
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.map(optionalString).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.map(optionalString).filter(Boolean))].slice(0, 20);
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  return metadata;
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}
