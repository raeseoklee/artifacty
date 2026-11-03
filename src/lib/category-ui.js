const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");


function sameCategoryScope(left, right) {
  return left.scope === right.scope && (left.scope !== "team" || left.teamId === right.teamId);
}

export function categoryPathLabel(category, categories) {
  const byId = new Map(categories.map(item => [item.id, item]));
  const labels = [category.name];
  const visited = new Set([category.id]);
  let parent = byId.get(category.parentId);
  while (parent && sameCategoryScope(category, parent) && !visited.has(parent.id)) {
    labels.unshift(parent.name); visited.add(parent.id); parent = byId.get(parent.parentId);
  }
  return labels.join(" / ");
}

function parentChoices(categories, category) {
  const byId = new Map(categories.map(item => [item.id, item]));
  return categories.filter(candidate => {
    if (!sameCategoryScope(candidate, category)) return false;
    const visited = new Set();
    let current = candidate;
    while (current && !visited.has(current.id)) {
      if (current.id === category.id) return false;
      visited.add(current.id); current = byId.get(current.parentId);
    }
    return true;
  });
}

function parentOptions(categories, category, view) {
  return `<option value="">${view.text("category.root")}</option>${parentChoices(categories, category).map(item => `<option value="${escape(item.id)}"${item.id === category.parentId ? " selected" : ""}>${escape(categoryPathLabel(item, categories))}</option>`).join("")}`;
}

export function renderCategoryFilter({ categories, selected, view }) {
  return `<label class="dashboard-field category-filter"><span>${view.text("category.filter")}</span><select name="categoryId" class="form-select"><option value="">${view.text("category.all")}</option>${categories.map((category) => `<option value="${escape(category.id)}"${selected === category.id ? " selected" : ""}>${escape(categoryPathLabel(category, categories))}${category.scope === "team" ? ` · ${escape(category.teamName)}` : ""}</option>`).join("")}</select></label>`;
}

