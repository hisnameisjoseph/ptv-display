"use strict";
/**
 * Melbourne Departures - frontend
 *
 * Compiled to /public/app.js and loaded by index.html. All rendering happens
 * client-side from a single /api/board call to the Worker.
 *
 * The board is an ordered list of cards. Each card names one stop - a train
 * station or a bus stop - and carries its own settings: how long you need to
 * reach it, and which routes you actually catch. The card list is the single
 * source of truth, persisted as one layout object per device, so a wall
 * display and a phone can show entirely different boards from one deployment.
 *
 * Train stations: the board response carries stationType, which drives the
 * direction-split layout. The picker list is fetched once from /api/stations.
 *
 * Bus stops: one stop_id is one pole is one direction, so buses need no split
 * logic. The picker queries /api/stops/search as you type rather than
 * preloading, because the metro bus network has far too many stops to ship to
 * the client.
 *
 * Route filtering runs here rather than in the Worker on purpose: the Worker
 * caches each stop unfiltered, so two people watching the same stop with
 * different filters still share one upstream call.
 */
const LAYOUT_KEY = "ptv-layout";
const LAYOUT_VERSION = 2;
// Hard ceiling on cards. Each card is one PTV call on a cold cache, and past
// roughly five the board stops being glanceable in either orientation.
const MAX_CARDS = 8;
const WARN_FROM = 5;
// ---- Constants ------------------------------------------------------------
const REFRESH_MS = 45_000;
const TZ = "Australia/Melbourne";
// Walk-filter minute stops the +/- buttons snap between. 0 means "off".
const WALK_STOPS = [0, 3, 5, 8, 10, 15];
const WALK_DEFAULT = 5;
// Portrait ("decision view") display tuning.
const PORTRAIT = {
    trainPerGroup: 3, // rows per direction group
    trainSingleList: 5, // fallback cap if a station has no split config
    busSummaryTimes: 2, // departure times shown inline in a collapsed bus header
    busExpandedRows: 4, // rows when a bus section is tapped open
};
// Fallbacks. These match the Worker's own defaults, so a fresh device and a
// cold Worker agree on what to show before the user picks anything.
const DEFAULT_STATION_STOP_ID = 1072; // Footscray
const DEFAULT_BUS_STOP_IDS = [19740, 20796];
// Pre-cards storage keys. Still read during migration, and deliberately left
// in place for one release so rolling back does not wipe a wall display.
const LEGACY_KEYS = {
    station: "ptv-station",
    bus1: "ptv-bus-1",
    bus2: "ptv-bus-2",
};
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
const CITY_SPLIT = {
    left: { label: "Outbound" },
    right: { label: "To City", test: /city|flinders/i },
    cityWard: "right",
};
const TUNNEL_SPLIT_NORTH = {
    left: { label: "To Sunbury", test: /sunbury/i },
    right: { label: "To City / Cranbourne / Pakenham", test: /city|cranbourne|pakenham/i },
    cityWard: "right",
};
const TUNNEL_SPLIT_SOUTH = {
    left: { label: "To City / Sunbury", test: /sunbury|city/i },
    right: { label: "To Cranbourne / Pakenham", test: /cranbourne|pakenham/i },
    cityWard: "left",
};
const SX_SPLIT = {
    left: { label: "Red / Yellow / Dark Blue" },
    right: { label: "Frankston / Cross-City", test: /sandringham|frankston|werribee|williamstown/i, field: "route" },
};
const FLINDERS_SPLIT = {
    left: { label: "Red / Yellow / Dark Blue" },
    right: {
        label: "Cross-City / Frankston",
        test: /werribee|williamstown|sandringham|sunbury|pakenham|cranbourne|frankston/i,
        field: "route",
    },
};
const MC_SPLIT = {
    left: { label: "Red / Yellow / Dark Blue" },
    right: { label: "Metro Tunnel & Frankston", test: /sunbury|pakenham|cranbourne|frankston/i, field: "route" },
};
const NORTH_LOOP_SPLIT = {
    left: { label: "Burnley / Craigieburn / Upfield" },
    right: { label: "Hurstbridge / Mernda / Frankston", test: /hurstbridge|mernda|frankston/i, field: "route" },
};
// station_type (from D1) -> split config.
const STATION_TYPE_SPLIT = {
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
function splitForType(stationType) {
    if (!stationType)
        return null;
    if (stationType in STATION_TYPE_SPLIT)
        return STATION_TYPE_SPLIT[stationType];
    console.warn("Unmapped station_type from API: " + stationType);
    return null;
}
const LINE_COLORS = {
    "Alamein": { bg: "#152C6B", fg: "#ffffff" },
    "Belgrave": { bg: "#152C6B", fg: "#ffffff" },
    "Craigieburn": { bg: "#FFBE00", fg: "#111111" },
    "Cranbourne": { bg: "#279FD5", fg: "#ffffff" },
    "Flemington": { bg: "#95979A", fg: "#111111" },
    "Frankston": { bg: "#028430", fg: "#ffffff" },
    "Glen Waverley": { bg: "#152C6B", fg: "#ffffff" },
    "Hurstbridge": { bg: "#BE1014", fg: "#ffffff" },
    "Lilydale": { bg: "#152C6B", fg: "#ffffff" },
    "Mernda": { bg: "#BE1014", fg: "#ffffff" },
    "Pakenham": { bg: "#279FD5", fg: "#ffffff" },
    "Sandringham": { bg: "#F178AF", fg: "#111111" },
    "Stony Point": { bg: "#028430", fg: "#ffffff" },
    "Sunbury": { bg: "#279FD5", fg: "#ffffff" },
    "Upfield": { bg: "#FFBE00", fg: "#111111" },
    "Werribee": { bg: "#F178AF", fg: "#111111" },
    "Williamstown": { bg: "#F178AF", fg: "#111111" },
};
// How many rows a card will ever render before the overflow trim measures the
// real available height. Keyed by mode now rather than by fixed slot name.
const MAX_FILL = { train: 30, bus: 12 };
// Below this width a two-column direction split gets too cramped to read, so
// the columns stack instead. Calibrated against the point where a long
// destination like "Glen Waverley" starts to ellipsize.
const SPLIT_MIN_WIDTH = 460;
const DENSITY_MIN = {
    comfortable: { w: 620, h: 340 },
    compact: { w: 260, h: 200 },
};
function densityFor(w, h) {
    if (w >= DENSITY_MIN.comfortable.w && h >= DENSITY_MIN.comfortable.h)
        return "comfortable";
    if (w >= DENSITY_MIN.compact.w && h >= DENSITY_MIN.compact.h)
        return "compact";
    return "glance";
}
// ---- Small DOM helpers (typed) --------------------------------------------
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function must(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`Missing required element #${id}`);
    return node;
}
// ---- Persisted per-device settings ----------------------------------------
function loadSetting(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
    }
    catch {
        return fallback;
    }
}
function saveSetting(key, value) {
    try {
        localStorage.setItem(key, value);
    }
    catch {
        /* private mode etc. */
    }
}
function loadStopId(key, fallback) {
    const n = parseInt(loadSetting(key, String(fallback)), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
// ---- Layout: load, migrate, save -------------------------------------------
function newCardId() {
    try {
        if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
            return crypto.randomUUID();
        }
    }
    catch {
        /* fall through */
    }
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function isCardLike(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const c = value;
    return ((c.mode === "train" || c.mode === "bus") &&
        typeof c.stopId === "number" &&
        Number.isFinite(c.stopId) &&
        c.stopId > 0);
}
// Repairs anything the stored layout might be missing: ids, a single primary,
// no duplicate stops, no more than MAX_CARDS.
function normaliseCards(input) {
    const seen = new Set();
    const out = [];
    for (const card of input) {
        const dedupeKey = `${card.mode}:${card.stopId}`;
        if (seen.has(dedupeKey))
            continue;
        seen.add(dedupeKey);
        out.push({
            ...card,
            id: typeof card.id === "string" && card.id ? card.id : newCardId(),
            routeIds: Array.isArray(card.routeIds)
                ? card.routeIds.filter((n) => typeof n === "number")
                : undefined,
        });
        if (out.length >= MAX_CARDS)
            break;
    }
    if (out.length > 0 && !out.some((c) => c.primary)) {
        const firstTrain = out.find((c) => c.mode === "train");
        (firstTrain ?? out[0]).primary = true;
    }
    // Exactly one primary, whatever the stored layout claimed.
    let primarySeen = false;
    for (const card of out) {
        if (card.primary && !primarySeen)
            primarySeen = true;
        else
            delete card.primary;
    }
    if (!primarySeen && out.length > 0)
        out[0].primary = true;
    return out;
}
// The pre-cards board: one train station plus two bus stops. Read once, then
// written back as a layout. The old keys are left alone.
function migrateLegacyLayout() {
    return [
        {
            id: newCardId(),
            mode: "train",
            stopId: loadStopId(LEGACY_KEYS.station, DEFAULT_STATION_STOP_ID),
            primary: true,
        },
        { id: newCardId(), mode: "bus", stopId: loadStopId(LEGACY_KEYS.bus1, DEFAULT_BUS_STOP_IDS[0]) },
        { id: newCardId(), mode: "bus", stopId: loadStopId(LEGACY_KEYS.bus2, DEFAULT_BUS_STOP_IDS[1]) },
    ];
}
function loadLayout() {
    const raw = loadSetting(LAYOUT_KEY, "");
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === LAYOUT_VERSION && Array.isArray(parsed.cards)) {
                const cards = normaliseCards(parsed.cards.filter(isCardLike));
                if (cards.length > 0)
                    return cards;
            }
        }
        catch {
            /* corrupt layout: fall back to migration rather than a blank board */
        }
    }
    return normaliseCards(migrateLegacyLayout());
}
function saveLayout() {
    const layout = { version: LAYOUT_VERSION, cards };
    saveSetting(LAYOUT_KEY, JSON.stringify(layout));
}
// ---- Mutable state --------------------------------------------------------
const cards = loadLayout();
let walkMinutes = parseInt(loadSetting("ptv-walk-minutes", String(WALK_DEFAULT)), 10);
if (!Number.isFinite(walkMinutes) || walkMinutes < 0)
    walkMinutes = WALK_DEFAULT;
