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

// Marks a person's toggle so CSS animates it; page loads and changes synced
// from another tab apply instantly.
let sidebarMotionTimer;
function animateSidebar() {
  const root = document.documentElement;
  root.setAttribute("data-sidebar-motion", "");
  if (typeof setTimeout !== "function") return;
  clearTimeout(sidebarMotionTimer);
  sidebarMotionTimer = setTimeout(() => root.removeAttribute("data-sidebar-motion"), 450);
}
document.addEventListener("DOMContentLoaded", () => {
  for (const button of document.querySelectorAll("[data-sidebar-toggle]")) {
    button.hidden = false;
    button.addEventListener("click", () => {
      animateSidebar();
      applySidebar(!sidebarCollapsed);
      try { localStorage.setItem("artifacty_sidebar", sidebarCollapsed ? "collapsed" : "expanded"); } catch { /* Current page remains usable. */ }
    });
  }
  applySidebar(sidebarCollapsed);
  setupArtifactDock();
});
window.addEventListener("storage", (event) => {
  if (event.key !== "artifacty_sidebar" && event.key !== null) return;
  try { applySidebar(localStorage.getItem("artifacty_sidebar") === "collapsed"); } catch { /* Retain the current page choice. */ }
});

// Pull-down menus (details[data-menu]) close on an outside click or Escape, like native menus.
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details[data-menu][open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll("details[data-menu][open]")) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
});

// The artifact page's floating bar docks once the header controls, ending
// with the version switcher, have scrolled out above the viewport. Until then
// it is inert and hidden from assistive technology so nothing is duplicated.
function setupArtifactDock() {
  const dock = document.querySelector?.("[data-artifact-dock]");
  const sentinel = dock && (dock.dataset.dockAfter
    ? document.querySelector(dock.dataset.dockAfter)
    : document.querySelector(".version-strip:not(.artifact-dock-versions)") || document.querySelector(".topbar"));
  if (!dock || !sentinel || !("IntersectionObserver" in window)) return;
  mirrorDashboardFilters(dock);
  const setDocked = (docked) => {
    dock.classList.toggle("is-docked", docked);
    dock.inert = !docked;
    if (docked) {
      dock.removeAttribute("aria-hidden");
      dock.dispatchEvent(new Event("artifacty:docked"));
    }
    else {
      // Focus cannot stay inside content that becomes hidden.
      if (dock.contains(document.activeElement)) document.activeElement.blur();
      dock.setAttribute("aria-hidden", "true");
      for (const menu of dock.querySelectorAll("details[open]")) menu.open = false;
    }
  };
  new IntersectionObserver(([entry]) => setDocked(!entry.isIntersecting && entry.boundingClientRect.bottom <= 0)).observe(sentinel);
  dock.querySelector("[data-dock-top]")?.addEventListener("click", () => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
}

// On the artifact list the bar repeats the search field and category filter.
// They drive the page's own filter form, so its hidden filters, page size,
// and auto-apply behavior stay the single source of truth.
function mirrorDashboardFilters(dock) {
  const search = dock.querySelector("[data-dock-search]");
  const form = document.querySelector(".filter-form");
  if (!search || !form) return;
  const query = form.querySelector('input[name="q"]');
  const category = form.querySelector(".category-filter select");
  const slot = dock.querySelector("[data-dock-category]");
  let copy = null;
  if (category && slot) {
    copy = category.cloneNode(true);
    copy.removeAttribute("name");
    copy.removeAttribute("id");
    copy.setAttribute("aria-label", category.getAttribute("aria-label") || category.closest("label")?.textContent?.trim() || "");
    copy.addEventListener("change", () => {
      category.value = copy.value;
      category.dispatchEvent(new Event("change", { bubbles: true }));
    });
    slot.append(copy);
  }
  search.addEventListener("input", () => { if (query) query.value = search.value; });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (query) query.value = search.value;
    form.requestSubmit ? form.requestSubmit() : form.submit();
  });
  // Edits made in the page form while the bar was hidden show up when it docks.
  dock.addEventListener("artifacty:docked", () => {
    if (query && document.activeElement !== search) search.value = query.value;
    if (copy) copy.value = category.value;
  });
}