export function renderCategoriesBody({ categories, teams, artifact, view, user }) {
  const messages = Object.fromEntries(["saving", "saved", "error", "deleteConfirm", "count", "countOne", "root", "hasChildren"].map((key) => [key, view.raw(`category.${key}`, key === "count" ? { count: "{count}" } : {})]));
  return `<main id="main-content" class="settings-page artifact-view" data-category-manager data-artifact-id="${escape(artifact?.id || "")}" data-artifact-archived="${artifact?.archivedAt ? "true" : "false"}">
    <div class="dashboard-heading"><h1>${view.text("category.title")}</h1><a href="${view.href("/")}">${view.text("nav.artifacts")}</a></div>
    <p class="muted">${view.text("category.help")}</p><p class="muted">${view.text("category.hierarchyHelp")}</p>
    ${artifact ? `<section class="meta-card category-artifact-summary"><h2><a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">${escape(artifact.title)}</a></h2><p>${view.text("category.membershipHelp")}</p></section>` : ""}
    <div class="category-teams"><strong>${view.text(user?.role === "admin" ? "category.managedTeams" : "category.yourTeams")}</strong><span>${teams.length ? teams.map((team) => `<span class="tag">${escape(team.name)}</span>`).join(" ") : view.text("category.noTeams")}</span>${user?.role === "admin" ? `<a href="${view.href("/admin/access")}">${view.text("category.manageTeams")}</a>` : `<span class="muted">${view.text("category.teamHelp")}</span>`}</div>
    <details class="meta-card category-create"${categories.length ? "" : " open"}><summary>${view.text("category.create")}</summary><form data-category-create class="editor-form">
      <label class="field"><span>${view.text("category.name")}</span><input name="name" required maxlength="120" class="form-control" autocomplete="off"></label>
      <label class="field"><span>${view.text("category.scope")}</span><select name="scope" class="form-select"><option value="personal">${view.text("category.personal")}</option>${teams.length ? `<option value="team">${view.text("category.team")}</option>` : ""}</select></label>
      <label class="field" data-category-team-field hidden><span>${view.text("category.team")}</span><select name="teamId" class="form-select">${teams.map((team) => `<option value="${escape(team.id)}">${escape(team.name)}</option>`).join("")}</select></label>
      <label class="field"><span>${view.text("category.parent")}</span><select name="parentId" class="form-select">${parentOptions(categories, { scope: "personal" }, view)}</select></label>
      <div><button class="btn btn-primary" type="submit">${view.text("category.create")}</button></div>
    </form></details>
    <p role="status" aria-live="polite" data-category-status></p>
    <section class="category-list" aria-label="${view.attr("category.title")}">${categories.length ? categories.map((category) => `<section class="meta-card" data-category-id="${escape(category.id)}"><div class="category-row${artifact ? " category-row-membership" : ""}">
      ${artifact ? `<label class="checkbox-field"><input type="checkbox" class="form-check-input" data-category-membership${category.containsArtifact ? " checked" : ""} aria-label="${view.attr("category.include", { name: category.name })}"> ${view.text("category.included")}</label>` : ""}
      <label class="field category-name"><span>${view.text("category.name")}</span><input class="form-control" data-category-name maxlength="120" required value="${escape(category.name)}" aria-label="${view.attr("category.rename", { name: category.name })}"></label>
      <label class="field category-parent"><span>${view.text("category.parent")}</span><select class="form-select" data-category-parent aria-label="${view.attr("category.move", { name: category.name })}">${parentOptions(categories, category, view)}</select></label>
      <span class="muted">${category.scope === "team" ? `${view.text("category.team")} · ${escape(category.teamName)}` : view.text("category.personal")}</span>
      <a data-category-count="${category.artifactCount}" href="${view.href(`/?categoryId=${encodeURIComponent(category.id)}`)}">${view.text(category.artifactCount === 1 ? "category.countOne" : "category.count", { count: category.artifactCount })}</a>
      <button type="button" class="btn btn-outline-danger" data-category-delete>${view.text("category.delete")}</button>
    </div></section>`).join("") : `<p class="empty">${view.text("category.empty")}</p>`}</section>
    <noscript><p>${view.text("category.javascript")}</p></noscript>
    <script type="application/json" id="category-data">${JSON.stringify(categories.map(({id, name, scope, teamId, parentId}) => ({id, name, scope, teamId, parentId}))).replaceAll("<", "\\u003c")}</script>
    <script type="application/json" id="category-messages">${JSON.stringify(messages).replaceAll("<", "\\u003c")}</script>
  </main>`;
}

// The sidebar loads only the signed-in user's categories through the checked API.
// Keeping this shell independent of category data lets every page share it.
export function renderCategoryNavigation({ user, view }) {
  if (!user) return "";
  const keys = ["allArtifacts", "manage", "personal", "teams", "empty", "loadError", "added", "alreadyIncluded", "undo", "undone", "choose", "dropHint", "partialError", "selectionLimit", "saving", "error"];
  const messages = Object.fromEntries(keys.map(key => [key, view.raw(`category.${key}`, { count: "{count}", name: "{name}" })]));
  const current = new URL(view.currentPath || "/", "http://artifacty.local");
  return `<details class="category-navigation" data-category-navigation data-category-user="${escape(user.id)}" data-category-selected="${escape(current.searchParams.get("categoryId") || "")}" data-category-home="${escape(view.href("/"))}" data-category-messages="${escape(JSON.stringify(messages))}" open>
    <summary>${view.text("category.navigation")}</summary>
    <div class="category-navigation-content"><a class="category-all-link" href="${view.href("/")}">${view.text("category.allArtifacts")}</a><div data-category-tree></div><a class="category-manage-link" href="${view.href("/categories")}">${view.text("category.manage")}</a></div>
    <p class="category-navigation-status" data-category-nav-status role="status" aria-live="polite"></p><button class="btn btn-outline-secondary category-undo" type="button" data-category-undo hidden>${view.text("category.undo")}</button>
  </details>`;
}
