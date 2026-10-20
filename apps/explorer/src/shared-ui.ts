import {
  descriptionListMarkup,
  emptyStateMarkup,
  enhanceDropdowns,
  headerMarkup,
  supportButtonMarkup,
  iconMarkup,
  observeShell,
  panelMarkup,
  progressMarkup,
  taskStatusMarkup,
  type IconName,
  type NavigationItem,
} from "@powerpuff-kitty/tcsn-design-system";

function fromMarkup<T extends Element>(markup: string): T {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.firstElementChild as T;
}

/** Shared Font Awesome definitions are bundled locally by the design system. */
export function sharedIcon(name: IconName): SVGSVGElement {
  return fromMarkup<SVGSVGElement>(iconMarkup(name, { className: "icon" }));
}

export function sharedDescriptionList(
  items: { term: string; value: string }[],
): HTMLDListElement {
  return fromMarkup<HTMLDListElement>(descriptionListMarkup({ items }));
}

export function sharedEmptyState(
  description: string,
  actions: NavigationItem[] = [],
): HTMLLIElement {
  const root = fromMarkup<HTMLLIElement>(
    emptyStateMarkup({ as: "li", description, actions }),
  );
  root.classList.add("empty");
  return root;
}

const tasks = new Map<
  string,
  { root: HTMLElement; progress: HTMLProgressElement; text: HTMLElement }
>();
export function setTaskBusy(busy: boolean, id = "status"): void {
  const task = tasks.get(id);
  if (!task) return;
  task.root.dataset.busy = String(busy);
  task.progress.hidden = !busy;
}
export function setTaskTone(
  tone: "info" | "error" | "success",
  id = "status",
): void {
  const task = tasks.get(id);
  if (!task) return;
  task.text.dataset.tone = tone;
  task.text.setAttribute("role", tone === "error" ? "alert" : "status");
  task.text.setAttribute(
    "aria-live",
    tone === "error" ? "assertive" : "polite",
  );
}
function initializeTasks(): void {
  for (const [id, label] of [
    ["status", "Searching satellite catalogues"],
    ["upcoming-status", "Searching ESA acquisition plans"],
  ]) {
    const existing = document.getElementById(id)!;
    const root = fromMarkup<HTMLElement>(
      taskStatusMarkup({
        status: existing.textContent || "",
        cancellable: false,
        id: id + "-task",
      }),
    );
    const text = root.querySelector<HTMLElement>(".tcsn-task-status__text")!;
    text.id = id;
    text.classList.add("status");
    const progress = fromMarkup<HTMLProgressElement>(
      progressMarkup({ label, id: id + "-progress" }),
    );
    progress.hidden = true;
    existing.replaceWith(root, progress);
    tasks.set(id, { root, progress, text });
  }
}

function initializePatterns(): void {
  for (const selector of ["#sources", "#paid-maps"]) {
    const existing = document.querySelector<HTMLDetailsElement>(selector);
    if (!existing) continue;
    const summary = existing.querySelector("summary")!;
    const panel = fromMarkup<HTMLDetailsElement>(
      panelMarkup({
        title: summary.textContent!.trim(),
        open: existing.open,
        id: existing.id,
      }),
    );
    panel.classList.add(...existing.classList);
    const body = panel.querySelector(".tcsn-panel__body")!;
    for (const node of [...existing.childNodes])
      if (node !== summary) body.append(node);
    existing.replaceWith(panel);
  }
  const regions = [
    [".panel", "Satellite image search", "y"],
    [".observations", "Observations", "y"],
    [".matrix-scroll", "Observation calendar", "x"],
  ];
  for (const [selector, label, axis] of regions) {
    const region = document.querySelector<HTMLElement>(selector)!;
    region.classList.add("tcsn-scroll-region");
    region.setAttribute("role", "region");
    region.setAttribute("tabindex", "0");
    region.setAttribute("aria-label", label);
    region.dataset.axis = axis;
  }
}

