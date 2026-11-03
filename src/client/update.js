const panel = document.querySelector("[data-update-status]");

if (panel?.dataset.active === "true") {
  const messages = JSON.parse(panel.dataset.messages);
  const stateLabel = panel.querySelector("[data-update-state]");
  const errorLabel = panel.querySelector("[data-update-error]");
  const versionLabel = document.querySelector("[data-update-version]");
  const progress = panel.querySelector("[data-update-progress]");
  const bar = panel.querySelector("[data-update-bar]");
  const stepLabel = panel.querySelector("[data-update-step]");
  const steps = ["preparing", "staging", "backup", "switching", "health"];

  function refreshProgress(run) {
    if (!progress || !bar || !stepLabel) return;
    const active = ["queued", "running"].includes(run.state);
    const index = active ? steps.indexOf(run.step) : -1;
    const value = run.state === "succeeded" ? 5 : index >= 0 ? index : null;
    const label = run.state === "succeeded" ? messages.steps.completed : index >= 0
      ? messages.stepCount.replace("{current}", String(index + 1)).replace("{total}", "5").replace("{phase}", messages.steps[run.step])
      : run.step === "recovery" ? messages.steps.recovery : messages[run.state] || messages.running;
    stepLabel.textContent = label;
    progress.setAttribute("aria-valuetext", label);
    if (value === null) progress.removeAttribute("aria-valuenow");
    else progress.setAttribute("aria-valuenow", String(value));
    bar.style.width = `${value === null ? 100 : value * 20}%`;
    bar.classList.toggle("progress-bar-striped", value === null && active);
    bar.classList.toggle("progress-bar-animated", value === null && active);
    bar.classList.toggle("bg-danger", ["failed", "interrupted"].includes(run.state));
  }

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
        refreshProgress(status.run);
        retry = ["queued", "running"].includes(status.run.state);
      }
    } catch {
      stateLabel.textContent = messages.reconnect;
    }
    if (retry) window.setTimeout(refreshStatus, 3000);
  }

  window.setTimeout(refreshStatus, 1500);
}
