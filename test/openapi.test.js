import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildOpenApiDocument, listDocumentedRoutes, routeTable } from "../src/lib/openapi.js";

test("buildOpenApiDocument produces a structurally valid OpenAPI 3.1 document", () => {
  const document = buildOpenApiDocument({ baseUrl: "http://127.0.0.1:8787" });

  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.title, "Artifacty API");
  assert.ok(document.paths["/api/artifacts"], "expected /api/artifacts in paths");
  assert.ok(document.paths["/api/artifacts"].get, "expected GET /api/artifacts");
  assert.ok(document.paths["/api/artifacts"].post, "expected POST /api/artifacts");
  assert.ok(document.components.securitySchemes.bearerAuth);
  assert.ok(document.components.securitySchemes.tokenHeader);
  assert.equal(document.components.securitySchemes.tokenHeader.name, "x-artifacty-token");

  const updateOperation = document.paths["/api/artifacts/{id}"].post;
  assert.ok(updateOperation.responses["409"], "expected a 409 conflict response on the update route");
  assert.equal(updateOperation.responses["409"].content["application/json"].schema.$ref, "#/components/schemas/Error");

  for (const schemaName of ["ArtifactSummary", "ArtifactWithContent", "ArtifactVersion", "AuditEvent", "Pagination", "ArtifactListPage", "RelationEntry", "Error"]) {
    assert.ok(document.components.schemas[schemaName], `expected schema ${schemaName}`);
  }
});

test("listDocumentedRoutes exposes method/path pairs for every routeTable entry", () => {
  const routes = listDocumentedRoutes();
  assert.equal(routes.length, routeTable.length);
  assert.ok(routes.some((route) => route.method === "GET" && route.path === "/api/artifacts"));
  assert.ok(routes.some((route) => route.method === "POST" && route.path === "/mcp"));
});

// --- Route table <-> server.js sync check -----------------------------
//
// server.js dispatches by hand-written `if` checks rather than a route
// table (see CLAUDE.md / working rules for this change), so we cannot
// literally share one array between the two. Instead this test greps
// src/server.js for its route path literals and cross-checks the *static
// prefix* of each one against the openapi.js route table, in both
// directions:
//
//   1. every non-pending documented route's static prefix must appear
//      somewhere in server.js's route literals, and
//   2. every "/api/..." (or "/mcp") static prefix found in server.js must
//      be covered by at least one documented route.
//
// A route's "static prefix" is the leading run of path characters before
// the first dynamic segment marker: "{" in an openapi.js path (e.g.
// "/api/artifacts/{id}" -> "/api/artifacts") or "(" in a server.js regex
// literal (e.g. `/^\/api\/artifacts\/([^/]+)\/(archive|restore)$/` ->
// "/api/artifacts/"). This intentionally collapses sibling routes that
// share a resource prefix (all the /api/artifacts/{id}/... routes, for
// example) into one comparable token, because server.js encodes exact
// path shape in ad hoc regexes that don't map 1:1 to the OpenAPI path
// template syntax. It is not path-exact, but it is enough to catch a
// wholesale drop of a resource (say, the /api/admin/backup routes) from
// either side.
//
// Routes marked `pending: true` in routeTable document a feature
// (artifact relations) not yet implemented in server.js, and are exempted
// from direction (1): they are allowed to exist in the OpenAPI document
// before server.js implements them. They still participate in direction
// (2) so that once the routes land, this test starts requiring them to
// stay documented instead of silently accepting drift.
test("openapi.js route table stays in sync with src/server.js route literals", async () => {
  const serverSource = await readFile(path.join(process.cwd(), "src", "server.js"), "utf8");
  const unescaped = serverSource.replaceAll("\\/", "/");

  const serverPrefixes = new Set();
  const prefixPattern = /\/(?:api|mcp)(?:\/[a-zA-Z0-9_-]+)*/g;
  for (const match of unescaped.matchAll(prefixPattern)) {
    serverPrefixes.add(match[0]);
  }

  assert.ok(serverPrefixes.size > 0, "expected to find at least one /api or /mcp route literal in server.js");

  function staticPrefix(routePath) {
    const dynamicIndex = routePath.indexOf("{");
    const trimmed = dynamicIndex === -1 ? routePath : routePath.slice(0, dynamicIndex);
    return trimmed.replace(/\/$/, "") || "/";
  }

  // Direction 1: every non-pending documented route is backed by server.js.
  // Routes marked `browserRoute: true` (e.g. GET /artifacts/{id}/export) are
  // plain browser endpoints outside the /api and /mcp surface this test's
  // prefix scan covers, mirroring GET /artifacts/{id}/raw which stays
  // undocumented entirely; they are exempted from this direction but, since
  // their prefix never enters serverPrefixes, participate in neither
  // direction of the sync check.
  for (const route of routeTable) {
    if (route.pending || route.browserRoute) {
      continue;
    }
    const prefix = staticPrefix(route.path);
    const covered = [...serverPrefixes].some((serverPrefix) => serverPrefix.startsWith(prefix) || prefix.startsWith(serverPrefix));
    assert.ok(covered, `documented route ${route.method} ${route.path} (prefix ${prefix}) has no matching literal in src/server.js`);
  }

  // Direction 2: every /api or /mcp literal found in server.js is documented.
  for (const serverPrefix of serverPrefixes) {
    const covered = routeTable.some((route) => {
      const prefix = staticPrefix(route.path);
      return prefix.startsWith(serverPrefix) || serverPrefix.startsWith(prefix);
    });
    assert.ok(covered, `src/server.js route literal ${serverPrefix} is not documented in src/lib/openapi.js routeTable`);
  }
});