// Which card's picker is open, if any. Only one at a time.
let stationMenuCardId = null;
let busMenuCardId = null;
let stationQuery = "";
// Collapse state, held in memory to match the pre-cards behaviour. Phase 6
// moves this into the layout when portrait collapse gets its proper design.
const collapsedCards = new Set();
for (const card of cards) {
    if (card.mode === "bus")
        collapsedCards.add(card.id);
}
let lastPayload = null;
// Measured card geometry, keyed by card id. The observer keeps this current so
// the next render already knows how wide each card will be, rather than
// guessing from the viewport.
const cardSize = new Map();
let reflowQueued = false;
// Station picker (search menu) data - fetched once at startup, independent
// of the board refresh cycle.
let stationPicker = [];
let stationPickerState = "loading";
let stationPickerError = null;
// Bus picker state.
let busQuery = "";
let busResults = [];
let busSearchState = "idle";
let busSearchError = null;
let busDebounceTimer;
let busRequestSeq = 0; // guards against a slow response overwriting a newer one
let busListEl = null; // updated in place, so typing keeps focus
// ---- Card helpers ----------------------------------------------------------
function routeTypeOf(mode) {
    return mode === "train" ? 0 : 2;
}
function stopKeyFor(card) {
    return `${routeTypeOf(card.mode)}:${card.stopId}`;
}
function cardById(id) {
    return id === null ? undefined : cards.find((c) => c.id === id);
}
function boardForCard(card) {
    return lastPayload?.stops.find((s) => s.key === stopKeyFor(card));
}
/**
 * Minutes of walking to allow for before a departure becomes uncatchable.
 *
 * An explicit per-card value always wins. Without one, trains inherit the
 * global filter and buses get 0 - which is exactly what the board did before
 * cards existed. Phase 7 puts a control on every card.
 */
