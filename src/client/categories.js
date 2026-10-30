const manager = document.querySelector("[data-category-manager]");
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
