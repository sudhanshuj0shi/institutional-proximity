// Small progressive enhancements for profile pages. Everything works without this file.

// Safeguard filter: switch dimensions in place instead of reloading.
const filter = document.querySelector<HTMLElement>("[data-safeguard-filter]");
if (filter) {
  const items = Array.from(document.querySelectorAll<HTMLElement>("[data-dimension]"));
  // The server may have rendered a filtered subset; only enhance when everything is present.
  const url = new URL(window.location.href);
  if (!url.searchParams.get("safeguard")) {
    filter.addEventListener("click", (ev) => {
      const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>("a[data-dim]");
      if (!a) return;
      ev.preventDefault();
      const dim = a.dataset.dim ?? "";
      for (const it of items) it.hidden = dim !== "" && it.dataset.dimension !== dim;
      for (const link of Array.from(filter.querySelectorAll("a[data-dim]"))) link.setAttribute("aria-current", link === a ? "true" : "false");
    });
  }
}
