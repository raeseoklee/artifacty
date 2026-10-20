// Stable keys identify installed manuals independently of titles and edits.
export const sampleCatalog = [
  {
    key: "start-here",
    title: "Artifacty — Start here",
    artifactType: "document",
    format: "markdown",
    tags: ["sample", "manual", "getting-started"],
    content: `# Welcome to Artifacty

Artifacty stores agent outputs and keeps their version history. You can access the store through a browser, CLI, JSON API, or MCP. Open the **Feature guide** for a list of features. Open **Architecture** for a diagram of the system. Use the **Handoff exercise** to practice sharing and reviewing an artifact.

## Start locally

Use Node.js 22.12.0 or newer. The optional Babel 8 React renderer requires Node 22.18.x or newer within Node 22, or Node 24.11.0 or newer. Use an ES2024-capable browser, such as Safari 17.4 or newer, for Mermaid 12.1.0 diagrams. Diagrams use the classic look, dagre layout, and default theme. From the repository, run:

\`\`\`sh
npm install
npm start
\`\`\`

Open http://127.0.0.1:8787. The server binds to localhost by default. To start a background server, run \`node src/cli.js serve\`. To keep the server in the terminal, add \`--foreground\`. Use \`node src/cli.js status\` to check the server, \`stop\` to stop it, and \`doctor\` to check the installation.

## Publish and improve an artifact

1. Create a Markdown artifact in the browser, or run \`node src/cli.js publish --title "My first note" --content "Hello Artifacty" --format markdown\`.
2. Open the artifact.
3. Edit its content.
4. Save a new version. Earlier versions remain available.
5. Open the version history.
6. Compare the versions with a diff.
7. Add tags.
8. Use search to find the artifact again. Open **Advanced filters** or **Saved views** in the main dashboard when needed. These sections start collapsed; closing them preserves your filters.
9. Add a comment.
10. Request a review.
11. As the owner or administrator, record an approved or changes-requested status.
12. Create the initial administrator at **/login**.
13. Sign in as the administrator.
14. Open **Sharing** on the artifact. Anonymous single-user browsing does not expose Sharing.
15. Check which permissions apply to the artifact.
16. Grant read, comment, or edit access as needed.

## Choose your access model

Before you create accounts, Artifacty works as a local single-user store. After you create accounts, use personal accounts and tokens. Create the initial administrator at **/login**. In the desktop navigation rail, open **Administration**. On narrower screens, open **Menu** first. Use **Users** (**/admin/users**) for accounts. Use **Access** (**/admin/access**) for teams, access mode, and network rules. Administration also contains Backup, Retention, Webhooks, and Server update. In private mode, use personal authentication for ordinary artifact reads and creation. Server-wide tokens do not authorize those operations. The local CLI can administer the store directly.

A share link lets anyone with the link read the shared artifact until the link expires. It does not create an account or grant other account permissions. Links expire after seven days by default. Owners can share the latest version or pin the link to one version. In private mode, an administrator must explicitly enable share links. In public mode, owners can share links to private-visibility artifacts without enabling that setting. Revoke a link when you no longer need it. Changing the artifact owner invalidates existing links.

IP restrictions apply to share links by default. An administrator can enable an exception for valid read-only share links in **Administration → Access**. The exception permits only the shared preview and raw content outside the allowed IP ranges. It does not permit dashboard, API, or editing access. Private-mode share-link settings, expiry, and revocation still apply.

## Keep the manuals and back up the store

\`node src/cli.js samples install\` installs these four manuals once per installation scope. If you run the installation again, it skips active manuals. \`samples remove\` archives managed samples. It preserves their content and versions. Installing again restores archived manuals without replacing your edits. Your own artifacts do not become managed samples just because they have the same titles or tags.

Back up before maintenance. This build uses store schema 10. Older builds refuse newer stores. This manual describes the features implemented in the repository.

Before changing an existing store schema, Artifacty must create and verify a snapshot of the raw SQLite database, referenced version files, and any legacy index. Set ARTIFACTY_BACKUP_ON_UPDATE=true to also create snapshots when the application version changes. If the old application version is unknown, the first open creates a baseline snapshot. ARTIFACTY_UPGRADE_BACKUP_KEEP defaults to 3 automatic snapshots and accepts 1–1000.

Use \`artifacty backups list\`, \`artifacty backups verify <id>\`, and \`artifacty backups restore <id> --confirm restore-store\`. Stop every server and MCP process first. Restore creates a recovery snapshot before replacing the store. Restore also replaces credentials and security settings with their saved state. Previously revoked sessions, tokens, and links can therefore become valid again. These snapshots differ from portable JSON export backups.

If the current store is corrupt, preserve it and copy the selected snapshot to a new empty home before restoring there. If a restore leaves a .restore-* directory, preserve it. Find recoveryBackupId in its restore.json file. Restore that recovery snapshot into a new empty home. See docs/upgrade-backups.md in the repository for the full procedure.`
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
<header><p>ARTIFACTY / REFERENCE</p><h1>From an agent output to a shared record</h1><p>Use this guide to choose how to publish, review, share, and maintain artifacts. Use Node.js 22.12.0 or newer. The current store schema is 10. Mermaid 12.1.0 uses the classic look, dagre layout, and default theme. Use an ES2024-capable browser, such as Safari 17.4 or newer. The optional Babel 8 React renderer requires Node ^22.18.0 or &gt;=24.11.0.</p></header>
<nav aria-label="Guide sections"><a href="#formats">Formats</a> · <a href="#history">History and discovery</a> · <a href="#collaboration">Collaboration</a> · <a href="#access">Access</a> · <a href="#operations">Operations</a></nav>
<section id="formats"><h2>Formats and imports</h2><p>The 13 formats are HTML, Markdown, text, JSON, code, SVG, Mermaid, React, SARIF, CSV, image, video, and notebook. Choose an artifact type separately: a document, handoff, code review, test report, dashboard, diagram, component, table, or another supported type.</p><p>Bundles group multiple files under one artifact. Supported binary bundle assets include PDF, DOCX, XLSX, and ZIP. Importers convert outputs from Claude, Codex, Gemini, GitHub Copilot, Cursor, and generic inputs into artifacts. Use the browser import screen or <code>artifacty import --agent codex --file handoff.md</code>.</p><p>Treat artifact content as untrusted. Browser previews restrict how content can run. A public HTML share preview is static: it blocks scripts and external resources. Share links display source text for other formats that can run active content. Interactive features do not work in these shared previews.</p></section>
<section id="history"><h2>Versions, discovery, and retrieval</h2><ul><li>Ordinary updates append versions. Administrators can repair or delete individual versions through audited operations. You can read earlier versions and compare them with a diff. Use an expected-version check to prevent your update from overwriting another edit.</li><li>Archive artifacts to hide them without losing their history. Restore them when needed. Integrity checks verify stored files and hashes and identify files that no artifact references.</li><li>Search by keyword and filter by tags, source agent, artifact type, publisher, dates, review status, relationships, and archive state. Use pages and groups to navigate large lists. To reuse a set of filters, save it as a view. Search stays visible in the main dashboard. Open Advanced filters or Saved views when needed. Both sections start collapsed; closing them preserves selected filters.</li><li>When available, SQLite FTS5 makes keyword search faster. Otherwise, search uses metadata. Optional embeddings enable semantic and hybrid search. Without a configured provider, those modes use keyword search. Rebuild search or embedding indexes after configuration changes.</li></ul></section>
<section id="collaboration"><h2>Relationships, comments, review, and notifications</h2><p>Connect artifacts with derived-from, supersedes, reviews, references, or part-of relations. You can reply in comment threads and anchor comments to specific content. Resolve a thread after you address it. Review status can be none, pending, changes-requested, or approved.</p><p>The inbox at <code>/inbox</code> collects relevant shares, comments, review activity, and new versions. Each user sees notifications based on their current artifact access. You can mark items read individually or together. A notification does not grant access.</p><p>Use audit records to investigate activity. Event polling and server-sent events return activity that the caller is authorized to read. Webhooks send configured events to validated destinations. Integrations can use event filters, replay cursors, and webhook administration.</p></section>
<section id="access"><h2>Accounts, permissions, share links, and network rules</h2><p>Create the initial administrator at <code>/login</code>. In the navigation, administrators open <strong>Administration</strong>. Use Users at <code>/admin/users</code> for accounts. Use Access at <code>/admin/access</code> for teams, access mode, and network rules. Backup, Retention, Webhooks, and Server update are in the same group. The artifact <strong>Sharing</strong> panel shows which permissions apply and where they come from. You can grant read, comment, or edit access to users and teams. If more than one grant applies, the strongest permission wins. Owners and administrators have management permissions separate from these grants. Token scopes limit what a token can do. They do not grant access to artifacts.</p><p>Ordinary artifact access in private mode requires an active personal account. Server-wide tokens do not authorize ordinary artifact reads or creation in private mode. Administrator APIs have their own authorization rules. Personal tokens must satisfy both their scopes and the user's artifact permissions. Trusted local CLI operations can administer the local store directly.</p><p>Anyone with a valid share link can read the shared artifact. Links expire after seven days by default and can show the latest version or one pinned version. In private mode, an administrator must explicitly enable share links. In public mode, owners can share links to private-visibility artifacts without enabling that setting. You can revoke links. Changing the artifact owner invalidates existing links. A link permits access only to its read-only shared preview and content.</p><p>Network allow rules accept IP addresses and CIDRs. First, stage a change. Next, verify access from the intended peer. Then confirm the change within 120 seconds or roll it back. Pending state survives a restart. Before the next access, the server checks for expiry. If the change has expired, the server restores the previous rules. Rules use the address of the peer connected to the server socket. Forwarded proxy headers do not change that address. IP restrictions apply to share links by default. Administrators can enable an exception for valid read-only share links outside the allowed IP ranges. The exception permits only the shared preview and raw content. It does not permit dashboard, API, or editing access. Private-mode share-link settings, expiry, and revocation still apply.</p></section>
<section id="operations"><h2>Interfaces and maintenance</h2><ul><li>The browser supports creation, import, viewing, editing, discovery, review, inbox, and administration. On desktop, use the navigation rail. On narrower screens, open Menu. Artifacts and Inbox lead to your work; New and Import add content. Account contains Account &amp; API tokens, password changes, and sign-out. API docs and language selection are also in the navigation. Administrators can open Server update at /admin/update. Checking for the latest release does not install it. Web updates support non-root Linux systemd user services. Before starting an update, confirm the displayed version and acknowledge that Artifacty will back up the store and restart the service. Keep the page open to reconnect and read the result.</li><li>The CLI supports serve/start/stop/status, publish/import/update/read/list, history and diff, relations/comments/review, saved views, event watching, account import, backup, retention, indexes, integrity, and diagnostics. Run <code>artifacty help</code> for exact flags.</li><li>The JSON API exposes artifacts and operational endpoints under <code>/api/</code>. MCP exposes agent tools through stdio and optional HTTP transport. Use <code>artifacty install claude --dry-run</code> to inspect integration configuration and <code>artifacty check</code> to verify tool discovery.</li><li>Export and import JSON backups to move a store. Upgrade snapshots are a separate backup format. They preserve the raw SQLite database, referenced version files, and any legacy index. Schema migrations always require a verified snapshot. Set <code>ARTIFACTY_BACKUP_ON_UPDATE=true</code> for application-version snapshots, including an unknown-version baseline. <code>ARTIFACTY_UPGRADE_BACKUP_KEEP</code> defaults to 3 and accepts 1–1000.</li><li>Use <code>artifacty backups list</code>, <code>artifacty backups verify &lt;id&gt;</code>, and <code>artifacty backups restore &lt;id&gt; --confirm restore-store</code>. Stop every server and MCP process first. Restore saves a recovery snapshot before replacing the store. It also restores the saved credentials and security settings. Revoked sessions, tokens, or links can become valid again. For a corrupt store, copy the snapshot to a new empty home and restore there. Preserve any <code>.restore-*</code> directory left by an interrupted restore. Find recoveryBackupId in its <code>restore.json</code> file and restore that recovery snapshot into a new empty home. See <code>docs/upgrade-backups.md</code>.</li><li>Retention supports archive rules, archived-item purge, audit/event history limits, and protected tags. Before you permanently delete artifacts, inspect a dry run.</li><li><code>artifacty samples install</code> installs these manuals without creating duplicates when you run it again. <code>artifacty samples remove</code> archives only managed samples in the current scope. Reinstallation restores existing versions and user edits.</li></ul><p>Keep ARTIFACTY_HOME private. Older builds refuse schema-10 stores. Before changing builds, preserve a backup. See the repository integration documentation for agent and API examples.</p></section>
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

Practice handing an artifact from an author to a reviewer. Keep its evidence, access permissions, and next action clear. Create a separate artifact for this exercise. Keep this manual as a reference.

## Current state

The four sample manuals are installed. You can open the browser dashboard. To practice multi-user access, first ask an administrator to create the author and reviewer accounts. Local single-user mode cannot demonstrate how separate accounts restrict access.

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
12. Check which permission applies to the reviewer and where it comes from. If the reviewer has edit access through a team, that stronger grant wins. Token scopes do not grant artifact access.
13. To demonstrate comment-only access, remove any stronger grant.
14. Ask the reviewer to add an anchored comment recommending **changes-requested**.
15. As the owner or administrator, record that review status.
16. Address the comment in a new version.
17. Resolve the comment thread.
18. When the reviewer agrees that the evidence supports approval, record **approved** as the owner or administrator.
19. Check each participant's inbox for relevant sharing, comment, review, and new-version activity.
20. Mark notifications read. Users can read only notifications allowed by their current access.
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

As an administrator, open **Administration → Access** (**/admin/access**) to inspect access mode and network rules. On narrower screens, open **Menu** first. You can switch access mode or stage a network change.

1. Before you stage a network change, keep your actual socket peer address in the allowed rules.
2. Stage the change.
3. Test the new route.
4. Within 120 seconds, confirm the change or roll it back.

Unconfirmed changes remain pending across a restart. Before the next access, the server checks for expiry and rolls back an expired change. Proxy forwarding headers do not change the peer address used by the rule. IP restrictions also apply to share links unless an administrator enables the read-only share-link exception. This exception does not grant dashboard, API, or editing access. Private-mode share-link settings, expiry, and revocation still apply.

In private mode, use personal authentication for ordinary artifact reads and creation. Server-wide tokens do not authorize those operations. Administrator APIs have their own authorization rules. The local CLI can administer the store directly. Before testing backup or retention, export a backup. Before a purge, review the purge plan.

## Completion check

Confirm that you can identify the approved version, follow its relation to the evidence, and explain which permission applies to the reviewer. Check that the revoked link no longer opens. Record any unfinished work in the handoff.

Removing samples archives only the managed manuals. Reinstalling restores your edited manual versions without replacing them. Removing samples does not archive the exercise artifacts you created separately.`
  }
];
