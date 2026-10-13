// Stable keys identify installed manuals independently of titles and edits.
export const sampleCatalog = [
  {
    key: "start-here",
    title: "Artifacty — Start here",
    artifactType: "document",
    format: "markdown",
    tags: ["sample", "manual", "getting-started"],
    content: `# Welcome to Artifacty

Artifacty keeps agent outputs in one versioned store. You can use the store through a browser, CLI, JSON API, or MCP. Open the **Feature guide** to see all features. Open **Architecture** to see the system map. Use the **Handoff exercise** to practice a review cycle.

## Start locally

Use Node.js 22.12.0 or newer. The optional Babel 8 React renderer requires Node 22.18.x or newer within Node 22, or Node 24.11.0 or newer. Use an ES2024-capable browser, such as Safari 17.4 or newer, for Mermaid 12.1.0 diagrams. The classic look, dagre layout, and default theme stay unchanged. From the repository, run:

\`\`\`sh
npm install
npm start
\`\`\`

Open http://127.0.0.1:8787. The server binds to localhost by default. To start a background server, run \`node src/cli.js serve\`. To keep the server in the terminal, add \`--foreground\`. Use \`node src/cli.js status\`, \`stop\`, and \`doctor\` to inspect it.

## Publish and improve an artifact

1. Create a Markdown artifact in the browser, or run \`node src/cli.js publish --title "My first note" --content "Hello Artifacty" --format markdown\`.
2. Open the artifact.
3. Edit its content.
4. Save a new version. Earlier versions remain available.
5. Inspect the version history.
6. Compare the versions with a diff.
7. Add tags.
8. Use search, filters, or saved views to find the artifact again.
9. Add a comment.
10. Request a review.
11. As the owner or administrator, record an approved or changes-requested status.
12. Create the initial administrator at **/login**.
13. Sign in as the administrator.
14. Open **Sharing** on the artifact. Anonymous single-user browsing does not expose Sharing.
15. Inspect the effective permissions.
16. Grant read, comment, or edit access as needed.

## Choose your access model

Before accounts exist, Artifacty operates as a local single-user store. Once accounts exist, use personal accounts and tokens. Create the initial administrator at **/login**. Administrators manage accounts at **/admin/users**. The Access page links to that page. Administrators manage teams, access mode, and network rules at **/admin/access**. In private mode, use personal authentication for ordinary artifact reads and creation. Server-wide tokens do not authorize those operations. Local CLI operations remain trusted store administration.

A share link is a separate read-only capability with an expiry time. It does not grant account membership. Default expiry is seven days. Owners can share the latest version or pin one version. Share links while the server is in private mode require explicit administrator opt-in. In public mode, an owner can link a private-visibility artifact without that site toggle. When you no longer need a link, revoke it. An owner change invalidates existing links.

## Keep the manuals safely

\`node src/cli.js samples install\` installs these four manuals once per installation scope. Repeating installation skips active manuals. \`samples remove\` archives managed samples. It preserves their content and versions. Installing again restores them without replacing your edits. Matching titles or tags do not make your own artifacts managed samples.

Back up before maintenance. This build uses store schema 10. Older builds refuse newer stores. This manual describes the implemented repository behavior, not a package release announcement.

Before migrating an existing schema, Artifacty creates a mandatory verified snapshot of the raw SQLite database, referenced version files, and legacy index. Set ARTIFACTY_BACKUP_ON_UPDATE=true to also snapshot application-version changes. If the old application version is unknown, the first open creates a baseline snapshot. ARTIFACTY_UPGRADE_BACKUP_KEEP defaults to 3 automatic snapshots and accepts 1–1000.

Use \`artifacty backups list\`, \`artifacty backups verify <id>\`, and \`artifacty backups restore <id> --confirm restore-store\`. Stop every server and MCP process first. Restore creates a recovery snapshot before replacing the store. It also restores credentials and security state, so previously revoked sessions, tokens, and links can become valid again. These snapshots differ from portable JSON export backups.

If the current store is corrupt, preserve it and copy the selected snapshot to a new empty home before restoring there. If a restore leaves a .restore-* directory, preserve it. Read its restore.json recoveryBackupId and restore that recovery snapshot into a new empty home. See docs/upgrade-backups.md in the repository for the full procedure.`
  },
  {
    key: "feature-guide",
    title: "Artifacty — Feature guide",
    artifactType: "html-page",
    format: "html",
    tags: ["sample", "manual", "reference"],
    content: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifacty feature guide</title>
<style>body{font-family:system-ui,sans-serif;line-height:1.65;color:#172b3a;background:#f5f7fa;margin:0}main{max-width:900px;margin:auto;padding:40px 24px}h1,h2{line-height:1.2}h1{font-size:2.4rem}section{background:white;border:1px solid #dce4ec;border-radius:12px;padding:24px;margin:20px 0}code{background:#edf2f7;padding:2px 5px;border-radius:4px}li{margin:6px 0}a{color:#175aa3}footer{color:#526475}</style></head><body><main>
<header><p>ARTIFACTY / REFERENCE</p><h1>From an agent output to a shared record</h1><p>Use this inventory to choose the right publishing, review, access, and maintenance workflow. Use Node.js 22.12.0 or newer. The current store schema is 10. Mermaid 12.1.0 keeps the classic look, dagre layout, and default theme. Use an ES2024-capable browser, such as Safari 17.4 or newer. The optional Babel 8 React renderer requires Node ^22.18.0 or &gt;=24.11.0.</p></header>
<nav aria-label="Guide sections"><a href="#formats">Formats</a> · <a href="#history">History and discovery</a> · <a href="#collaboration">Collaboration</a> · <a href="#access">Access</a> · <a href="#operations">Operations</a></nav>
<section id="formats"><h2>Formats and imports</h2><p>The 13 formats are HTML, Markdown, text, JSON, code, SVG, Mermaid, React, SARIF, CSV, image, video, and notebook. Choose an artifact type separately: a document, handoff, code review, test report, dashboard, diagram, component, table, or another supported type.</p><p>Bundles group multiple files under one artifact. Supported binary bundle assets include PDF, DOCX, XLSX, and ZIP. Importers normalize outputs from Claude, Codex, Gemini, GitHub Copilot, Cursor, and generic inputs. Use the browser import screen or <code>artifacty import --agent codex --file handoff.md</code>.</p><p>Artifact content is untrusted. Browser previews use constrained rendering. A public HTML share preview is static. It blocks scripts and external resource loading. Share links show other active formats as source. Do not expect those previews to preserve interactive application behavior.</p></section>
<section id="history"><h2>Versions, discovery, and retrieval</h2><ul><li>Updates create versions with immutable content files. You can read a historical version and compare versions with a diff. To avoid overwriting a concurrent edit, use an expected-version check.</li><li>Archive and restore artifacts instead of losing their history. Integrity checks verify stored files, hashes, and orphaned files.</li><li>Search by keyword and filter by tags, source agent, artifact type, publisher, dates, review status, relationships, and archive state. Pagination and grouping help you use large lists. To reuse a set of filters, save it as a view.</li><li>When available, SQLite FTS5 accelerates keyword search. Otherwise, search uses metadata. Optional embeddings enable semantic and hybrid search. Without a configured provider, those modes use keyword search. Rebuild search or embedding indexes after configuration changes.</li></ul></section>
<section id="collaboration"><h2>Relationships, comments, review, and notifications</h2><p>Connect artifacts using derived-from, supersedes, reviews, references, or part-of relations. Comments support threads and anchors. After you address a thread, resolve it. Review status progresses among none, pending, changes-requested, and approved.</p><p>The inbox at <code>/inbox</code> collects relevant shares, comments, review activity, and new versions. Notifications depend on the user and current artifact access. You can mark items read individually or together. A notification does not grant access.</p><p>Audit records support investigation. Event polling and server-sent events expose authorized activity streams. Webhooks deliver configured events to validated destinations. Use event filters, replay cursors, and webhook administration for integrations.</p></section>
<section id="access"><h2>Accounts, permissions, share links, and network rules</h2><p>Create the initial administrator at <code>/login</code>. Administrators manage accounts at <code>/admin/users</code>. The Access page links to that page. Administrators manage teams, access mode, and network rules at <code>/admin/access</code>. The artifact <strong>Sharing</strong> panel shows effective access and its sources. Direct-user and team grants support read, comment, and edit. Where grants overlap, the strongest permission wins. Ownership and administrator management are separate from grants. Token scopes limit token actions. They do not grant artifact access.</p><p>Private mode requires an active personal account. Server-wide tokens do not authorize ordinary artifact reads or creation in private mode. Administrator APIs have their own authorization rules. Personal tokens remain constrained by both their scopes and the user's artifact permissions. Trusted local CLI operations can administer the local store directly.</p><p>Read-only share links default to seven days and can target the latest version or a pinned version. Share links while the server is in private mode require explicit administrator opt-in. In public mode, owners may link private-visibility artifacts without that site toggle. Links can be revoked, and owner changes invalidate them. A valid capability permits only its read-only shared surface.</p><p>Network allow rules accept IP addresses and CIDRs. First, stage a change. Next, verify access from the intended peer. Then confirm the change within 120 seconds or roll it back. Pending state survives a restart. Before the next access, the server checks for expiry. If the change has expired, the server restores the previous rules. Rules use the socket peer address, not forwarded proxy headers.</p></section>
<section id="operations"><h2>Interfaces and maintenance</h2><ul><li>The browser supports creation, import, viewing, editing, discovery, review, inbox, and administration.</li><li>The CLI supports serve/start/stop/status, publish/import/update/read/list, history and diff, relations/comments/review, saved views, event watching, account import, backup, retention, indexes, integrity, and diagnostics. Run <code>artifacty help</code> for exact flags.</li><li>The JSON API exposes artifacts and operational endpoints under <code>/api/</code>. MCP exposes agent tools through stdio and optional HTTP transport. Use <code>artifacty install claude --dry-run</code> to inspect integration configuration and <code>artifacty check</code> to verify tool discovery.</li><li>Export and import JSON backups to move a store. Upgrade snapshots separately preserve raw SQLite, referenced versions, and any legacy index. Schema migrations always require a verified snapshot. Set <code>ARTIFACTY_BACKUP_ON_UPDATE=true</code> for application-version snapshots, including an unknown-version baseline. <code>ARTIFACTY_UPGRADE_BACKUP_KEEP</code> defaults to 3 and accepts 1–1000.</li><li>Use <code>artifacty backups list</code>, <code>artifacty backups verify &lt;id&gt;</code>, and <code>artifacty backups restore &lt;id&gt; --confirm restore-store</code>. Stop every server and MCP process first. Restore saves a recovery snapshot and rolls back credentials and security state. Revoked sessions, tokens, or links can become valid again. For a corrupt store, copy the snapshot to a new empty home and restore there. Preserve interrupted <code>.restore-*</code> directories and use their <code>restore.json</code> recoveryBackupId. See <code>docs/upgrade-backups.md</code>.</li><li>Retention supports archive rules, archived-item purge, audit/event history limits, and protected tags. Before an intentional purge, inspect a dry run.</li><li><code>artifacty samples install</code> installs these manuals idempotently. <code>artifacty samples remove</code> archives only managed samples in the current scope. Reinstallation restores existing versions and user edits.</li></ul><p>Keep ARTIFACTY_HOME private. Older builds refuse schema-10 stores. Before changing builds, preserve a backup. Consult repository integration documentation for concrete agent and API examples.</p></section>
<footer><p>This guide is a managed sample artifact. Editing it creates your own version. Reinstalling samples preserves that work.</p></footer>
</main></body></html>`
  },
  {
    key: "architecture",
    title: "Artifacty — Architecture",
    artifactType: "diagram",
    format: "mermaid",
    tags: ["sample", "manual", "architecture"],
    content: `flowchart TD
  Browser[Browser dashboard and admin] --> HTTP[Local HTTP server and JSON API]
  Agents[Agent clients] --> MCP[MCP stdio and optional HTTP]
  Operator[Trusted local operator] --> CLI[Artifacty CLI]
  HTTP --> Peer[Socket peer network policy]
  Peer --> Auth[Personal accounts and token scopes]
  Auth --> Access[Private mode and effective permissions]
  Access --> Store[Shared storage operations]
  MCP --> Store
  CLI --> Store
  Store --> DB[(SQLite schema 10 metadata)]
  Store --> Files[Immutable version files and bundle assets]
  Store --> Search[FTS5 and optional embeddings]
  Store --> History[Version history and diff]
  Store --> Collaboration[Relations comments and review]
  Collaboration --> Inbox[Access scoped inbox]
  Store --> Events[Audit events SSE and webhooks]
  HTTP --> Links[Read only expiring latest or pinned share links]
  Links --> Preview[Static HTML or active format source]
  Links --> Store
  Admin[Active administrator] --> Policy[Stage network rules for 120 seconds]
  Policy --> Confirm[Confirm or explicit rollback]
  Policy --> Expiry[Durable lazy expiry rollback]
  Confirm --> Peer
  Expiry --> Peer
  CLI --> Maintenance[Backup retention integrity and indexes]
  CLI --> Samples[Install restore or archive managed manuals]
  Samples --> Store`
  },
  {
    key: "handoff-exercise",
    title: "Artifacty — Handoff exercise",
    artifactType: "handoff",
    format: "markdown",
    tags: ["sample", "manual", "handoff", "exercise"],
    content: `# Handoff exercise: review a versioned decision

## Goal

Practice passing an artifact from an author to a reviewer while preserving evidence, access, and the next action. Use a disposable artifact of your own. Keep this manual as a reference.

## Current state

The four sample manuals are installed. You can open the browser dashboard. To practice multi-user access, first ask an administrator to create the author and reviewer accounts. Local single-user mode does not demonstrate account isolation.

## Exercise

1. Publish a Markdown artifact titled **Exercise: launch checklist**, type **handoff**. Include a goal, current state, evidence, decisions, blockers, and next actions.
2. Add an exercise tag.
3. Save the artifact ID and initial version number.
4. Edit one next action. If you use an agent, include the expected version in the update.
5. Save a second version.
6. Inspect both versions.
7. Compare the versions with a diff.
8. Create a separate test-report artifact.
9. Add a **references** relation from the handoff to the test report.
10. Open the relation from each side.
11. In **Sharing**, give the reviewer **comment** permission.
12. Inspect the effective permission and its source. If the reviewer has team edit access, that stronger grant wins. Token scopes do not grant artifact access.
13. To demonstrate comment-only access, remove any stronger grant.
14. Ask the reviewer to add an anchored comment recommending **changes-requested**.
15. As the owner or administrator, record that review status.
16. Address the comment in a new version.
17. Resolve the comment thread.
18. When the reviewer agrees that the evidence supports approval, record **approved** as the owner or administrator.
19. Check each participant's inbox for relevant sharing, comment, review, and new-version activity.
20. Mark notifications read. Notifications remain scoped to current access.
21. If the server is in private mode, ask an administrator to enable share links explicitly.
22. Create a seven-day read-only share link pinned to the reviewed version.
23. Inspect the link preview.
24. Edit the artifact again.
25. Verify that the pinned link still shows the selected version. A latest-version link follows new versions. An owner change invalidates existing links.
26. When the exercise is over, revoke the link.
27. Archive your exercise artifact.
28. Restore the artifact.
29. Reopen its history to confirm that earlier versions remain available.

## Handoff template

- **Goal:** the outcome the next person should achieve.
- **Current state:** what works and which version is being handed off.
- **Evidence:** test report IDs, related artifacts, commands, and observed results.
- **Decisions:** why the approach was chosen and relevant constraints.
- **Blockers:** known problems with concrete reproduction steps.
- **Next action:** one bounded task, its owner, and its completion check.

## Administration practice

As an administrator, open **/admin/access** to inspect access mode and network rules. You can switch access mode or stage a network change.

1. Before you stage a network change, keep your actual socket peer address in the allowed rules.
2. Stage the change.
3. Test the new route.
4. Within 120 seconds, confirm the change or roll it back.

Unconfirmed changes remain pending across a restart. Before the next access, the server checks for expiry and rolls back an expired change. Proxy forwarding headers do not change the peer address used by the rule.

In private mode, use personal authentication for ordinary artifact reads and creation. Server-wide tokens do not authorize those operations. Administrator APIs have their own authorization rules. The local CLI is trusted administration. Before testing backup or retention, export a backup. Before a purge, review the purge plan.

## Completion check

You can identify the approved version, read its evidence relation, explain the reviewer's effective permission, and prove the revoked link no longer opens. Record any remaining gap in the handoff.

Removing samples archives only the managed manuals. Reinstalling restores your edited manual versions without replacing them. Your separately created exercise artifacts remain yours.`
  }
];
