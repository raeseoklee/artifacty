const panel = document.querySelector("[data-update-status]");

if (panel?.dataset.active === "true") {
  const messages = JSON.parse(panel.dataset.messages);
  const stateLabel = panel.querySelector("[data-update-state]");
  const errorLabel = panel.querySelector("[data-update-error]");
  const versionLabel = document.querySelector("[data-update-version]");

  async function refreshStatus() {
    let retry = true;
    try {
      const response = await fetch("/admin/update/status", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if ([401, 403].includes(response.status)) {
        stateLabel.textContent = messages.signIn;
        panel.querySelector("[data-update-login]").hidden = false;
        return;
      }
      if (!response.ok) throw new Error("Status unavailable");
      const status = await response.json();
      if (status.currentVersion) versionLabel.textContent = status.currentVersion;
      if (status.run) {
        stateLabel.textContent = messages[status.run.state] || messages.running;
        errorLabel.textContent = status.run.error || "";
        retry = ["queued", "running"].includes(status.run.state);
      }
    } catch {
      stateLabel.textContent = messages.reconnect;
    }
    if (retry) window.setTimeout(refreshStatus, 3000);
  }

  window.setTimeout(refreshStatus, 1500);
}
