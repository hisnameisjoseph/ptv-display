/**
 * Melbourne Departures - frontend
 *
 * Compiled to /public/app.js and loaded by index.html. All rendering happens
 * client-side from a single /api/board call to the Worker.
 *
 * Train stations: the board response carries stationType, which drives the
 * direction-split layout. The picker list is fetched once from /api/stations.
 *
 * Bus stops: one stop_id is one pole is one direction, so buses need no split
 * logic. There are two slots, each independently configurable. The picker
 * queries /api/stops/search as you type rather than preloading, because the
 * metro bus network has far too many stops to ship to the client.
 */

// ---- Types ----------------------------------------------------------------

interface Departure {
  route: string;
  destination: string;
  platform: string | null;
  scheduledUtc: string;
  estimatedUtc: string | null;
}

interface StopBoard {
  key: string;               // "train" | "bus-1" | "bus-2"
  label: string;
  stationType?: string;      // train boards only; drives split logic
  stopId?: number;           // bus boards only
  stopName: string;
  departures: Departure[];
  error?: string;
}

interface BoardPayload {
  updatedUtc: string;
  station: number;
  stops: StopBoard[];
}

interface StationPickerEntry {
  key: number;         // stop_id (lowest of the pair, for merged stations)
  label: string;
  stationType: string;
}

interface BusSearchResult {
  stopId: number;
  label: string;
  suburb: string | null;
  routes: string[];
}

type SplitField = "destination" | "route";

interface SplitSide {
  label: string;
  test?: RegExp;
  field?: SplitField;
}

interface SplitConfig {
  left: SplitSide;
  right: SplitSide;
  cityWard?: "left" | "right";
}

interface LineColor { bg: string; fg: string; }

type ColumnSide = "left" | "right";
type LoadState = "idle" | "loading" | "loaded" | "error";

// ---- Constants ------------------------------------------------------------

const REFRESH_MS = 45_000;
const TZ = "Australia/Melbourne";

// Walk-filter minute stops the +/- buttons snap between. 0 means "off".
const WALK_STOPS = [0, 3, 5, 8, 10, 15];
const WALK_DEFAULT = 5;

// Portrait ("decision view") display tuning.
const PORTRAIT = {
  trainPerGroup: 3,   // rows per direction group
  trainSingleList: 5, // fallback cap if a station has no split config
  busSummaryTimes: 2, // departure times shown inline in a collapsed bus header
  busExpandedRows: 4, // rows when a bus section is tapped open
};

// Fallbacks. These match the Worker's own defaults, so a fresh device and a
// cold Worker agree on what to show before the user picks anything.
const DEFAULT_STATION_STOP_ID = 1072;  // Footscray
const BUS_SLOTS = [
  { key: "bus-1", storageKey: "ptv-bus-1", defaultStopId: 19740 },
  { key: "bus-2", storageKey: "ptv-bus-2", defaultStopId: 20796 },
] as const;

// Bus search tuning. MIN_SEARCH_CHARS must match the Worker.
const MIN_SEARCH_CHARS = 3;
const BUS_SEARCH_DEBOUNCE_MS = 500;
const BUS_ROUTES_SHOWN = 5; // then "+N"

// ---- Split configs (display logic; keyed off station_type from the API) ---
// split: null -> single chronological list (used for terminus stations,
//   where almost everything is city-bound anyway).
// left/right.test: exactly one side carries a regex; the other is fallback.
// field: "destination" (default) or "route".
// cityWard: which side is citybound, where meaningful; portrait shows the
//   likely-wanted direction first.

