import path from "node:path";
import { createHash } from "node:crypto";
import { contentTypeForFormat, normalizeFormat } from "./storage.js";

const KNOWN_AGENTS = new Set(["auto", "artifacty", "claude", "codex", "gemini", "generic"]);

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

  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    return "html";
  }
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".txt" || extension === ".log") {
    return "text";
  }

  const trimmed = optionalString(content);
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return "html";
  }
  if (looksLikeJson(trimmed)) {
    return "json";
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

  if (typeof artifactObject.content === "string" && !Array.isArray(artifactObject.content)) {
    return {
      content: artifactObject.content,
      format: safeFormat(artifactObject.format || artifactObject.type || artifactObject.mimeType),
      contentType: artifactObject.contentType || artifactObject.mimeType,
      title: artifactObject.title || artifactObject.name,
      sourceAgent: artifactObject.sourceAgent || artifactObject.source_agent || artifactObject.agent,
      artifactType: artifactObject.artifactType || artifactObject.artifact_type,
      tags: artifactObject.tags,
      metadata: {
        originalPayloadShape: "content",
        originalId: artifactObject.id
      }
    };
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
    return {
      content: stripMarkdownCodeFence(artifactObject.returnDisplay),
      format: detectFormat({ content: artifactObject.returnDisplay }) === "json" ? "json" : "markdown",
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
  return {
    content,
    format,
    title: object.title || object.name,
    sourceAgent: object.sourceAgent || object.source_agent || object.agent,
    artifactType: object.artifactType || object.artifact_type,
    tags: object.tags,
    metadata: {
      originalPayloadShape: shape,
      originalId: object.id
    }
  };
}

function decodeBundlePayload(object, agent) {
  const bundle = object.bundle && typeof object.bundle === "object" ? object.bundle : object;
  const files = Array.isArray(bundle.files) ? bundle.files : [];
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
      files: normalizedFiles
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
      bundlePolicy: "text-files-stored-inline-in-bundle-json"
    }
  };
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

function inferArtifactType({ format, fileName, metadata }) {
  if (metadata?.originalPayloadShape === "artifact-bundle") {
    return "bundle";
  }
  if (format === "html") {
    return "html-page";
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

function normalizeArtifactType(value) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) {
    return "document";
  }
  const allowed = new Set(["document", "html-page", "handoff", "code-review", "test-report", "dashboard", "design-option", "diff-walkthrough", "bundle", "asset", "unknown"]);
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