/** Only interface chrome is themed; map imagery and chart encodings retain data colours. */
export function initializeSharedUi(): () => void {
  initializeTasks();
  initializePatterns();
  const header = document.querySelector<HTMLElement>("#app-header")!;
  header.innerHTML = headerMarkup({
    brand: "satellite images.",
    href: "./",
    actions: [{ label: "Contact", href: "https://tcsn.io/contact" }],
  });
  header.querySelector("nav")!.insertAdjacentHTML("beforeend", supportButtonMarkup());
  document.querySelector("#sidebar-copyright")!.textContent = `© ${new Date().getFullYear()} TCSN`;
  const shell = observeShell();
  const main = document.querySelector<HTMLElement>("main")!;
  const controller = new AbortController();

  main.querySelector("#search-form")?.classList.add("tcsn-tabs");
  function labelField(control: HTMLInputElement | HTMLSelectElement) {
    const label = control.closest("label");
    if (!label) return;
    label.classList.add("tcsn-field");
    for (const node of [...label.childNodes])
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        const text = document.createElement("span");
        text.className = "tcsn-field__label";
        text.textContent = node.textContent.trim();
        node.replaceWith(text);
      }
  }
  function decorate() {
    for (const tab of main.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    for (const button of main.querySelectorAll<HTMLButtonElement>(
      "button:not(.tcsn-dropdown__trigger)",
    )) {
      button.classList.add("tcsn-button");
      if (
        button.matches(
          ".text-button,.matrix-link,.matrix-more-toggle,.matrix-menu-item",
        )
      )
        button.dataset.variant = "ghost";
      if (
        button.matches(
          ".matrix-chip,.matrix-link,.matrix-menu-item,.matrix-more-toggle,.matrix-year-button,.map-preview-arrow,.map-preview-close,.maplibregl-ctrl button",
        )
      )
        button.dataset.size = "sm";
      if (
        button.matches(
          ".matrix-year-button,.map-preview-arrow,.map-preview-close,.maplibregl-ctrl button",
        )
      )
        button.dataset.appearance = "icon";
    }
    for (const input of main.querySelectorAll<HTMLInputElement>(
      "input:not([type=hidden])",
    )) {
      if (input.type === "checkbox" || input.type === "radio") {
        input.closest("label")?.classList.add("tcsn-check");
      } else {
        input.classList.add(input.type === "range" ? "tcsn-slider" : input.type === "file" ? "tcsn-file" : "tcsn-input");
        labelField(input);
      }
    }
    for (const feedback of main.querySelectorAll('.status[role="status"]')) {
      feedback.classList.add("tcsn-feedback");
      feedback.setAttribute("aria-atomic", "true");
    }
    for (const select of main.querySelectorAll("select")) labelField(select);
    for (const link of main.querySelectorAll<HTMLAnchorElement>(
      "a.secondary-button",
    ))
      link.classList.add("tcsn-button");
    for (const placeholder of main.querySelectorAll<HTMLElement>(
      "[data-shared-icon]",
    )) {
      placeholder.replaceWith(
        sharedIcon(placeholder.dataset.sharedIcon as IconName),
      );
    }
    const controls: Record<string, IconName> = {
      "maplibregl-ctrl-zoom-in": "plus",
      "maplibregl-ctrl-zoom-out": "minus",
      "maplibregl-ctrl-compass": "compass",
      "maplibregl-ctrl-attrib-button": "circle-info",
    };
    for (const [className, name] of Object.entries(controls)) {
      for (const button of main.querySelectorAll<HTMLButtonElement>(
        `.${className}`,
      )) {
        const host =
          button.querySelector<HTMLElement>(".maplibregl-ctrl-icon") || button;
        if (!host.querySelector(".tcsn-icon"))
          host.replaceChildren(sharedIcon(name));
      }
    }
  }
  decorate();
  const dropdowns = enhanceDropdowns(main);
  // Dynamic scene cards and renderer controls are ordinary DOM, independent of SDK search state.
  const observer = new MutationObserver(decorate);
  observer.observe(main, { childList: true, subtree: true });
  const tabs = [...main.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  main.querySelector('[role="tablist"]')?.addEventListener(
    "keydown",
    (event) => {
      const key = (event as KeyboardEvent).key;
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? tabs.length - 1
            : (current + (key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      // Click runs the existing catalogue/tab state transition as well as updating ARIA.
      tabs[next].click();
      tabs[next].focus();
    },
    { signal: controller.signal },
  );
  return () => {
    tasks.clear();
    controller.abort();
    observer.disconnect();
    dropdowns();
    shell();
  };
}
