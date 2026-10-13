let sidebarCollapsed = false;
try { sidebarCollapsed = localStorage.getItem("artifacty_sidebar") === "collapsed"; } catch { /* Default expanded. */ }

function applySidebar(collapsed) {
  sidebarCollapsed = collapsed;
  if (collapsed) document.documentElement.setAttribute("data-sidebar", "collapsed");
  else document.documentElement.removeAttribute("data-sidebar");
  for (const button of document.querySelectorAll("[data-sidebar-toggle]")) {
    button.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? button.dataset.expandLabel : button.dataset.collapseLabel;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.querySelector("[data-sidebar-collapse-icon]").hidden = collapsed;
    button.querySelector("[data-sidebar-expand-icon]").hidden = !collapsed;
  }
}
applySidebar(sidebarCollapsed);
document.addEventListener("DOMContentLoaded", () => {
  for (const button of document.querySelectorAll("[data-sidebar-toggle]")) {
    button.hidden = false;
    button.addEventListener("click", () => {
      applySidebar(!sidebarCollapsed);
      try { localStorage.setItem("artifacty_sidebar", sidebarCollapsed ? "collapsed" : "expanded"); } catch { /* Current page remains usable. */ }
    });
  }
  applySidebar(sidebarCollapsed);
});
window.addEventListener("storage", (event) => {
  if (event.key !== "artifacty_sidebar" && event.key !== null) return;
  try { applySidebar(localStorage.getItem("artifacty_sidebar") === "collapsed"); } catch { /* Retain the current page choice. */ }
});
