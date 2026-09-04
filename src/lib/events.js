// In-process event bus for Artifacty change notifications (roadmap section
// 3). storage.js is the single publish point: insertAuditRecord derives an
// event from the audit row it just wrote (via eventFromAudit) and, once the
// enclosing transaction commits, calls publish() so SSE clients, webhooks,
// and MCP subscribers can react. This module has no storage.js dependency
// so it stays a plain, testable pub/sub primitive.
import { randomUUID } from "node:crypto";

// Maps audit_log `action` values to public event `type` values. Actions not
// listed here (update-noop, update-conflict, read, relation-remove,
// webhook-*, retention-purge, retention-sweep, retention-policy-update,
// visibility-change, owner-change, token-scope-denied, rate-limited,
// comment-resolve, comment-delete) never produce an event.
export const ACTION_TO_EVENT_TYPE = {
  create: "artifact.created",
  import: "artifact.created",
  update: "artifact.updated",
  archive: "artifact.archived",
  "retention-archive": "artifact.archived",
  restore: "artifact.restored",
  "relation-add": "artifact.relation.added",
  "comment-add": "artifact.comment.added",
  "review-status-change": "artifact.review_status.changed",
  "version-repair": "artifact.version.repaired",
  "version-delete": "artifact.version.deleted"
};

export const EVENT_TYPES = [...new Set(Object.values(ACTION_TO_EVENT_TYPE))];

const listeners = new Set();

// Cross-process visibility (see server.js's store-backed poller, which
// re-publishes rows written by other processes sharing the same store —
// another local MCP stdio server, the CLI, or a second HTTP server) means
// the same event id can reach publish() twice: once from the in-process
// mutation that created it, and once when the poller reads it back from the
// events table. Track a bounded window of recently published ids so a
// re-publish of the same id is a silent no-op instead of a duplicate
// delivery to SSE clients, webhooks, and MCP subscribers.
const RECENTLY_PUBLISHED_LIMIT = 5000;
const recentlyPublishedIds = new Set();
const recentlyPublishedOrder = [];

function markPublished(id) {
  // Event ids are randomUUID()-derived (see eventFromAudit) and therefore
  // unique, so a plain FIFO trim never evicts an id that got re-added later.
  recentlyPublishedIds.add(id);
  recentlyPublishedOrder.push(id);
  while (recentlyPublishedOrder.length > RECENTLY_PUBLISHED_LIMIT) {
    recentlyPublishedIds.delete(recentlyPublishedOrder.shift());
  }
}

/**
 * Build a public event object from an audit-row-shaped input, or return
 * null when the action does not correspond to a public event type (e.g.
 * update-conflict, update-noop, read).
 */
export function eventFromAudit(auditRow = {}) {
  const type = ACTION_TO_EVENT_TYPE[auditRow.action];
  if (!type) {
    return null;
  }
  return {
    id: `evt_${randomUUID()}`,
    type,
    createdAt: auditRow.createdAt || new Date().toISOString(),
    artifactId: auditRow.artifactId || null,
    version: auditRow.version ?? null,
    actor: auditRow.actor || null,
    sourceAgent: auditRow.sourceAgent || null,
    surface: auditRow.surface || null,
    tags: Array.isArray(auditRow.tags) ? auditRow.tags : [],
    artifactType: auditRow.artifactType || null,
    visibility: auditRow.visibility || null,
    ownerUserId: auditRow.ownerUserId || null
  };
}

/**
 * True when `event` is visible to `access`. Mirrors storage.js's
 * canReadArtifactMeta: a falsy `access` means an internal/trusted caller
 * (or single-user mode) and always sees everything; otherwise a
 * private-visibility event is only visible to its owner or an admin.
 * Events with no recorded visibility (not tied to a private artifact, or
 * predating this field) are always visible.
 */
export function eventVisibleTo(event, access) {
  if (!event) {
    return false;
  }
  if (!access) {
    return true;
  }
  if (access.role === "admin") {
    return true;
  }
  if (event.visibility !== "private") {
    return true;
  }
  return Boolean(access.userId) && access.userId === event.ownerUserId;
}

/** Strip fields from an event that should not cross a process/network
 * boundary (SSE frames, MCP tool results) even though they are useful for
 * in-process visibility filtering. */
export function sanitizeEventForDelivery(event) {
  if (!event) {
    return event;
  }
  const { ownerUserId, ...rest } = event;
  return rest;
}

/**
 * True when `event` satisfies `filter`. All filter fields are optional and
 * AND together. `tag` matches when the event's tags array contains it.
 */
export function matchesFilter(event, filter = {}) {
  if (!event) {
    return false;
  }
  if (filter.type && event.type !== filter.type) {
    return false;
  }
  if (filter.artifactId && event.artifactId !== filter.artifactId) {
    return false;
  }
  if (filter.sourceAgent && event.sourceAgent !== filter.sourceAgent) {
    return false;
  }
  if (filter.tag && !(Array.isArray(event.tags) && event.tags.includes(filter.tag))) {
    return false;
  }
  return true;
}

/**
 * Publish an event to every in-process subscriber whose filter matches.
 * Deduped by event.id against a bounded recent-ids window, so re-publishing
 * the same id (e.g. the store-backed cross-process poller in server.js
 * re-reading an event this same process already published in-process) is a
 * no-op rather than a duplicate delivery.
 */
export function publish(event) {
  if (!event) {
    return;
  }
  if (event.id) {
    if (recentlyPublishedIds.has(event.id)) {
      return;
    }
    markPublished(event.id);
  }
  for (const { filter, listener } of listeners) {
    try {
      if (matchesFilter(event, filter)) {
        listener(event);
      }
    } catch (error) {
      // A listener throwing must never break publication to the others or
      // bubble into the storage transaction that triggered it.
      process.stderr.write(`Artifacty event listener error: ${error.stack || error.message}\n`);
    }
  }
}

/**
 * Subscribe to future events matching `filter`. Returns an unsubscribe
 * function.
 */
export function subscribe(filter, listener) {
  const entry = { filter: filter || {}, listener };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

export function eventHistoryLimit() {
  const parsed = Number.parseInt(process.env.ARTIFACTY_EVENT_HISTORY, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}