const CITY_SPLIT: SplitConfig = {
  left:  { label: "Outbound" },
  right: { label: "To City", test: /city|flinders/i },
  cityWard: "right",
};
const TUNNEL_SPLIT_NORTH: SplitConfig = {
  left:  { label: "To Sunbury", test: /sunbury/i },
  right: { label: "To City / Cranbourne / Pakenham", test: /city|cranbourne|pakenham/i },
  cityWard: "right",
};
const TUNNEL_SPLIT_SOUTH: SplitConfig = {
  left:  { label: "To City / Sunbury", test: /sunbury|city/i },
  right: { label: "To Cranbourne / Pakenham", test: /cranbourne|pakenham/i },
  cityWard: "left",
};
const SX_SPLIT: SplitConfig = {
  left:  { label: "Red / Yellow / Dark Blue" },
  right: { label: "Frankston / Cross-City", test: /sandringham|frankston|werribee|williamstown/i, field: "route" },
};
const FLINDERS_SPLIT: SplitConfig = {
  left:  { label: "Red / Yellow / Dark Blue" },
  right: {
    label: "Cross-City / Frankston",
    test: /werribee|williamstown|sandringham|sunbury|pakenham|cranbourne|frankston/i,
    field: "route",
  },
};
const MC_SPLIT: SplitConfig = {
  left:  { label: "Red / Yellow / Dark Blue" },
  right: { label: "Metro Tunnel & Frankston", test: /sunbury|pakenham|cranbourne|frankston/i, field: "route" },
};
const NORTH_LOOP_SPLIT: SplitConfig = {
  left:  { label: "Burnley / Craigieburn / Upfield" },
  right: { label: "Hurstbridge / Mernda / Frankston", test: /hurstbridge|mernda|frankston/i, field: "route" },
};

// station_type (from D1) -> split config.
const STATION_TYPE_SPLIT: Record<string, SplitConfig | null> = {
  through: CITY_SPLIT,
  interchange: CITY_SPLIT,
  terminus: null, // single list; nearly everything departing is city-bound
  loop: NORTH_LOOP_SPLIT,
  tunnel_north: TUNNEL_SPLIT_NORTH,
  tunnel_south: TUNNEL_SPLIT_SOUTH,
  flinders_street: FLINDERS_SPLIT,
  southern_cross: SX_SPLIT,
  melbourne_central: MC_SPLIT,
};

function splitForType(stationType: string | undefined): SplitConfig | null {
  if (!stationType) return null;
  if (stationType in STATION_TYPE_SPLIT) return STATION_TYPE_SPLIT[stationType];
  console.warn("Unmapped station_type from API: " + stationType);
  return null;
}

const LINE_COLORS: Record<string, LineColor> = {
  "Alamein":      { bg: "#152C6B", fg: "#ffffff" },
  "Belgrave":     { bg: "#152C6B", fg: "#ffffff" },
  "Craigieburn":  { bg: "#FFBE00", fg: "#111111" },
  "Cranbourne":   { bg: "#279FD5", fg: "#ffffff" },
  "Flemington":   { bg: "#95979A", fg: "#111111" },
  "Frankston":    { bg: "#028430", fg: "#ffffff" },
  "Glen Waverley":{ bg: "#152C6B", fg: "#ffffff" },
  "Hurstbridge":  { bg: "#BE1014", fg: "#ffffff" },
  "Lilydale":     { bg: "#152C6B", fg: "#ffffff" },
  "Mernda":       { bg: "#BE1014", fg: "#ffffff" },
  "Pakenham":     { bg: "#279FD5", fg: "#ffffff" },
  "Sandringham":  { bg: "#F178AF", fg: "#111111" },
  "Stony Point":  { bg: "#028430", fg: "#ffffff" },
  "Sunbury":      { bg: "#279FD5", fg: "#ffffff" },
  "Upfield":      { bg: "#FFBE00", fg: "#111111" },
  "Werribee":     { bg: "#F178AF", fg: "#111111" },
  "Williamstown": { bg: "#F178AF", fg: "#111111" },
};

const RULES: Record<string, { maxFill: number }> = {
  "train": { maxFill: 30 },
  "bus-1": { maxFill: 12 },
  "bus-2": { maxFill: 12 },
};
const DEFAULT_RULE = { maxFill: 12 };

// ---- Small DOM helpers (typed) --------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

// ---- Persisted per-device settings ----------------------------------------

