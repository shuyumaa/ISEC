/**
 * Progressive enhancement for <table data-sortable>: header buttons sort the
 * existing <tbody> rows in place (no re-render), aria-sort reflects state and
 * a single status region announces the result.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortRows(rows: HTMLTableRowElement[], index: number, type: string, direction: string) {
  const factor = direction === "ascending" ? 1 : -1;
  const keyed = rows.map((row) => {
    const cell = row.cells[index]!;
    const raw = cell.dataset.value ?? cell.textContent?.trim() ?? "";
    return { row, key: type === "number" ? Number(raw) : raw };
  });
  keyed.sort((a, b) =>
    factor * (type === "number" ? (a.key as number) - (b.key as number) : collator.compare(a.key as string, b.key as string)),
  );
  return keyed.map((k) => k.row);
}

function reorder(tbody: HTMLTableSectionElement, rows: HTMLTableRowElement[]) {
  const move = "moveBefore" in tbody
    ? (row: HTMLTableRowElement) => (tbody as unknown as { moveBefore(n: Node, c: Node | null): void }).moveBefore(row, null)
    : (row: HTMLTableRowElement) => tbody.append(row);
  rows.forEach(move);
}

function sortBy(table: HTMLTableElement, button: HTMLButtonElement) {
  const th = button.closest("th")!;
  const tbody = table.tBodies[0]!;
  const type = th.dataset.type ?? "text";
  // Numbers start high-to-low (best first); text starts A–Z.
  const first = type === "number" ? "descending" : "ascending";
  const current = th.getAttribute("aria-sort");
  const direction = current ? (current === "ascending" ? "descending" : "ascending") : first;

  for (const header of table.tHead!.rows[0]!.cells) header.removeAttribute("aria-sort");
  th.setAttribute("aria-sort", direction);

  const rows = sortRows([...tbody.rows], th.cellIndex, type, direction);
  const scoped = table as unknown as { startViewTransition?: (cb: () => void) => unknown };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (scoped.startViewTransition && !reduce && rows.length <= 60) scoped.startViewTransition(() => reorder(tbody, rows));
  else reorder(tbody, rows);

  const status = table.parentElement?.querySelector<HTMLElement>("[data-sort-status]");
  if (status) status.textContent = `Sorted by ${button.textContent?.trim()}, ${direction}, ${rows.length} rows`;
}

const supportsCommands = "command" in HTMLButtonElement.prototype;

function initSortable(scope: ParentNode) {
for (const table of scope.querySelectorAll<HTMLTableElement>("table[data-sortable]")) {
  if (table.dataset.sortReady) continue;
  table.dataset.sortReady = "";
  if (supportsCommands) {
    table.addEventListener("command", (event) => {
      const e = event as Event & { command: string; source: HTMLButtonElement };
      if (e.command === "--sort") sortBy(table, e.source);
    });
  } else {
    for (const button of table.querySelectorAll<HTMLButtonElement>("thead button")) {
      button.addEventListener("click", () => sortBy(table, button));
    }
  }
}
}

initSortable(document);
document.addEventListener("isec:hydrate", (e) => initSortable(e.target as Element));
