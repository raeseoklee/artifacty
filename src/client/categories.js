const manager = typeof document === "undefined" ? null : document.querySelector("[data-category-manager]");
if (manager) {
  const messages = JSON.parse(document.getElementById("category-messages").textContent);
  const status = manager.querySelector("[data-category-status]");
  const createForm = manager.querySelector("[data-category-create]");
  const showStatus = (key, error) => { status.textContent = messages[key] + (error ? `: ${error.message}` : ""); status.setAttribute("role", error ? "alert" : "status"); };
  async function mutate(url, method, body) {
    showStatus("saving");
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || response.statusText);
    showStatus("saved");
    return result;
  }
  createForm.elements.scope.addEventListener("change", () => {
    createForm.querySelector("[data-category-team-field]").hidden = createForm.elements.scope.value !== "team";
  });
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = createForm.querySelector("button");
    button.disabled = true;
    try {
      const data = new FormData(createForm);
      await mutate("/api/categories", "POST", { name: data.get("name"), scope: data.get("scope"), ...(data.get("scope") === "team" ? { teamId: data.get("teamId") } : {}) });
      location.reload();
    } catch (error) { showStatus("error", error); button.disabled = false; }
  });
  for (const row of manager.querySelectorAll("[data-category-id]")) {
    const endpoint = `/api/categories/${encodeURIComponent(row.dataset.categoryId)}`;
    const name = row.querySelector("[data-category-name]");
    let savedName = name.value;
    name.addEventListener("change", async () => {
      if (name.value === savedName) return;
      if (!name.reportValidity()) { name.value = savedName; return; }
      name.disabled = true;
      try { const result = await mutate(endpoint, "PATCH", { name: name.value }); savedName = result.name; name.value = savedName; }
      catch (error) { name.value = savedName; showStatus("error", error); }
      finally { name.disabled = false; }
    });
    const checkbox = row.querySelector("[data-category-membership]");
    checkbox?.addEventListener("change", async () => {
      const desired = checkbox.checked;
      checkbox.disabled = true;
      try {
        await mutate(`${endpoint}/artifacts/${encodeURIComponent(manager.dataset.artifactId)}`, desired ? "PUT" : "DELETE");
        const count = row.querySelector("[data-category-count]");
        const next = Math.max(0, Number(count.dataset.categoryCount) + (manager.dataset.artifactArchived === "true" ? 0 : desired ? 1 : -1));
        count.dataset.categoryCount = String(next);
        count.textContent = (next === 1 ? messages.countOne : messages.count).replace("{count}", String(next));
      }
      catch (error) { checkbox.checked = !desired; showStatus("error", error); }
      finally { checkbox.disabled = false; }
    });
    row.querySelector("[data-category-delete]").addEventListener("click", async (event) => {
      if (!confirm(messages.deleteConfirm)) return;
      event.currentTarget.disabled = true;
      try { await mutate(endpoint, "DELETE"); row.remove(); }
      catch (error) { showStatus("error", error); row.querySelector("[data-category-delete]").disabled = false; }
    });
  }
}

export function categoryArtifactIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(id => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 100);
}