function loadSetting(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}
function loadStopId(key: string, fallback: number): number {
  const n = parseInt(loadSetting(key, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---- Mutable state --------------------------------------------------------

// stop_id of the currently selected train station. Old string-slug values
// left over from before the stop_id migration will fail parseInt and fall
// back to the default, which is a soft landing rather than a crash.
let currentStation = loadStopId("ptv-station", DEFAULT_STATION_STOP_ID);

// stop_id per bus slot, keyed by slot key ("bus-1" / "bus-2").
const busSelection: Record<string, number> = {};
for (const slot of BUS_SLOTS) {
  busSelection[slot.key] = loadStopId(slot.storageKey, slot.defaultStopId);
}

let walkMinutes = parseInt(loadSetting("ptv-walk-minutes", String(WALK_DEFAULT)), 10);
if (!Number.isFinite(walkMinutes) || walkMinutes < 0) walkMinutes = WALK_DEFAULT;

let menuOpen = false;
let stationQuery = "";
let trainCollapsed = false;
const expandedBuses = new Set<string>();

let lastPayload: BoardPayload | null = null;

// Station picker (search menu) data - fetched once at startup, independent
// of the board refresh cycle.
let stationPicker: StationPickerEntry[] = [];
let stationPickerState: LoadState = "loading";
let stationPickerError: string | null = null;

// Bus picker state. Only one bus menu can be open at a time; busMenuSlot
// holds its slot key, or null when closed.
let busMenuSlot: string | null = null;
let busQuery = "";
let busResults: BusSearchResult[] = [];
let busSearchState: LoadState = "idle";
let busSearchError: string | null = null;
let busDebounceTimer: number | undefined;
let busRequestSeq = 0; // guards against a slow response overwriting a newer one
let busListEl: HTMLElement | null = null; // updated in place, so typing keeps focus

// The walk filter only applies to trains (your walk to the station).
function hideWithinFor(stopKey: string): number {
  return stopKey === "train" ? walkMinutes : 0;
}

function anyMenuOpen(): boolean {
  return menuOpen || busMenuSlot !== null;
}

function closeAllMenus(): void {
  menuOpen = false;
  stationQuery = "";
  closeBusMenu();
}

// ---- Time helpers ---------------------------------------------------------

function melbTime(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function minutesUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

function tickClock(): void {
  must("clock").textContent = melbTime(new Date());
}

// ---- Line colours & column classification ---------------------------------

function lineColor(routeName: string): LineColor | null {
  const name = (routeName || "").toLowerCase();
  for (const [line, c] of Object.entries(LINE_COLORS)) {
    if (name.includes(line.toLowerCase())) return c;
  }
  return null;
}

function pickColumn(split: SplitConfig, dep: Departure): ColumnSide {
  const valueFor = (side: SplitSide): string =>
    (side.field === "route" ? dep.route : dep.destination) || "";
  if (split.left.test) return split.left.test.test(valueFor(split.left)) ? "left" : "right";
  if (split.right.test) return split.right.test.test(valueFor(split.right)) ? "right" : "left";
  return "left";
}

function orderedSides(split: SplitConfig | null): ColumnSide[] {
  if (!split || !split.cityWard) return ["left", "right"];
  const morning = new Date().getHours() < 12;
  const first: ColumnSide = morning
    ? split.cityWard
    : (split.cityWard === "left" ? "right" : "left");
  return first === "left" ? ["left", "right"] : ["right", "left"];
}

// Subsequence match: every char of query appears in order within the label.
// e.g. "mc" matches "Melbourne Central", "Macaulay", "Jolimont-MCG".
// The bus search does the equivalent in SQL, so the two pickers behave alike.
function subsequenceMatch(query: string, text: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

// ---- Row + shared UI pieces ------------------------------------------------

function buildRow(stopKey: string, dep: Departure): HTMLDivElement {
  const bestIso = dep.estimatedUtc ?? dep.scheduledUtc;
  const mins = minutesUntil(bestIso);
  const hideWithin = hideWithinFor(stopKey);

  const row = el("div", "row");

  const isTrain = stopKey === "train";
  const badge = el("span", "badge " + (isTrain ? "train" : "bus"));
  badge.textContent = isTrain ? dep.route.charAt(0) : dep.route;
  if (isTrain) {
    const c = lineColor(dep.route);
    if (c) {
      badge.style.background = c.bg;
      badge.style.color = c.fg;
    }
  }

  const dest = el("div", "dest");
  const name = el("span", "name", dep.destination);
  const meta = el("span", "meta");
  const bits: string[] = [];
  if (dep.platform) bits.push("Platform " + dep.platform);
  bits.push(dep.estimatedUtc ? "Live" : "Scheduled");
  bits.push(melbTime(new Date(bestIso)));
  meta.textContent = bits.join(" \u00b7 ");
  dest.append(name, meta);

  const minsEl = el("div", "mins" + (mins <= hideWithin + 1 ? " now" : ""));
  minsEl.innerHTML = mins + "<small>min</small>";

  row.append(badge, dest, minsEl);
  return row;
}

function makeEmptyNote(text: string): HTMLDivElement {
  return el("div", "empty", text);
}

// Shared right-side collapse chevron. Used by both train and bus headers so
// the collapse affordance is identical and can't drift between the two.
function makeCollapseButton(collapsed: boolean, onToggle: () => void): HTMLButtonElement {
  const btn = el("button", "collapse-btn" + (collapsed ? " collapsed" : ""));
  btn.type = "button";
  btn.textContent = "\u25be"; // down chevron
  btn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });
  return btn;
}

// ---- Overflow trimming (grid layout only) ---------------------------------

function trimOverflow(isGrid: boolean): void {
  if (!isGrid) return;
  document.querySelectorAll<HTMLElement>("#board section").forEach((section) => {
    const rows = section.querySelector<HTMLElement>(".rows");
    if (!rows) return;
    const isSplit = rows.classList.contains("split");
    const cols = isSplit ? [...rows.querySelectorAll<HTMLElement>(".col")] : null;
    let guard = 80;
    while (guard-- > 0 && section.scrollHeight > section.clientHeight) {
      if (isSplit && cols) {
        let target: HTMLElement | null = null;
        let most = 0;
        for (const col of cols) {
          const n = col.querySelectorAll(".row").length;
          if (n > most) { most = n; target = col; }
        }
        if (!target || most === 0) break;
        const colRows = target.querySelectorAll(".row");
        colRows[colRows.length - 1].remove();
      } else {
        if (!rows.lastElementChild) break;
        rows.lastElementChild.remove();
      }
    }
  });
}

// ---- Station picker: data loading -------------------------------------------

async function loadStationPicker(): Promise<void> {
  stationPickerState = "loading";
  try {
    const res = await fetch("/api/stations");
    if (!res.ok) throw new Error("HTTP " + res.status);
    stationPicker = (await res.json()) as StationPickerEntry[];
    stationPickerState = "loaded";
    stationPickerError = null;
  } catch (err) {
    stationPicker = [];
    stationPickerError = err instanceof Error ? err.message : "failed to load stations";
    stationPickerState = "error";
  }
  if (menuOpen) render();
}

// ---- Station picker menu (with search) -------------------------------------

function buildStationMenu(section: HTMLElement): void {
  const menu = el("div", "station-menu");
  menu.addEventListener("click", (e) => e.stopPropagation());

  const search = el("input", "station-search") as HTMLInputElement;
  search.type = "text";
  search.placeholder = "Search stations";
  search.value = stationQuery;
  search.addEventListener("input", () => {
    stationQuery = search.value;
    refreshStationList(list);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = list.querySelector<HTMLButtonElement>("button.opt");
      if (first) first.click();
    } else if (e.key === "Escape") {
      menuOpen = false;
      stationQuery = "";
      render();
    }
  });

  const list = el("div", "station-list");

  menu.append(search, list);
  section.appendChild(menu);
  refreshStationList(list);

  setTimeout(() => search.focus(), 0);
}

function refreshStationList(list: HTMLElement): void {
  list.innerHTML = "";

  if (stationPickerState === "loading") {
    list.appendChild(el("div", "no-match", "Loading stations\u2026"));
    return;
  }

  if (stationPickerState === "error") {
    list.appendChild(
      el("div", "error", "Couldn't load the station list. " + (stationPickerError ?? "")),
    );
    const retry = el("button", "opt", "Try again");
    retry.type = "button";
    retry.addEventListener("click", (e) => {
      e.stopPropagation();
      loadStationPicker().then(() => refreshStationList(list));
    });
    list.appendChild(retry);
    return;
  }

  const entries = stationPicker.filter((s) => subsequenceMatch(stationQuery, s.label));
  if (entries.length === 0) {
    list.appendChild(el("div", "no-match", "No stations match."));
    return;
  }
  for (const s of entries) {
    const btn = el("button", "opt" + (s.key === currentStation ? " active" : ""), s.label);
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menuOpen = false;
      stationQuery = "";
      if (s.key !== currentStation) {
        currentStation = s.key;
        saveSetting("ptv-station", String(s.key));
        must("updated").textContent = "loading";
        refresh();
      } else {
        render();
      }
    });
    list.appendChild(btn);
  }
}