function effectiveWalk(card) {
    if (typeof card.walkMinutes === "number" && card.walkMinutes >= 0) {
        return card.walkMinutes;
    }
    return card.mode === "train" ? walkMinutes : 0;
}
function passesRouteFilter(card, dep) {
    if (!card.routeIds || card.routeIds.length === 0)
        return true;
    return card.routeIds.includes(dep.routeId);
}
/** Departures this card should show, after its route and walk filters. */
function visibleDepartures(card, stop) {
    const hideWithin = effectiveWalk(card);
    return stop.departures.filter((dep) => {
        if (!passesRouteFilter(card, dep))
            return false;
        return minutesUntil(dep.estimatedUtc ?? dep.scheduledUtc) >= hideWithin;
    });
}
function isCollapsed(card) {
    return collapsedCards.has(card.id);
}
function toggleCollapsed(card) {
    if (collapsedCards.has(card.id))
        collapsedCards.delete(card.id);
    else
        collapsedCards.add(card.id);
}
/**
 * The pre-cards CSS keys its landscape grid areas off the names "train",
 * "bus-1" and "bus-2". Phases 4 and 5 replace that fixed grid with one derived
 * from the card list, and this mapping goes away with it.
 */
function legacySlotFor(card, index) {
    if (card.mode === "train")
        return "train";
    let busIndex = 0;
    for (let i = 0; i < index; i++) {
        if (cards[i].mode === "bus")
            busIndex++;
    }
    return `bus-${busIndex + 1}`;
}
/**
 * Side-by-side direction columns, or stacked with the labels as dividers?
 * Driven by the card's measured width, so the same card renders correctly at
 * any size in any orientation. Before the first measurement, fall back to the
 * board being in grid mode, which is the pre-cards behaviour.
 */