// The server's changed flag prevents undo from removing older memberships.
// An older server can still add memberships but does not offer unsafe undo.
export async function addCategoryArtifacts(fetcher, categoryId, rawIds) {
  const ids = categoryArtifactIds(rawIds);
  const added = [];
  const failed = [];
  for (const artifactId of ids) {
    try {
      const response = await fetcher(`/api/categories/${encodeURIComponent(categoryId)}/artifacts/${encodeURIComponent(artifactId)}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" } });
      if (!response.ok) throw new Error("Category addition failed");
      const result = await response.json();
      if (result.changed === true) added.push(artifactId);
    } catch { failed.push(artifactId); }
  }
  return { added, failed };
}

export function enhanceCategoryNavigation(document, fetcher = globalThis.fetch, storage) {
  const navigations = [...document.querySelectorAll("[data-category-navigation]")];
  const navigation = navigations[0];
  if (!navigation || !fetcher) return;
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { /* Storage can be blocked by browser policy. */ } }
  const trees = navigations.map(node => node.querySelector("[data-category-tree]"));
  let tree = trees[0];
  const statuses = navigations.map(node => node.querySelector("[data-category-nav-status]"));
  const undoButtons = navigations.map(node => node.querySelector("[data-category-undo]"));
  const status = { set textContent(value) { for (const node of statuses) node.textContent = value; } };
  const undo = {
    set hidden(value) { for (const button of undoButtons) button.hidden = value; },
    set disabled(value) { for (const button of undoButtons) button.disabled = value; },
    addEventListener(type, handler) { for (const button of undoButtons) button.addEventListener(type, handler); }
  };
  const messages = JSON.parse(navigation.dataset.categoryMessages);
  const selected = navigation.dataset.categorySelected;
  const text = (key, params = {}) => String(messages[key] || "").replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
  const storageKey = `artifacty.category-tree.${navigation.dataset.categoryUser}`;
  let savedState = {};
  try { savedState = JSON.parse(storage?.getItem(storageKey) || "{}"); } catch { /* Preferences are optional. */ }
  const remember = (details, key) => {
    if (typeof savedState[key] === "boolean") details.open = savedState[key];
    details.addEventListener("toggle", () => {
      savedState[key] = details.open;
      try { storage?.setItem(storageKey, JSON.stringify(savedState)); } catch { /* Private mode may disable storage. */ }
    });
  };
  for (const node of navigations) remember(node, "root");
  let categories = [];
  let busy = false;
  let undoMemberships = null;
  const rows = [...document.querySelectorAll("[data-category-artifact-id]")];
  const selectedIds = dragged => {
    const checked = [...document.querySelectorAll("[data-category-selected-artifact]:checked")].map(input => input.dataset.categorySelectedArtifact);
    return categoryArtifactIds(checked.includes(dragged) ? checked : [dragged]);
  };
  for (const checkbox of document.querySelectorAll("[data-category-selected-artifact]")) {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && document.querySelectorAll("[data-category-selected-artifact]:checked").length > 100) {
        checkbox.checked = false;
        status.textContent = text("selectionLimit");
      }
    });
  }
  async function add(category, ids) {
    if (busy || !ids.length || category.canWrite === false) return;
    busy = true;
    undo.hidden = true;
    undoMemberships = null;
    status.textContent = text("saving");
    for (const node of navigations) node.setAttribute("aria-busy", "true");
    try {
      const result = await addCategoryArtifacts(fetcher, category.id, ids);
      status.textContent = result.failed.length ? text("partialError") : result.added.length ? text("added", { count: result.added.length, name: category.name }) : text("alreadyIncluded", { name: category.name });
      if (result.added.length) { undoMemberships = { categoryId: category.id, ids: result.added }; undo.hidden = false; }
    } finally { busy = false; for (const node of navigations) node.removeAttribute("aria-busy"); }
  }
  undo.addEventListener("click", async () => {
    if (busy || !undoMemberships) return;
    busy = true;
    undo.disabled = true;
    const remaining = [];
    for (const id of undoMemberships.ids) {
      try {
        const response = await fetcher(`/api/categories/${encodeURIComponent(undoMemberships.categoryId)}/artifacts/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
        if (!response.ok) remaining.push(id);
      } catch { remaining.push(id); }
    }
    undoMemberships.ids = remaining;
    status.textContent = remaining.length ? text("error") : text("undone");
    undo.hidden = remaining.length === 0;
    undo.disabled = false;
    busy = false;
  });
  for (const row of rows) {
    row.draggable = true;
    row.addEventListener("dragstart", event => {
      if (!event.dataTransfer || event.target.closest?.("input,textarea,select,button")) { event.preventDefault(); return; }
      event.dataTransfer.setData("application/x-artifacty-artifacts", JSON.stringify(selectedIds(row.dataset.categoryArtifactId)));
      event.dataTransfer.effectAllowed = "copy";
      row.classList.add("is-category-dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("is-category-dragging"));
  }
  function branch(label, key, parent = tree) {
    const details = document.createElement("details");
    details.className = "category-tree-group";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = label;
    details.append(summary);
    parent.append(details);
    remember(details, key);
    return details;
  }
  function categoryLink(category, parent) {
    const link = document.createElement("a");
    const url = new URL(navigation.dataset.categoryHome, document.location.href);
    url.searchParams.set("categoryId", category.id);
    link.href = `${url.pathname}${url.search}`;
    link.textContent = category.name;
    link.className = "category-tree-link";
    link.dataset.categoryDropId = category.id;
    if (selected === category.id) { link.setAttribute("aria-current", "page"); let ancestor = parent; while (ancestor && ancestor !== tree) { if (ancestor.tagName === "DETAILS") ancestor.open = true; ancestor = ancestor.parentElement; } }
    if (category.canWrite === false) link.setAttribute("data-category-readonly", "true");
    else {
      link.title = text("dropHint");
      link.addEventListener("dragover", event => {
        if (busy || !event.dataTransfer?.types.includes("application/x-artifacty-artifacts")) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "copy"; link.classList.add("is-drop-target");
      });
      link.addEventListener("dragleave", () => link.classList.remove("is-drop-target"));
      link.addEventListener("drop", event => {
        link.classList.remove("is-drop-target");
        if (!event.dataTransfer?.types.includes("application/x-artifacty-artifacts")) return;
        event.preventDefault();
        let ids;
        try { ids = categoryArtifactIds(JSON.parse(event.dataTransfer.getData("application/x-artifacty-artifacts"))); } catch { return; }
        add(category, ids);
      });
    }
    parent.append(link);
  }
  async function load() {
    try {
      const response = await fetcher("/api/categories", { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Categories unavailable");
      const result = await response.json();
      categories = Array.isArray(result.categories) ? result.categories : [];
      for (const currentTree of trees) {
        tree = currentTree;
        const personal = branch(text("personal"), "personal");
        const teams = branch(text("teams"), "teams");
        const grouped = new Map();
        for (const category of categories) {
          if (category.scope === "personal") categoryLink(category, personal);
          else {
            if (!grouped.has(category.teamId)) grouped.set(category.teamId, branch(category.teamName, `team:${category.teamId}`, teams));
            categoryLink(category, grouped.get(category.teamId));
          }
        }
        if (!categories.length) { const empty = document.createElement("p"); empty.textContent = text("empty"); tree.append(empty); }
      }
      for (const row of rows) {
        const choices = categories.filter(category => category.canWrite !== false);
        if (!choices.length) continue;
        const label = document.createElement("label");
        label.className = "category-quick-add";
        const caption = document.createElement("span"); caption.textContent = text("choose");
        const select = document.createElement("select"); select.className = "form-select"; select.setAttribute("aria-label", text("choose"));
        const initial = document.createElement("option"); initial.value = ""; initial.textContent = text("choose"); select.append(initial);
        for (const category of choices) { const option = document.createElement("option"); option.value = category.id; option.textContent = category.scope === "team" ? `${category.teamName} / ${category.name}` : category.name; select.append(option); }
        label.append(caption, select); row.append(label);
        select.addEventListener("change", async () => {
          const category = choices.find(item => item.id === select.value);
          if (!category) return;
          select.disabled = true;
          try { await add(category, selectedIds(row.dataset.categoryArtifactId)); } finally { select.value = ""; select.disabled = false; }
        });
      }
    } catch { status.textContent = text("loadError"); }
  }
  return load();
}
if (typeof document !== "undefined") enhanceCategoryNavigation(document);