// ---- Bus picker: search ------------------------------------------------------

function closeBusMenu(): void {
  busMenuSlot = null;
  busQuery = "";
  busResults = [];
  busSearchState = "idle";
  busSearchError = null;
  busListEl = null;
  if (busDebounceTimer !== undefined) {
    clearTimeout(busDebounceTimer);
    busDebounceTimer = undefined;
  }
}

async function runBusSearch(term: string): Promise<void> {
  const seq = ++busRequestSeq;
  busSearchState = "loading";
  paintBusList();

  try {
    const res = await fetch("/api/stops/search?q=" + encodeURIComponent(term));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = (await res.json()) as BusSearchResult[];
    if (seq !== busRequestSeq) return; // a newer search already won
    busResults = data;
    busSearchState = "loaded";
    busSearchError = null;
  } catch (err) {
    if (seq !== busRequestSeq) return;
    busResults = [];
    busSearchError = err instanceof Error ? err.message : "search failed";
    busSearchState = "error";
  }
  paintBusList();
}

function scheduleBusSearch(): void {
  if (busDebounceTimer !== undefined) clearTimeout(busDebounceTimer);

  const term = busQuery.replace(/\s+/g, "");
  if (term.length < MIN_SEARCH_CHARS) {
    busRequestSeq++; // cancel any in-flight result
    busResults = [];
    busSearchState = "idle";
    paintBusList();
    return;
  }

  busDebounceTimer = window.setTimeout(() => {
    busDebounceTimer = undefined;
    runBusSearch(busQuery.trim());
  }, BUS_SEARCH_DEBOUNCE_MS);
}

