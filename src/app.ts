/**
 * Melbourne Departures - frontend
 *
 * Compiled to /public/app.js and loaded by index.html. All rendering happens
 * client-side from a single /api/board?station=<key> call to the Worker.
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
  key: string;               // "train" | "bus-city" | "bus-west"
  label: string;
  stopName: string;
  departures: Departure[];
  error?: string;
}

interface BoardPayload {
  updatedUtc: string;
  station: string;
  stops: StopBoard[];
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

interface StationConfig {
  label: string;
  split: SplitConfig | null;
}

interface LineColor { bg: string; fg: string; }

type ColumnSide = "left" | "right";

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

// ---- Station registry (keys must match the Worker) ------------------------
// split: null -> single chronological list.
// split.left/right: exactly one side carries a regex test; the other is the
//   fallback. field: "destination" (default) or "route".
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

const STATIONS: Record<string, StationConfig> = {
  "footscray":         { label: "Footscray Station",                 split: CITY_SPLIT },
  "flinders-street":   { label: "Flinders St / Town Hall",           split: FLINDERS_SPLIT },
  "melbourne-central": { label: "Melbourne Central / State Library", split: MC_SPLIT },
  "southern-cross":    { label: "Southern Cross Station",            split: SX_SPLIT },
  "flagstaff":         { label: "Flagstaff Station",                 split: NORTH_LOOP_SPLIT },
  "parliament":        { label: "Parliament Station",                split: NORTH_LOOP_SPLIT },
  "anzac":             { label: "Anzac Station",                     split: TUNNEL_SPLIT_SOUTH },
  "parkville":         { label: "Parkville Station",                 split: TUNNEL_SPLIT_NORTH },
  "arden":             { label: "Arden Station",                     split: TUNNEL_SPLIT_NORTH },
  "richmond":          { label: "Richmond Station",                  split: CITY_SPLIT },
  "west-richmond":     { label: "West Richmond Station",             split: CITY_SPLIT },
  "jolimont":          { label: "Jolimont-MCG Station",              split: CITY_SPLIT },
  "south-yarra":       { label: "South Yarra Station",               split: CITY_SPLIT },
  "caulfield":         { label: "Caulfield Station",                 split: CITY_SPLIT },
  "newport":           { label: "Newport Station",                   split: CITY_SPLIT },
  "yarraville":        { label: "Yarraville Station",                split: CITY_SPLIT },
  "sunshine":          { label: "Sunshine Station",                  split: CITY_SPLIT },
  "werribee":          { label: "Werribee Station",                  split: CITY_SPLIT },
  "middle-footscray":  { label: "Middle Footscray",                  split: CITY_SPLIT },
  "west-footscray":    { label: "West Footscray",                    split: CITY_SPLIT },
  "hawksburn":         { label: "Hawksburn Station",                 split: CITY_SPLIT },
  "watergardens":      { label: "Watergardens Station",              split: CITY_SPLIT },
  "flemington-bridge": { label: "Flemington Bridge",                 split: CITY_SPLIT },
  "macaulay":          { label: "Macaulay Station",                  split: CITY_SPLIT },
};
const DEFAULT_STATION = "footscray";

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
  "train":    { maxFill: 30 },
  "bus-city": { maxFill: 12 },
  "bus-west": { maxFill: 12 },
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

// ---- Mutable state --------------------------------------------------------

let currentStation = loadSetting("ptv-station", DEFAULT_STATION);
if (!(currentStation in STATIONS)) currentStation = DEFAULT_STATION;

let walkMinutes = parseInt(loadSetting("ptv-walk-minutes", String(WALK_DEFAULT)), 10);
if (!Number.isFinite(walkMinutes) || walkMinutes < 0) walkMinutes = WALK_DEFAULT;

let menuOpen = false;
let stationQuery = "";
let trainCollapsed = false;
const expandedBuses = new Set<string>();

let lastPayload: BoardPayload | null = null;

// The walk filter only applies to trains (your walk to the station).
function hideWithinFor(stopKey: string): number {
  return stopKey === "train" ? walkMinutes : 0;
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

  const badge = el("span", "badge " + (stopKey === "train" ? "train" : "bus"));
  badge.textContent = stopKey === "train" ? dep.route.charAt(0) : dep.route;
  if (stopKey === "train") {
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
  btn.textContent = "\u25be"; // ▾
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
  const entries = Object.entries(STATIONS).filter(([, cfg]) =>
    subsequenceMatch(stationQuery, cfg.label),
  );
  if (entries.length === 0) {
    list.appendChild(el("div", "no-match", "No stations match."));
    return;
  }
  for (const [key, cfg] of entries) {
    const btn = el("button", "opt" + (key === currentStation ? " active" : ""), cfg.label);
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menuOpen = false;
      stationQuery = "";
      if (key !== currentStation) {
        currentStation = key;
        saveSetting("ptv-station", key);
        must("updated").textContent = "loading";
        refresh();
      } else {
        render();
      }
    });
    list.appendChild(btn);
  }
}

// Close the menu when tapping anywhere else
document.addEventListener("click", () => {
  if (menuOpen) {
    menuOpen = false;
    stationQuery = "";
    render();
  }
});

// ---- Section builders ------------------------------------------------------

function buildTrainGrid(section: HTMLElement, stop: StopBoard, stationCfg: StationConfig): void {
  const split = stationCfg.split;
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

function buildTrainStacked(section: HTMLElement, stop: StopBoard, stationCfg: StationConfig): void {
  const split = stationCfg.split;
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

  const isGrid = getComputedStyle(board).display === "grid";
  const stationCfg = STATIONS[currentStation] ?? STATIONS[DEFAULT_STATION];

  for (const stop of lastPayload.stops) {
    const isTrain = stop.key === "train";

    const section = el("section");
    section.dataset.key = stop.key;

    const h2 = el("h2");
    const nameEl = el("span", "h2-name");

    if (isTrain) {
      h2.className = "picker";
      nameEl.append(el("span", undefined, stationCfg.label), el("span", "caret", "\u25be"));
      nameEl.addEventListener("click", (e) => {
        e.stopPropagation();
        menuOpen = !menuOpen;
        if (!menuOpen) stationQuery = "";
        render();
      });
      h2.appendChild(nameEl);

      if (!isGrid) {
        h2.appendChild(makeCollapseButton(trainCollapsed, () => {
          trainCollapsed = !trainCollapsed;
          render();
        }));
      }
    } else {
      nameEl.appendChild(el("span", undefined, stop.label));
      h2.appendChild(nameEl);
    }
    section.appendChild(h2);

    if (isTrain) {
      const showBody = isGrid || !trainCollapsed;
      if (showBody) {
        if (isGrid) buildTrainGrid(section, stop, stationCfg);
        else buildTrainStacked(section, stop, stationCfg);
      }
    } else {
      if (isGrid) buildBusGrid(section, stop);
      else buildBusPortrait(section, stop, h2);
    }

    if (isTrain && menuOpen) buildStationMenu(section);
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

async function refresh(): Promise<void> {
  const dot = must("dot");
  const updated = must("updated");
  try {
    const res = await fetch("/api/board?station=" + encodeURIComponent(currentStation));
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

  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(() => { if (!menuOpen) render(); }, 20_000);

  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { if (!menuOpen) render(); }, 200);
  });

  requestWakeLock();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });
}

init();