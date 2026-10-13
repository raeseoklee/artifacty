const themeChoices = new Set(["system", "light", "dark"]);
let selectedTheme = "system";
const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");

function readSavedTheme() {
  try {
    const saved = localStorage.getItem("artifacty_theme");
    return themeChoices.has(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme) {
  selectedTheme = themeChoices.has(theme) ? theme : "system";
  if (selectedTheme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", selectedTheme);
  document.documentElement.setAttribute("data-bs-theme", selectedTheme === "system" ? (systemTheme?.matches ? "dark" : "light") : selectedTheme);
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === selectedTheme));
  }
}

applyTheme(readSavedTheme());
systemTheme?.addEventListener("change", () => { if (selectedTheme === "system") applyTheme("system"); });

document.addEventListener("DOMContentLoaded", () => {
  for (const control of document.querySelectorAll("[data-theme-controls]")) control.hidden = false;
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      const choice = button.dataset.themeChoice;
      if (!themeChoices.has(choice)) return;
      applyTheme(choice);
      try { localStorage.setItem("artifacty_theme", choice); } catch { /* Keep the current page usable when storage is blocked. */ }
    });
  }
  applyTheme(selectedTheme);
});

window.addEventListener("storage", (event) => {
  if (event.key === "artifacty_theme" || event.key === null) applyTheme(readSavedTheme());
});