// Repaints only the results list, never the whole board, so the input keeps
// focus and the caret position while results stream in.
function paintBusList(): void {
  const list = busListEl;
  if (!list || !list.isConnected) return;
  list.innerHTML = "";

  if (busSearchState === "idle") {
    list.appendChild(
      el("div", "no-match", `Type at least ${MIN_SEARCH_CHARS} characters to search.`),
    );
    return;
  }
  if (busSearchState === "loading") {
    list.appendChild(el("div", "no-match", "Searching\u2026"));
    return;
  }
  if (busSearchState === "error") {
    list.appendChild(el("div", "error", "Search failed. " + (busSearchError ?? "")));
    const retry = el("button", "opt", "Try again");
    retry.type = "button";
    retry.addEventListener("click", (e) => {
      e.stopPropagation();
      runBusSearch(busQuery.trim());
    });
    list.appendChild(retry);
    return;
  }
  if (busResults.length === 0) {
    list.appendChild(el("div", "no-match", "No bus stops match."));
    return;
  }

  const slotKey = busMenuSlot;
  const activeStopId = slotKey ? busSelection[slotKey] : -1;

  for (const stop of busResults) {
    const btn = el("button", "opt" + (stop.stopId === activeStopId ? " active" : ""));
    btn.type = "button";

    btn.appendChild(el("span", undefined, stop.label));

    // Route numbers inline, in the dimmer meta treatment used on rows.
    if (stop.routes.length > 0) {
      const shown = stop.routes.slice(0, BUS_ROUTES_SHOWN).join(", ");
      const extra = stop.routes.length - BUS_ROUTES_SHOWN;
      btn.appendChild(
        el("span", "opt-routes", shown + (extra > 0 ? ` +${extra}` : "")),
      );
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!slotKey) return;
      const changed = busSelection[slotKey] !== stop.stopId;
      const slot = BUS_SLOTS.find((s) => s.key === slotKey);
      closeBusMenu();
      if (changed && slot) {
        busSelection[slotKey] = stop.stopId;
        saveSetting(slot.storageKey, String(stop.stopId));
        must("updated").textContent = "loading";
        refresh();
      } else {
        render();
      }
    });
    list.appendChild(btn);
  }
}

