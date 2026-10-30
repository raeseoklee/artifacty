const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function renderCategoryFilter({ categories, selected, view }) {
  return `<label class="dashboard-field category-filter"><span>${view.text("category.filter")}</span><select name="categoryId" class="form-select"><option value="">${view.text("category.all")}</option>${categories.map((category) => `<option value="${escape(category.id)}"${selected === category.id ? " selected" : ""}>${escape(category.name)}${category.scope === "team" ? ` · ${escape(category.teamName)}` : ""}</option>`).join("")}</select></label>`;
}

export function renderCategoriesBody({ categories, teams, artifact, view, user }) {
  const messages = Object.fromEntries(["saving", "saved", "error", "deleteConfirm", "count", "countOne"].map((key) => [key, view.raw(`category.${key}`, key === "count" ? { count: "{count}" } : {})]));
  return `<main id="main-content" class="settings-page artifact-view" data-category-manager data-artifact-id="${escape(artifact?.id || "")}" data-artifact-archived="${artifact?.archivedAt ? "true" : "false"}">
    <div class="dashboard-heading"><h1>${view.text("category.title")}</h1><a href="${view.href("/")}">${view.text("nav.artifacts")}</a></div>
    <p class="muted">${view.text("category.help")}</p>
    ${artifact ? `<section class="meta-card category-artifact-summary"><h2><a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">${escape(artifact.title)}</a></h2><p>${view.text("category.membershipHelp")}</p></section>` : ""}
    <div class="category-teams"><strong>${view.text(user?.role === "admin" ? "category.managedTeams" : "category.yourTeams")}</strong><span>${teams.length ? teams.map((team) => `<span class="tag">${escape(team.name)}</span>`).join(" ") : view.text("category.noTeams")}</span>${user?.role === "admin" ? `<a href="${view.href("/admin/access")}">${view.text("category.manageTeams")}</a>` : `<span class="muted">${view.text("category.teamHelp")}</span>`}</div>
    <details class="meta-card category-create"${categories.length ? "" : " open"}><summary>${view.text("category.create")}</summary><form data-category-create class="editor-form">
      <label class="field"><span>${view.text("category.name")}</span><input name="name" required maxlength="120" class="form-control" autocomplete="off"></label>
      <label class="field"><span>${view.text("category.scope")}</span><select name="scope" class="form-select"><option value="personal">${view.text("category.personal")}</option>${teams.length ? `<option value="team">${view.text("category.team")}</option>` : ""}</select></label>
      <label class="field" data-category-team-field hidden><span>${view.text("category.team")}</span><select name="teamId" class="form-select">${teams.map((team) => `<option value="${escape(team.id)}">${escape(team.name)}</option>`).join("")}</select></label>
      <div><button class="btn btn-primary" type="submit">${view.text("category.create")}</button></div>
    </form></details>
    <p role="status" aria-live="polite" data-category-status></p>
    <section class="category-list" aria-label="${view.attr("category.title")}">${categories.length ? categories.map((category) => `<section class="meta-card" data-category-id="${escape(category.id)}"><div class="category-row${artifact ? " category-row-membership" : ""}">
      ${artifact ? `<label class="checkbox-field"><input type="checkbox" class="form-check-input" data-category-membership${category.containsArtifact ? " checked" : ""} aria-label="${view.attr("category.include", { name: category.name })}"> ${view.text("category.included")}</label>` : ""}
      <label class="field category-name"><span>${view.text("category.name")}</span><input class="form-control" data-category-name maxlength="120" required value="${escape(category.name)}" aria-label="${view.attr("category.rename", { name: category.name })}"></label>
      <span class="muted">${category.scope === "team" ? `${view.text("category.team")} · ${escape(category.teamName)}` : view.text("category.personal")}</span>
      <a data-category-count="${category.artifactCount}" href="${view.href(`/?categoryId=${encodeURIComponent(category.id)}`)}">${view.text(category.artifactCount === 1 ? "category.countOne" : "category.count", { count: category.artifactCount })}</a>
      <button type="button" class="btn btn-outline-danger" data-category-delete>${view.text("category.delete")}</button>
    </div></section>`).join("") : `<p class="empty">${view.text("category.empty")}</p>`}</section>
    <noscript><p>${view.text("category.javascript")}</p></noscript>
    <script type="application/json" id="category-messages">${JSON.stringify(messages).replaceAll("<", "\\u003c")}</script>
  </main>`;
}