function splitSideBySide(card, isGrid) {
    const size = cardSize.get(card.id);
    if (!size)
        return isGrid;
    return size.w >= SPLIT_MIN_WIDTH;
}
// Watches every card and keeps its density attribute current. Density is a
// pure CSS concern, so most size changes need no re-render at all; only
// crossing the split threshold changes the DOM, and that schedules one pass.
const cardObserver = new ResizeObserver((entries) => {
    let splitFlipped = false;
    for (const entry of entries) {
        const section = entry.target;
        // A rebuild detaches the old sections, and the observer reports those as
        // 0x0 on their way out. Measuring that would overwrite a good reading with
        // zeros and bounce the split state, so skip anything already discarded.
        if (!section.isConnected)
            continue;
        const id = section.dataset.cardId;
        if (!id)
            continue;
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        const prev = cardSize.get(id);
        cardSize.set(id, { w, h });
        section.dataset.density = densityFor(w, h);
        const wasSplit = prev ? prev.w >= SPLIT_MIN_WIDTH : null;
        if (wasSplit !== null && wasSplit !== (w >= SPLIT_MIN_WIDTH))
            splitFlipped = true;
        if (prev === undefined)
            splitFlipped = true; // first measurement
    }
    if (splitFlipped && !reflowQueued && !anyMenuOpen()) {
        reflowQueued = true;
        requestAnimationFrame(() => {
            reflowQueued = false;
            render();
        });
    }
});
function anyMenuOpen() {
    return stationMenuCardId !== null || busMenuCardId !== null;
}
function closeAllMenus() {
    stationMenuCardId = null;
    stationQuery = "";
    closeBusMenu();
}
// Applies a stop change to a card and refreshes, or just repaints if nothing
// actually moved.
function setCardStop(card, stopId) {
    if (card.stopId === stopId) {
        render();
        return;
    }
    card.stopId = stopId;
    // A different stop means the old route filter no longer refers to anything.
    card.routeIds = undefined;
    saveLayout();
    must("updated").textContent = "loading";
    refresh();
}
// ---- Time helpers ---------------------------------------------------------
function melbTime(date) {
    return new Intl.DateTimeFormat("en-AU", {
        timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date);
}
function minutesUntil(iso) {
    return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}
function tickClock() {
    must("clock").textContent = melbTime(new Date());
}
// ---- Line colours & column classification ---------------------------------
function lineColor(routeName) {
    const name = (routeName || "").toLowerCase();
    for (const [line, c] of Object.entries(LINE_COLORS)) {
        if (name.includes(line.toLowerCase()))
            return c;
    }
    return null;
}
function pickColumn(split, dep) {
    const valueFor = (side) => (side.field === "route" ? dep.route : dep.destination) || "";
    if (split.left.test)
        return split.left.test.test(valueFor(split.left)) ? "left" : "right";
    if (split.right.test)
        return split.right.test.test(valueFor(split.right)) ? "right" : "left";
    return "left";
}
function orderedSides(split) {
    if (!split || !split.cityWard)
        return ["left", "right"];
    const morning = new Date().getHours() < 12;
    const first = morning
        ? split.cityWard
        : (split.cityWard === "left" ? "right" : "left");
    return first === "left" ? ["left", "right"] : ["right", "left"];
}
// Subsequence match: every char of query appears in order within the label.
// e.g. "mc" matches "Melbourne Central", "Macaulay", "Jolimont-MCG".
// The bus search does the equivalent in SQL, so the two pickers behave alike.
function subsequenceMatch(query, text) {
    const q = query.toLowerCase().replace(/\s+/g, "");
    if (!q)
        return true;
    const t = text.toLowerCase();
    let i = 0;
    for (const ch of t) {
        if (ch === q[i])
            i++;
        if (i === q.length)
            return true;
    }
    return i === q.length;
}
// ---- Row + shared UI pieces ------------------------------------------------
function buildRow(card, dep) {
    const bestIso = dep.estimatedUtc ?? dep.scheduledUtc;
    const mins = minutesUntil(bestIso);
    const hideWithin = effectiveWalk(card);
    const row = el("div", "row");
    const isTrain = card.mode === "train";
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
    // Each fact is its own element so the stylesheet can drop the ones a small
    // card has no room for, rather than the row being rebuilt at every size.
    const meta = el("span", "meta");
    if (dep.platform)
        meta.appendChild(el("span", "meta-platform", "Platform " + dep.platform));
    meta.appendChild(el("span", "meta-live", dep.estimatedUtc ? "Live" : "Scheduled"));
    meta.appendChild(el("span", "meta-time", melbTime(new Date(bestIso))));
    dest.append(name, meta);
    const minsEl = el("div", "mins" + (mins <= hideWithin + 1 ? " now" : ""));
    minsEl.innerHTML = mins + "<small>min</small>";
    row.append(badge, dest, minsEl);
    return row;
}
function makeEmptyNote(text) {
    return el("div", "empty", text);
}
// Shared right-side collapse chevron. Used by both train and bus headers so
// the collapse affordance is identical and can't drift between the two.
function makeCollapseButton(collapsed, onToggle) {
    const btn = el("button", "collapse-btn" + (collapsed ? " collapsed" : ""));
    btn.type = "button";
    btn.textContent = "▾"; // down chevron
    btn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggle();
    });
    return btn;
}
// ---- Overflow trimming (grid layout only) ---------------------------------
function trimOverflow(isGrid) {
    if (!isGrid)
        return;
    document.querySelectorAll("#board section").forEach((section) => {
        const rows = section.querySelector(".rows");
        if (!rows)
            return;
        const isSplit = rows.classList.contains("split");
        const cols = isSplit ? [...rows.querySelectorAll(".col")] : null;
        let guard = 80;
        while (guard-- > 0 && section.scrollHeight > section.clientHeight) {
            if (isSplit && cols) {
                let target = null;
                let most = 0;
                for (const col of cols) {
                    const n = col.querySelectorAll(".row").length;
                    if (n > most) {
                        most = n;
                        target = col;
                    }
                }
                if (!target || most === 0)
                    break;
                const colRows = target.querySelectorAll(".row");
                colRows[colRows.length - 1].remove();
            }
            else {
                if (!rows.lastElementChild)
                    break;
                rows.lastElementChild.remove();
            }
        }
    });
}
// ---- Station picker: data loading -------------------------------------------
async function loadStationPicker() {
    stationPickerState = "loading";
    try {
        const res = await fetch("/api/stations");
        if (!res.ok)
            throw new Error("HTTP " + res.status);
        stationPicker = (await res.json());
        stationPickerState = "loaded";
        stationPickerError = null;
    }
    catch (err) {
        stationPicker = [];
        stationPickerError = err instanceof Error ? err.message : "failed to load stations";
        stationPickerState = "error";
    }
    if (stationMenuCardId !== null)
        render();
}
// ---- Station picker menu (with search) -------------------------------------
function buildStationMenu(section, card) {
    const menu = el("div", "station-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    const search = el("input", "station-search");
    search.type = "text";
    search.placeholder = "Search stations";
    search.value = stationQuery;
    search.addEventListener("input", () => {
        stationQuery = search.value;
        refreshStationList(list, card);
    });
    search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const first = list.querySelector("button.opt");
            if (first)
                first.click();
        }
        else if (e.key === "Escape") {
            stationMenuCardId = null;
            stationQuery = "";
            render();
        }
    });
    const list = el("div", "station-list");
    menu.append(search, list);
    section.appendChild(menu);
    refreshStationList(list, card);
    setTimeout(() => search.focus(), 0);
}
function refreshStationList(list, card) {
    list.innerHTML = "";
    if (stationPickerState === "loading") {
        list.appendChild(el("div", "no-match", "Loading stations…"));
        return;
    }
    if (stationPickerState === "error") {
        list.appendChild(el("div", "error", "Couldn't load the station list. " + (stationPickerError ?? "")));
        const retry = el("button", "opt", "Try again");
        retry.type = "button";
        retry.addEventListener("click", (e) => {
            e.stopPropagation();
            loadStationPicker().then(() => refreshStationList(list, card));
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
        const btn = el("button", "opt" + (s.key === card.stopId ? " active" : ""), s.label);
        btn.type = "button";
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            stationMenuCardId = null;
            stationQuery = "";
            setCardStop(card, s.key);
        });
        list.appendChild(btn);
    }
}
// ---- Bus picker: search ------------------------------------------------------
function closeBusMenu() {
    busMenuCardId = null;
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
async function runBusSearch(term) {
    const seq = ++busRequestSeq;
    busSearchState = "loading";
    paintBusList();
    try {
        const res = await fetch("/api/stops/search?q=" + encodeURIComponent(term));
        if (!res.ok)
            throw new Error("HTTP " + res.status);
        const data = (await res.json());
        if (seq !== busRequestSeq)
            return; // a newer search already won
        busResults = data;
        busSearchState = "loaded";
        busSearchError = null;
    }
    catch (err) {
        if (seq !== busRequestSeq)
            return;
        busResults = [];
        busSearchError = err instanceof Error ? err.message : "search failed";
        busSearchState = "error";
    }
    paintBusList();
}
function scheduleBusSearch() {
    if (busDebounceTimer !== undefined)
        clearTimeout(busDebounceTimer);
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
function paintBusList() {
    const list = busListEl;
    if (!list || !list.isConnected)
        return;
    list.innerHTML = "";
    if (busSearchState === "idle") {
        list.appendChild(el("div", "no-match", `Type at least ${MIN_SEARCH_CHARS} characters to search.`));
        return;
    }
    if (busSearchState === "loading") {
        list.appendChild(el("div", "no-match", "Searching…"));
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
    const card = cardById(busMenuCardId);
    const activeStopId = card ? card.stopId : -1;
    for (const stop of busResults) {
        const btn = el("button", "opt" + (stop.stopId === activeStopId ? " active" : ""));
        btn.type = "button";
        btn.appendChild(el("span", undefined, stop.label));
        // Route numbers inline, in the dimmer meta treatment used on rows.
        if (stop.routes.length > 0) {
            const shown = stop.routes.slice(0, BUS_ROUTES_SHOWN).join(", ");
            const extra = stop.routes.length - BUS_ROUTES_SHOWN;
            btn.appendChild(el("span", "opt-routes", shown + (extra > 0 ? ` +${extra}` : "")));
        }
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!card)
                return;
            closeBusMenu();
            setCardStop(card, stop.stopId);
        });
        list.appendChild(btn);
    }
}
function buildBusMenu(section) {
    const menu = el("div", "station-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    const search = el("input", "station-search");
    search.type = "text";
    search.placeholder = "Search bus stops";
    search.value = busQuery;
    search.addEventListener("input", () => {
        busQuery = search.value;
        scheduleBusSearch();
    });
    search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const first = list.querySelector("button.opt");
            if (first)
                first.click();
        }
        else if (e.key === "Escape") {
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
function buildTrainGrid(section, card, stop, split, sideBySide) {
    const cap = MAX_FILL.train;
    const rowsWrap = el("div", "rows" + (split ? (sideBySide ? " split" : " stacked-split") : ""));
    section.appendChild(rowsWrap);
    let colLeft = null;
    let colRight = null;
    if (split) {
        colLeft = el("div", "col");
        colLeft.appendChild(el("h3", undefined, split.left.label));
        colRight = el("div", "col");
        colRight.appendChild(el("h3", undefined, split.right.label));
        rowsWrap.append(colLeft, colRight);
    }
    if (stop.error) {
        (split ? colLeft : rowsWrap).appendChild(el("div", "error", "Data unavailable. " + stop.error));
        return;
    }
    const departures = visibleDepartures(card, stop).slice(0, cap);
    for (const dep of departures) {
        const row = buildRow(card, dep);
        if (split) {
            (pickColumn(split, dep) === "right" ? colRight : colLeft).appendChild(row);
        }
        else {
            rowsWrap.appendChild(row);
        }
    }
    if (departures.length === 0) {
        (split ? colLeft : rowsWrap).appendChild(makeEmptyNote("No catchable departures right now."));
    }
    else if (split) {
        for (const col of [colLeft, colRight]) {
            if (!col.querySelector(".row"))
                col.appendChild(makeEmptyNote("No departures"));
        }
    }
}
function buildTrainStacked(section, card, stop, split, sideBySide) {
    const rowsWrap = el("div", "rows" + (split ? (sideBySide ? " split" : " stacked-split") : ""));
    section.appendChild(rowsWrap);
    if (stop.error) {
        rowsWrap.appendChild(el("div", "error", "Data unavailable. " + stop.error));
        return;
    }
    const departures = visibleDepartures(card, stop);
    if (!split) {
        const shown = departures.slice(0, PORTRAIT.trainSingleList);
        for (const dep of shown)
            rowsWrap.appendChild(buildRow(card, dep));
        if (shown.length === 0)
            rowsWrap.appendChild(makeEmptyNote("No catchable departures right now."));
        return;
    }
    const sides = orderedSides(split);
    const colBySide = {};
    for (const side of sides) {
        const col = el("div", "col");
        col.appendChild(el("h3", undefined, split[side].label));
        rowsWrap.appendChild(col);
        colBySide[side] = col;
    }
    const counts = { left: 0, right: 0 };
    for (const dep of departures) {
        if (counts.left >= PORTRAIT.trainPerGroup && counts.right >= PORTRAIT.trainPerGroup)
            break;
        const side = pickColumn(split, dep);
        if (counts[side] >= PORTRAIT.trainPerGroup)
            continue;
        colBySide[side].appendChild(buildRow(card, dep));
        counts[side]++;
    }
    for (const side of sides) {
        if (!colBySide[side].querySelector(".row")) {
            colBySide[side].appendChild(makeEmptyNote("No departures"));
        }
    }
}
function buildBusGrid(section, card, stop) {
    const rowsWrap = el("div", "rows");
    section.appendChild(rowsWrap);
    if (stop.error) {
        rowsWrap.appendChild(el("div", "error", "Data unavailable. " + stop.error));
        return;
    }
    const departures = visibleDepartures(card, stop).slice(0, MAX_FILL.bus);
    for (const dep of departures)
        rowsWrap.appendChild(buildRow(card, dep));
    if (departures.length === 0) {
        rowsWrap.appendChild(makeEmptyNote("No catchable departures right now."));
    }
}
// Portrait: bus header shows next times inline plus a right-side collapse
// chevron matching the train header. The chevron is the collapse control.
function buildBusPortrait(section, card, stop, h2) {
    const collapsed = isCollapsed(card);
    const catchable = stop.error ? [] : visibleDepartures(card, stop);
    const times = el("span", "h2-times");
    if (stop.error) {
        times.classList.add("none");
        times.textContent = "no data";
    }
    else if (catchable.length === 0) {
        times.classList.add("none");
        times.textContent = "none";
    }
    else {
        for (const dep of catchable.slice(0, PORTRAIT.busSummaryTimes)) {
            const mins = minutesUntil(dep.estimatedUtc ?? dep.scheduledUtc);
            times.appendChild(el("span", undefined, dep.route + " " + mins + "m"));
        }
    }
    const collapse = makeCollapseButton(collapsed, () => {
        toggleCollapsed(card);
        render();
    });
    h2.append(times, collapse);
    if (collapsed)
        return;
    const rowsWrap = el("div", "rows");
    section.appendChild(rowsWrap);
    if (stop.error) {
        rowsWrap.appendChild(el("div", "error", "Data unavailable. " + stop.error));
        return;
    }
    const shownDeps = catchable.slice(0, PORTRAIT.busExpandedRows);
    for (const dep of shownDeps)
        rowsWrap.appendChild(buildRow(card, dep));
    if (shownDeps.length === 0)
        rowsWrap.appendChild(makeEmptyNote("No departures"));
}
// ---- Render ---------------------------------------------------------------
function render() {
    if (!lastPayload)
        return;
    const board = must("board");
    // Stop watching the sections about to be thrown away; the fresh ones are
    // observed again as they are appended.
    cardObserver.disconnect();
    board.innerHTML = "";
    busListEl = null; // the old list node is about to be discarded
    const isGrid = getComputedStyle(board).display === "grid";
    cards.forEach((card, index) => {
        const stop = boardForCard(card);
        if (!stop)
            return; // payload predates a just-changed card; next refresh fixes it
        const isTrain = card.mode === "train";
        const section = el("section");
        section.dataset.key = legacySlotFor(card, index);
        section.dataset.cardId = card.id;
        const known = cardSize.get(card.id);
        if (known)
            section.dataset.density = densityFor(known.w, known.h);
        const h2 = el("h2", "picker");
        const nameEl = el("span", "h2-name");
        // Both train and bus headers are pickers; only the menu differs.
        nameEl.append(el("span", undefined, stop.label), el("span", "caret", "▾"));
        nameEl.addEventListener("click", (e) => {
            e.stopPropagation();
            const wasOpen = isTrain
                ? stationMenuCardId === card.id
                : busMenuCardId === card.id;
            closeAllMenus();
            if (!wasOpen) {
                if (isTrain)
                    stationMenuCardId = card.id;
                else
                    busMenuCardId = card.id;
            }
            render();
        });
        h2.appendChild(nameEl);
        if (isTrain && !isGrid) {
            h2.appendChild(makeCollapseButton(isCollapsed(card), () => {
                toggleCollapsed(card);
                render();
            }));
        }
        section.appendChild(h2);
        if (isTrain) {
            const showBody = isGrid || !isCollapsed(card);
            if (showBody) {
                const split = splitForType(stop.stationType);
                // Height-constrained cards fill and get trimmed; free-flowing ones use
                // a fixed cap. Whether the columns sit side by side is a separate,
                // width-driven question.
                if (isGrid)
                    buildTrainGrid(section, card, stop, split, splitSideBySide(card, isGrid));
                else
                    buildTrainStacked(section, card, stop, split, splitSideBySide(card, isGrid));
            }
        }
        else {
            if (isGrid)
                buildBusGrid(section, card, stop);
            else
                buildBusPortrait(section, card, stop, h2);
        }
        if (isTrain && stationMenuCardId === card.id)
            buildStationMenu(section, card);
        if (!isTrain && busMenuCardId === card.id)
            buildBusMenu(section);
        board.appendChild(section);
        cardObserver.observe(section);
    });
    trimOverflow(isGrid);
    updateWalkUI();
}
// ---- Walk filter stepper ----------------------------------------------------
function updateWalkUI() {
    const wrap = must("walk");
    const label = must("walk-label");
    const on = walkMinutes > 0;
    wrap.classList.toggle("on", on);
    label.textContent = on ? "Walk " + walkMinutes + " min" : "Walk filter: off";
}
function setWalkMinutes(v) {
    walkMinutes = Math.max(0, v);
    saveSetting("ptv-walk-minutes", String(walkMinutes));
    render();
}
// +/- snap to the nearest stop in WALK_STOPS, so tapping cycles sensibly
function nudgeWalk(dir) {
    const stops = WALK_STOPS;
    let idx = stops.indexOf(walkMinutes);
    if (idx === -1) {
        let nearest = 0, best = Infinity;
        stops.forEach((s, i) => {
            const d = Math.abs(s - walkMinutes);
            if (d < best) {
                best = d;
                nearest = i;
            }
        });
        idx = nearest;
    }
    else {
        idx = Math.min(stops.length - 1, Math.max(0, idx + dir));
    }
    setWalkMinutes(stops[idx]);
}
let lastWalkValue = walkMinutes > 0 ? walkMinutes : WALK_DEFAULT;
// ---- Data fetch -----------------------------------------------------------
function boardUrl() {
    const stops = cards.map(stopKeyFor).join(",");
    return "/api/board?stops=" + encodeURIComponent(stops);
}
async function refresh() {
    const dot = must("dot");
    const updated = must("updated");
    try {
        const res = await fetch(boardUrl());
        if (!res.ok)
            throw new Error("HTTP " + res.status);
        lastPayload = (await res.json());
        dot.className = "";
        updated.textContent = "Updated " + melbTime(new Date());
    }
    catch {
        dot.className = "down";
        updated.textContent = "connection lost";
    }
    render();
}
// ---- Wake lock (iOS 16.4+) -------------------------------------------------
let wakeLock = null;
async function requestWakeLock() {
    try {
        if ("wakeLock" in navigator) {
            wakeLock = await navigator.wakeLock.request("screen");
        }
    }
    catch {
        /* not critical */
    }
}
// ---- Wiring / init --------------------------------------------------------
function init() {
    setInterval(tickClock, 1000);
    tickClock();
    // Write the migrated layout back on first run, so the card list becomes the
    // stored source of truth even if the user never changes anything.
    saveLayout();
    must("walk-minus").addEventListener("click", (e) => {
        e.stopPropagation();
        nudgeWalk(-1);
    });
    must("walk-plus").addEventListener("click", (e) => {
        e.stopPropagation();
        nudgeWalk(+1);
    });
    must("walk-label").addEventListener("click", (e) => {
        e.stopPropagation();
        if (walkMinutes > 0) {
            lastWalkValue = walkMinutes;
            setWalkMinutes(0);
        }
        else {
            setWalkMinutes(lastWalkValue);
        }
    });
    updateWalkUI();
    // Board and station-picker fetches are independent: the board renders
    // as soon as it's back, without waiting on the picker list.
    loadStationPicker();
    refresh();
    setInterval(refresh, REFRESH_MS);
    setInterval(() => { if (!anyMenuOpen())
        render(); }, 20_000);
    let resizeTimer;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => { if (!anyMenuOpen())
            render(); }, 200);
    });
    requestWakeLock();
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible")
            requestWakeLock();
    });
}
init();