function buildBusMenu(section: HTMLElement): void {
  const menu = el("div", "station-menu");
  menu.addEventListener("click", (e) => e.stopPropagation());

  const search = el("input", "station-search") as HTMLInputElement;
  search.type = "text";
  search.placeholder = "Search bus stops";
  search.value = busQuery;
  search.addEventListener("input", () => {
    busQuery = search.value;
    scheduleBusSearch();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = list.querySelector<HTMLButtonElement>("button.opt");
      if (first) first.click();
    } else if (e.key === "Escape") {
      closeBusMenu();
      render();
    }
  });

  const list = el("div", "station-list");
  busListEl = list;

  menu.append(search, list);
  section.appendChild(menu);
  paintBusList();

  setTimeout(() => search.focus(), 0);
}

// Close any open menu when tapping elsewhere.
document.addEventListener("click", () => {
  if (anyMenuOpen()) {
    closeAllMenus();
    render();
  }
});

// ---- Section builders ------------------------------------------------------

function buildTrainGrid(section: HTMLElement, stop: StopBoard, split: SplitConfig | null): void {
  const cap = (RULES["train"] ?? DEFAULT_RULE).maxFill;
  const hideWithin = hideWithinFor("train");

  const rowsWrap = el("div", "rows" + (split ? " split" : ""));
  section.appendChild(rowsWrap);

  let colLeft: HTMLElement | null = null;
  let colRight: HTMLElement | null = null;
  if (split) {
    colLeft = el("div", "col");
    colLeft.appendChild(el("h3", undefined, split.left.label));
    colRight = el("div", "col");
    colRight.appendChild(el("h3", undefined, split.right.label));
    rowsWrap.append(colLeft, colRight);
  }

  if (stop.error) {
    (split ? colLeft! : rowsWrap).appendChild(el("div", "error", "Data unavailable. " + stop.error));
    return;
  }

  let shown = 0;
  for (const dep of stop.departures) {
    if (shown >= cap) break;
    const bestIso = dep.estimatedUtc ?? dep.scheduledUtc;
    if (minutesUntil(bestIso) < hideWithin) continue;

    const row = buildRow("train", dep);
    if (split) {
      (pickColumn(split, dep) === "right" ? colRight! : colLeft!).appendChild(row);
    } else {
      rowsWrap.appendChild(row);
    }
    shown++;
  }
  if (shown === 0) {
    (split ? colLeft! : rowsWrap).appendChild(makeEmptyNote("No catchable departures right now."));
  } else if (split) {
    for (const col of [colLeft!, colRight!]) {
      if (!col.querySelector(".row")) col.appendChild(makeEmptyNote("No departures"));
    }
  }
}

function buildTrainStacked(section: HTMLElement, stop: StopBoard, split: SplitConfig | null): void {
  const hideWithin = hideWithinFor("train");

  const rowsWrap = el("div", "rows" + (split ? " stacked-split" : ""));
  section.appendChild(rowsWrap);

  if (stop.error) {
    rowsWrap.appendChild(el("div", "error", "Data unavailable. " + stop.error));
    return;
  }

  if (!split) {
    let shown = 0;
    for (const dep of stop.departures) {
      if (shown >= PORTRAIT.trainSingleList) break;
      const bestIso = dep.estimatedUtc ?? dep.scheduledUtc;
      if (minutesUntil(bestIso) < hideWithin) continue;
      rowsWrap.appendChild(buildRow("train", dep));
      shown++;
    }
    if (shown === 0) rowsWrap.appendChild(makeEmptyNote("No catchable departures right now."));
    return;
  }

  const sides = orderedSides(split);
  const colBySide: Record<ColumnSide, HTMLElement> = {} as Record<ColumnSide, HTMLElement>;
  for (const side of sides) {
    const col = el("div", "col");
    col.appendChild(el("h3", undefined, split[side].label));
    rowsWrap.appendChild(col);
    colBySide[side] = col;
  }

  const counts: Record<ColumnSide, number> = { left: 0, right: 0 };
  for (const dep of stop.departures) {
    if (counts.left >= PORTRAIT.trainPerGroup && counts.right >= PORTRAIT.trainPerGroup) break;
    const bestIso = dep.estimatedUtc ?? dep.scheduledUtc;
    if (minutesUntil(bestIso) < hideWithin) continue;
    const side = pickColumn(split, dep);
    if (counts[side] >= PORTRAIT.trainPerGroup) continue;
    colBySide[side].appendChild(buildRow("train", dep));
    counts[side]++;
  }

  for (const side of sides) {
    if (!colBySide[side].querySelector(".row")) {
      colBySide[side].appendChild(makeEmptyNote("No departures"));
    }
  }
}

function buildBusGrid(section: HTMLElement, stop: StopBoard): void {
  const cap = (RULES[stop.key] ?? DEFAULT_RULE).maxFill;
  const rowsWrap = el("div", "rows");
  section.appendChild(rowsWrap);

  if (stop.error) {
    rowsWrap.appendChild(el("div", "error", "Data unavailable. " + stop.error));
    return;
  }

  let shown = 0;
  for (const dep of stop.departures) {
    if (shown >= cap) break;
    if (minutesUntil(dep.estimatedUtc ?? dep.scheduledUtc) < 0) continue;
    rowsWrap.appendChild(buildRow(stop.key, dep));
    shown++;
  }
  if (shown === 0) rowsWrap.appendChild(makeEmptyNote("No catchable departures right now."));
}

// Portrait: bus header shows next times inline plus a right-side collapse
// chevron matching the train header. The chevron is the collapse control.
function buildBusPortrait(section: HTMLElement, stop: StopBoard, h2: HTMLElement): void {
  const expanded = expandedBuses.has(stop.key);

  const times = el("span", "h2-times");
  const catchable = (stop.departures ?? []).filter(
    (dep) => minutesUntil(dep.estimatedUtc ?? dep.scheduledUtc) >= 0,
  );
  if (stop.error) {
    times.classList.add("none");
    times.textContent = "no data";
  } else if (catchable.length === 0) {
    times.classList.add("none");
    times.textContent = "none";
  } else {
    for (const dep of catchable.slice(0, PORTRAIT.busSummaryTimes)) {
      const mins = minutesUntil(dep.estimatedUtc ?? dep.scheduledUtc);
      times.appendChild(el("span", undefined, dep.route + " " + mins + "m"));
    }
  }

  const collapse = makeCollapseButton(!expanded, () => {
    if (expandedBuses.has(stop.key)) expandedBuses.delete(stop.key);
    else expandedBuses.add(stop.key);
    render();
  });

  h2.append(times, collapse);

  if (!expanded) return;

  const rowsWrap = el("div", "rows");
  section.appendChild(rowsWrap);

  if (stop.error) {
    rowsWrap.appendChild(el("div", "error", "Data unavailable. " + stop.error));
    return;
  }
  const shownDeps = catchable.slice(0, PORTRAIT.busExpandedRows);
  for (const dep of shownDeps) rowsWrap.appendChild(buildRow(stop.key, dep));
  if (shownDeps.length === 0) rowsWrap.appendChild(makeEmptyNote("No departures"));
}

// ---- Render ---------------------------------------------------------------

function render(): void {
  if (!lastPayload) return;
  const board = must("board");
  board.innerHTML = "";
  busListEl = null; // the old list node is about to be discarded

  const isGrid = getComputedStyle(board).display === "grid";

  for (const stop of lastPayload.stops) {
    const isTrain = stop.key === "train";

    const section = el("section");
    section.dataset.key = stop.key;

    const h2 = el("h2", "picker");
    const nameEl = el("span", "h2-name");

    // Both train and bus headers are pickers now; only the menu differs.
    nameEl.append(el("span", undefined, stop.label), el("span", "caret", "\u25be"));
    nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isTrain) {
        const wasOpen = menuOpen;
        closeAllMenus();
        menuOpen = !wasOpen;
      } else {
        const wasOpen = busMenuSlot === stop.key;
        closeAllMenus();
        if (!wasOpen) busMenuSlot = stop.key;
      }
      render();
    });
    h2.appendChild(nameEl);

    if (isTrain && !isGrid) {
      h2.appendChild(makeCollapseButton(trainCollapsed, () => {
        trainCollapsed = !trainCollapsed;
        render();
      }));
    }
    section.appendChild(h2);

    if (isTrain) {
      const showBody = isGrid || !trainCollapsed;
      if (showBody) {
        const split = splitForType(stop.stationType);
        if (isGrid) buildTrainGrid(section, stop, split);
        else buildTrainStacked(section, stop, split);
      }
    } else {
      if (isGrid) buildBusGrid(section, stop);
      else buildBusPortrait(section, stop, h2);
    }

    if (isTrain && menuOpen) buildStationMenu(section);
    if (!isTrain && busMenuSlot === stop.key) buildBusMenu(section);

    board.appendChild(section);
  }

  trimOverflow(isGrid);
  updateWalkUI();
}

// ---- Walk filter stepper ----------------------------------------------------

function updateWalkUI(): void {
  const wrap = must("walk");
  const label = must("walk-label");
  const on = walkMinutes > 0;
  wrap.classList.toggle("on", on);
  label.textContent = on ? "Walk " + walkMinutes + " min" : "Walk filter: off";
}

function setWalkMinutes(v: number): void {
  walkMinutes = Math.max(0, v);
  saveSetting("ptv-walk-minutes", String(walkMinutes));
  render();
}

// +/- snap to the nearest stop in WALK_STOPS, so tapping cycles sensibly
function nudgeWalk(dir: number): void {
  const stops = WALK_STOPS;
  let idx = stops.indexOf(walkMinutes);
  if (idx === -1) {
    let nearest = 0, best = Infinity;
    stops.forEach((s, i) => {
      const d = Math.abs(s - walkMinutes);
      if (d < best) { best = d; nearest = i; }
    });
    idx = nearest;
  } else {
    idx = Math.min(stops.length - 1, Math.max(0, idx + dir));
  }
  setWalkMinutes(stops[idx]);
}

let lastWalkValue = walkMinutes > 0 ? walkMinutes : WALK_DEFAULT;

// ---- Data fetch -----------------------------------------------------------

function boardUrl(): string {
  const params = new URLSearchParams({ station: String(currentStation) });
  BUS_SLOTS.forEach((slot, i) => {
    params.set(`bus${i + 1}`, String(busSelection[slot.key]));
  });
  return "/api/board?" + params.toString();
}

async function refresh(): Promise<void> {
  const dot = must("dot");
  const updated = must("updated");
  try {
    const res = await fetch(boardUrl());
    if (!res.ok) throw new Error("HTTP " + res.status);
    lastPayload = (await res.json()) as BoardPayload;
    dot.className = "";
    updated.textContent = "Updated " + melbTime(new Date());
  } catch {
    dot.className = "down";
    updated.textContent = "connection lost";
  }
  render();
}

// ---- Wake lock (iOS 16.4+) -------------------------------------------------

let wakeLock: WakeLockSentinel | null = null;
async function requestWakeLock(): Promise<void> {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {
    /* not critical */
  }
}

// ---- Wiring / init --------------------------------------------------------

function init(): void {
  setInterval(tickClock, 1000);
  tickClock();

  must<HTMLButtonElement>("walk-minus").addEventListener("click", (e) => {
    e.stopPropagation();
    nudgeWalk(-1);
  });
  must<HTMLButtonElement>("walk-plus").addEventListener("click", (e) => {
    e.stopPropagation();
    nudgeWalk(+1);
  });
  must("walk-label").addEventListener("click", (e) => {
    e.stopPropagation();
    if (walkMinutes > 0) {
      lastWalkValue = walkMinutes;
      setWalkMinutes(0);
    } else {
      setWalkMinutes(lastWalkValue);
    }
  });
  updateWalkUI();

  // Board and station-picker fetches are independent: the board renders
  // as soon as it's back, without waiting on the picker list.
  loadStationPicker();
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(() => { if (!anyMenuOpen()) render(); }, 20_000);

  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { if (!anyMenuOpen()) render(); }, 200);
  });

  requestWakeLock();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });
}

init();