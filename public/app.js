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
// How long a removed card can be brought back.
const UNDO_MS = 7000;
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
// ---- Landscape layout ------------------------------------------------------
// The wall board has no scrollbar and nobody standing at it to scroll, so when
// there are more cards than fit legibly it does what a real PIDS board does:
// keeps the important one pinned and cycles the rest. The floor below is the
// point past which shrinking stops being an option - a card narrower or
// shorter than this cannot show a header plus three readable rows.
const CARD_FLOOR = { w: 260, h: 130 }; // header plus three glance rows
const CYCLE_MS = 15_000;
const MAX_SECONDARY_COLS = 3;
let pageIndex = 0;
let pageTimer;
let pageJustTurned = false;
/**
 * Works out the grid from the space available and the number of cards, rather
 * than from a fixed template. The primary card takes column one for the full
 * height; everything else tiles into the columns beside it, adding a column
 * only while each one stays above the floor.
 */
function planLandscape(boardW, boardH, secondaries, primaryWide) {
    const primaryFr = primaryWide ? 1.75 : 1;
    if (secondaries <= 0)
        return { cols: 0, rows: 1, perPage: 1, pages: 1, primaryFr };
    // The most rows this height can carry without a card dropping below the floor.
    const rowsMax = Math.max(1, Math.floor(boardH / CARD_FLOOR.h));
    // Widen only while there is more to place and each column stays readable.
    let cols = 1;
    while (cols < MAX_SECONDARY_COLS && cols * rowsMax < secondaries) {
        const next = cols + 1;
        if (boardW / (primaryFr + next) < CARD_FLOOR.w)
            break;
        cols = next;
    }
    const perPage = Math.min(secondaries, cols * rowsMax);
    const pages = Math.ceil(secondaries / perPage);
    // Only as many rows as the visible page needs. Sizing from rowsMax instead
    // would leave a short board padded out with empty grid rows.
    const rows = Math.max(1, Math.min(rowsMax, Math.ceil(perPage / cols)));
    return { cols, rows, perPage, pages, primaryFr };
}
function stopCycling() {
    if (pageTimer !== undefined) {
        clearInterval(pageTimer);
        pageTimer = undefined;
    }
}
function startCycling(pages) {
    stopCycling();
    if (pages <= 1)
        return;
    pageTimer = window.setInterval(() => {
        // Never rotate the board out from under someone using a menu.
        if (anyMenuOpen())
            return;
        pageIndex = (pageIndex + 1) % pages;
        pageJustTurned = true;
        render();
    }, CYCLE_MS);
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
// Edit mode. The board is wall-mounted as often as it is held, so every
// control that can change the layout stays hidden until it is asked for.
let editMode = false;
let settingsCardId = null;
let addMenuOpen = false;
let pendingUndo = null;
// Unified picker (add a stop), backed by /api/search.
let addQuery = "";
let addResults = [];
let addState = "idle";
let addError = null;
let addDebounce;
let addSeq = 0;
let addListEl = null;
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
/**
 * Collapse is per card and persisted. With nothing stored, the primary card is
 * the one you came to read, so it opens and everything else stays shut - which
 * is what keeps roughly four cards above the fold on a phone.
 */
function isCollapsed(card) {
    if (typeof card.collapsed === "boolean")
        return card.collapsed;
    return !card.primary;
}
function toggleCollapsed(card) {
    card.collapsed = !isCollapsed(card);
    saveLayout();
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
function primaryCard() {
    return cards.find((c) => c.primary) ?? cards[0];
}
function anyMenuOpen() {
    return (stationMenuCardId !== null ||
        busMenuCardId !== null ||
        settingsCardId !== null ||
        addMenuOpen);
}
function closeAllMenus() {
    stationMenuCardId = null;
    stationQuery = "";
    settingsCardId = null;
    closeAddMenu();
    closeBusMenu();
}
function closeAddMenu() {
    addMenuOpen = false;
    addQuery = "";
    addResults = [];
    addState = "idle";
    addError = null;
    addListEl = null;
    if (addDebounce !== undefined) {
        clearTimeout(addDebounce);
        addDebounce = undefined;
    }
}
// ---- Bottom sheet ----------------------------------------------------------
// Every picker is a sheet that rises from the bottom of the screen rather than
// a dropdown pinned to whatever opened it. A dropdown had to live inside its
// card, which meant it was clipped by the card's own bounds and was only ever
// as wide as the card allowed; a sheet is mounted on the body and answers to
// the viewport instead.
//
// The sheet is deliberately outside the render cycle. render() empties #board
// on every pass, so anything inside it is destroyed and rebuilt - which would
// lose the caret on every keystroke and leave nothing on screen to animate out
// on close. syncSheet() reconciles what is mounted against what the state says
// should be open, and touches the DOM only when those disagree.
/** Matches the transition in styles.css. */
const SHEET_MS = 280;
let sheetKeyMounted = null;
let sheetNodes = null;
/** Which sheet the current state calls for, or null for none. */
function wantedSheetKey() {
    if (addMenuOpen)
        return "add";
    if (stationMenuCardId !== null)
        return "station:" + stationMenuCardId;
    if (busMenuCardId !== null)
        return "bus:" + busMenuCardId;
    return null;
}
function presentSheet(key) {
    const card = cardById(key.slice(key.indexOf(":") + 1));
    let sheet;
    if (key === "add")
        sheet = buildAddSheet();
    else if (key.startsWith("station:"))
        sheet = card ? buildStationSheet(card) : null;
    else
        sheet = card ? buildBusSheet(card) : null;
    if (!sheet)
        return;
    const scrim = el("div", "sheet-scrim");
    scrim.addEventListener("click", () => {
        closeAllMenus();
        render();
    });
    document.body.append(scrim, sheet);
    sheetNodes = { scrim, sheet };
    // Mount at the closed position for one frame so the transition has somewhere
    // to run from; adding the class in the same frame would skip the animation.
    requestAnimationFrame(() => {
        scrim.classList.add("is-open");
        sheet.classList.add("is-open");
    });
}
function dismissSheet(animated) {
    const nodes = sheetNodes;
    if (!nodes)
        return;
    sheetNodes = null;
    addListEl = null;
    busListEl = null;
    if (!animated) {
        nodes.scrim.remove();
        nodes.sheet.remove();
        return;
    }
    nodes.scrim.classList.remove("is-open");
    nodes.sheet.classList.remove("is-open");
    const drop = () => {
        nodes.scrim.remove();
        nodes.sheet.remove();
    };
    // transitionend is the tidy path, but it never fires for a backgrounded tab,
    // so the timer is the one that actually guarantees the node leaves. Removing
    // an already-removed node is a no-op, so both firing is harmless.
    nodes.sheet.addEventListener("transitionend", drop, { once: true });
    setTimeout(drop, SHEET_MS + 80);
}
/**
 * Reconcile the mounted sheet against the state. Called at the end of every
 * render; does nothing at all when the two already agree, which is what keeps
 * the search field's focus and caret while results stream in.
 */
function syncSheet() {
    const want = wantedSheetKey();
    if (want === sheetKeyMounted)
        return;
    // Sliding one sheet out while another slides in reads as a glitch rather
    // than as a transition, so a swap is instant and only the edges animate.
    if (sheetNodes)
        dismissSheet(want === null);
    sheetKeyMounted = want;
    if (want !== null)
        presentSheet(want);
}
/** Sheet chrome: eyebrow, title, and a 44px close. The body is the caller's. */
function buildSheetShell(eyebrow, title) {
    const sheet = el("div", "sheet");
    sheet.addEventListener("click", (e) => e.stopPropagation());
    const head = el("div", "sheet-head");
    const titles = el("div", "sheet-titles");
    titles.append(el("div", "sheet-eyebrow", eyebrow), el("div", "sheet-title", title));
    const close = el("button", "sheet-close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllMenus();
        render();
    });
    head.append(titles, close);
    const body = el("div", "sheet-body");
    sheet.append(head, body);
    return { sheet, body };
}
/** The search field every picker sheet opens with. */
function buildSheetSearch(placeholder, value, onInput, onEnter) {
    const wrap = el("div", "sheet-search");
    const input = el("input", "station-search");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter")
            onEnter();
        else if (e.key === "Escape") {
            closeAllMenus();
            render();
        }
    });
    wrap.appendChild(input);
    return { wrap, input };
}
/** Focus lands after the slide, so the keyboard does not race the animation. */
function focusAfterPresent(input) {
    setTimeout(() => input.focus(), SHEET_MS);
}
// ---- Card mutations --------------------------------------------------------
// Each one writes the layout and repaints. Only the ones that change which
// stops the board asks for trigger a refetch.
function moveCard(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= cards.length)
        return;
    const [moved] = cards.splice(index, 1);
    cards.splice(to, 0, moved);
    saveLayout();
    render();
}
function setPrimary(card) {
    for (const c of cards)
        delete c.primary;
    card.primary = true;
    // The primary card is the one you came to read, so open it.
    card.collapsed = false;
    pageIndex = 0;
    saveLayout();
    render();
}
function clearUndo() {
    if (pendingUndo) {
        clearTimeout(pendingUndo.timer);
        pendingUndo = null;
    }
}
function setPrimaryQuiet(card) {
    if (!card)
        return;
    for (const c of cards)
        delete c.primary;
    card.primary = true;
}
function removeCard(card) {
    const index = cards.indexOf(card);
    if (index < 0 || cards.length <= 1)
        return; // never leave a blank board
    clearUndo();
    cards.splice(index, 1);
    if (!cards.some((c) => c.primary))
        setPrimaryQuiet(cards[0]);
    saveLayout();
    pendingUndo = {
        card,
        index,
        timer: window.setTimeout(() => {
            pendingUndo = null;
            render();
        }, UNDO_MS),
    };
    render();
}
function undoRemove() {
    if (!pendingUndo)
        return;
    const { card, index } = pendingUndo;
    clearUndo();
    cards.splice(Math.min(index, cards.length), 0, card);
    saveLayout();
    refresh();
}
function addCard(hit) {
    if (cards.length >= MAX_CARDS)
        return;
    if (cards.some((c) => c.mode === hit.mode && c.stopId === hit.stopId))
        return;
    cards.push({
        id: newCardId(),
        mode: hit.mode,
        stopId: hit.stopId,
        collapsed: true, // a new card announces itself without shoving the rest down
    });
    saveLayout();
    closeAllMenus();
    refresh();
}
function setCardWalk(card, minutes) {
    card.walkMinutes = Math.max(0, minutes);
    saveLayout();
    render();
}
/** Toggles one route on a card. An empty selection means "all routes". */
function toggleCardRoute(card, routeId, allIds) {
    const current = card.routeIds && card.routeIds.length > 0 ? card.routeIds : allIds;
    const next = current.includes(routeId)
        ? current.filter((id) => id !== routeId)
        : [...current, routeId];
    // Selecting everything is the same as filtering nothing; store it as such so
    // the card stops advertising a filter it is not really applying.
    card.routeIds = next.length === 0 || next.length === allIds.length ? undefined : next;
    saveLayout();
    render();
}
/** Distinct routes seen at this stop, taken from the unfiltered payload so a
 *  filter can never hide the very options needed to undo it. */
function routeOptions(stop) {
    const seen = new Map();
    for (const dep of stop.departures) {
        if (!seen.has(dep.routeId))
            seen.set(dep.routeId, dep.route);
    }
    return [...seen].map(([id, label]) => ({ id, label }));
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
/** A service is only called late once it has slipped past rounding noise. */
const LATE_THRESHOLD_MIN = 2;
/**
 * The countdown, then the service.
 *
 * The numeral sits on a rail of its own on the left, larger and heavier than
 * anything else in the row, because it is the one thing being read. Everything
 * that qualifies it - the line, where it is going, which platform, whether the
 * time can be trusted - follows to its right.
 */
function buildRow(card, dep) {
    const bestIso = dep.estimatedUtc ?? dep.scheduledUtc;
    const mins = minutesUntil(bestIso);
    const hideWithin = effectiveWalk(card);
    const row = el("div", "row");
    // ---- rail: numeral over its unit
    const rail = el("div", "rail" + (mins <= hideWithin + 1 ? " now" : ""));
    rail.append(el("span", "mins", String(mins)), el("span", "unit", "min"));
    // ---- body: line badge and destination, then the qualifying metadata
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
    dest.append(badge, el("span", "name", dep.destination));
    // Each fact is its own element so the stylesheet can drop the ones a small
    // card has no room for, rather than the row being rebuilt at every size.
    const meta = el("span", "meta");
    if (dep.platform) {
        // Mixed weight inside one line: the number is the part being looked for.
        const plat = el("span", "meta-platform");
        plat.append("Platform ", el("b", undefined, dep.platform));
        meta.appendChild(plat);
    }
    const lateBy = dep.estimatedUtc
        ? Math.round((new Date(dep.estimatedUtc).getTime() - new Date(dep.scheduledUtc).getTime()) / 60000)
        : 0;
    if (lateBy >= LATE_THRESHOLD_MIN) {
        // Colour alone would say "something is off" without saying what, so the
        // delay is spelled out and the time it replaced is struck through beside
        // it - you can see both what was promised and what is actually happening.
        meta.appendChild(el("span", "meta-status late", `${lateBy} min late`));
        const time = el("span", "meta-time");
        time.append(el("s", undefined, melbTime(new Date(dep.scheduledUtc))), el("span", undefined, " " + melbTime(new Date(bestIso))));
        meta.appendChild(time);
    }
    else {
        meta.appendChild(el("span", dep.estimatedUtc ? "meta-status live" : "meta-status", dep.estimatedUtc ? "Live" : "Scheduled"));
        meta.appendChild(el("span", "meta-time", melbTime(new Date(bestIso))));
    }
    const body = el("div", "body");
    body.append(dest, meta);
    row.append(rail, body);
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
        // Both tokens mean "this card holds .col children". Testing only for
        // "split" made a stacked card look unsplit, and the else branch below then
        // removed whole direction columns instead of trimming rows inside them.
        const isSplit = rows.classList.contains("split") || rows.classList.contains("stacked-split");
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
function buildStationSheet(card) {
    const { sheet, body } = buildSheetShell("Change stop", "Pick a station");
    const list = el("div", "station-list");
    const { wrap, input } = buildSheetSearch("Search stations", stationQuery, (v) => {
        stationQuery = v;
        refreshStationList(list, card);
    }, () => list.querySelector("button.opt")?.click());
    body.append(wrap, list);
    refreshStationList(list, card);
    focusAfterPresent(input);
    return sheet;
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
/**
 * The dimmer second line of a picker row: "Footscray · 216, 220, 402 +2".
 * Either half may be missing, and both may be, in which case the row is just
 * the stop name. Keeping this off the name's own line is what lets a long
 * name stay readable in a narrow menu — nothing has to shrink to make room.
 */
function optMetaLine(suburb, routes) {
    const parts = [];
    if (suburb)
        parts.push(suburb);
    if (routes.length > 0) {
        const shown = routes.slice(0, BUS_ROUTES_SHOWN).join(", ");
        const extra = routes.length - BUS_ROUTES_SHOWN;
        parts.push(shown + (extra > 0 ? ` +${extra}` : ""));
    }
    return parts.join(" · ");
}
/** Name over meta, as one shrinkable block beside the mode badge. */
function optTextBlock(label, meta) {
    const text = el("span", "opt-text");
    text.appendChild(el("span", "opt-name", label));
    if (meta)
        text.appendChild(el("span", "opt-routes", meta));
    return text;
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
        btn.appendChild(optTextBlock(stop.label, optMetaLine(stop.suburb, stop.routes)));
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
function buildBusSheet(_card) {
    const { sheet, body } = buildSheetShell("Change stop", "Pick a bus stop");
    const list = el("div", "station-list");
    busListEl = list;
    const { wrap, input } = buildSheetSearch("Search bus stops", busQuery, (v) => {
        busQuery = v;
        scheduleBusSearch();
    }, () => list.querySelector("button.opt")?.click());
    body.append(wrap, list);
    paintBusList();
    focusAfterPresent(input);
    return sheet;
}
// Close any open menu when tapping elsewhere.
document.addEventListener("click", () => {
    if (anyMenuOpen()) {
        closeAllMenus();
        render();
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape")
        return;
    if (anyMenuOpen()) {
        closeAllMenus();
        render();
    }
    else if (editMode) {
        setEditMode(false);
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
/**
 * The departures a collapsed card should advertise. A split station shows the
 * next service in each direction - two chronological departures could both be
 * heading the same way, which is exactly the case where a summary misleads.
 * Everything else shows the next two.
 */
function summaryDepartures(split, departures, limit) {
    if (!split)
        return departures.slice(0, limit);
    const picked = [];
    for (const side of orderedSides(split)) {
        const next = departures.find((dep) => pickColumn(split, dep) === side);
        if (next)
            picked.push(next);
    }
    return picked.length > 0 ? picked.slice(0, limit) : departures.slice(0, limit);
}
/**
 * The inline summary in a collapsed card's header. Trains get their line
 * colour, buses their route number, so a glance at a shut card still tells you
 * which service the countdown belongs to.
 */
function buildSummary(card, departures) {
    const times = el("span", "h2-times");
    for (const dep of departures) {
        const chip = el("span", "h2-chip");
        const badge = el("span", "h2-badge " + (card.mode === "train" ? "train" : "bus"));
        badge.textContent = card.mode === "train" ? dep.route.charAt(0) : dep.route;
        if (card.mode === "train") {
            const c = lineColor(dep.route);
            if (c) {
                badge.style.background = c.bg;
                badge.style.color = c.fg;
            }
        }
        const mins = minutesUntil(dep.estimatedUtc ?? dep.scheduledUtc);
        chip.append(badge, el("span", "h2-mins", mins + "m"));
        times.appendChild(chip);
    }
    return times;
}
// Portrait: a train card collapses like every other card now, summarising the
// next service in each direction rather than going blank.
function buildTrainPortrait(section, card, stop, h2, split) {
    const collapsed = isCollapsed(card);
    const catchable = stop.error ? [] : visibleDepartures(card, stop);
    let times;
    if (stop.error) {
        times = el("span", "h2-times none", "no data");
    }
    else if (catchable.length === 0) {
        times = el("span", "h2-times none", "none");
    }
    else {
        times = buildSummary(card, summaryDepartures(split, catchable, PORTRAIT.busSummaryTimes));
    }
    // A shut card's header stands in for the rows it is hiding, so it carries the
    // next service. An open card shows those rows immediately below, so repeating
    // them here would buy nothing and cost the stop name the width it needs.
    if (collapsed)
        h2.appendChild(times);
    h2.appendChild(makeCollapseButton(collapsed, () => {
        toggleCollapsed(card);
        render();
    }));
    if (collapsed)
        return;
    buildTrainStacked(section, card, stop, split, splitSideBySide(card, false));
}
// Portrait: bus header shows next times inline plus a right-side collapse
// chevron matching the train header. The chevron is the collapse control.
function buildBusPortrait(section, card, stop, h2) {
    const collapsed = isCollapsed(card);
    const catchable = stop.error ? [] : visibleDepartures(card, stop);
    let times;
    if (stop.error) {
        times = el("span", "h2-times none", "no data");
    }
    else if (catchable.length === 0) {
        times = el("span", "h2-times none", "none");
    }
    else {
        times = buildSummary(card, catchable.slice(0, PORTRAIT.busSummaryTimes));
    }
    // A shut card's header stands in for the rows it is hiding, so it carries the
    // next service. An open card shows those rows immediately below, so repeating
    // them here would buy nothing and cost the stop name the width it needs.
    if (collapsed)
        h2.appendChild(times);
    h2.appendChild(makeCollapseButton(collapsed, () => {
        toggleCollapsed(card);
        render();
    }));
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
// ---- Unified picker (add a stop) -------------------------------------------
async function runAddSearch(term) {
    const seq = ++addSeq;
    addState = "loading";
    paintAddList();
    try {
        const res = await fetch("/api/search?q=" + encodeURIComponent(term));
        if (!res.ok)
            throw new Error("HTTP " + res.status);
        const data = (await res.json());
        if (seq !== addSeq)
            return; // a newer search already won
        addResults = data;
        addState = "loaded";
        addError = null;
    }
    catch (err) {
        if (seq !== addSeq)
            return;
        addResults = [];
        addError = err instanceof Error ? err.message : "search failed";
        addState = "error";
    }
    paintAddList();
}
function scheduleAddSearch() {
    if (addDebounce !== undefined)
        clearTimeout(addDebounce);
    const term = addQuery.replace(/\s+/g, "");
    if (term.length < MIN_SEARCH_CHARS) {
        addSeq++;
        addResults = [];
        addState = "idle";
        paintAddList();
        return;
    }
    addDebounce = window.setTimeout(() => {
        addDebounce = undefined;
        runAddSearch(addQuery.trim());
    }, BUS_SEARCH_DEBOUNCE_MS);
}
function paintAddList() {
    const list = addListEl;
    if (!list || !list.isConnected)
        return;
    list.innerHTML = "";
    if (addState === "idle") {
        list.appendChild(el("div", "no-match", `Type at least ${MIN_SEARCH_CHARS} characters.`));
        return;
    }
    if (addState === "loading") {
        list.appendChild(el("div", "no-match", "Searching\u2026"));
        return;
    }
    if (addState === "error") {
        list.appendChild(el("div", "error", "Search failed. " + (addError ?? "")));
        return;
    }
    if (addResults.length === 0) {
        list.appendChild(el("div", "no-match", "Nothing matches."));
        return;
    }
    for (const hit of addResults) {
        const already = cards.some((c) => c.mode === hit.mode && c.stopId === hit.stopId);
        const btn = el("button", "opt" + (already ? " taken" : ""));
        btn.type = "button";
        btn.disabled = already;
        btn.appendChild(el("span", "opt-mode " + hit.mode, hit.mode === "train" ? "T" : "B"));
        btn.appendChild(optTextBlock(hit.label, optMetaLine(hit.suburb, hit.routes.map((r) => r.label))));
        if (already)
            btn.appendChild(el("span", "opt-flag", "Added"));
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            addCard(hit);
        });
        list.appendChild(btn);
    }
}
function buildAddSheet() {
    const { sheet, body } = buildSheetShell("Add a stop", "Find a stop");
    const list = el("div", "station-list");
    addListEl = list;
    const { wrap, input } = buildSheetSearch("Search stations and bus stops", addQuery, (v) => {
        addQuery = v;
        scheduleAddSearch();
    }, () => list.querySelector("button.opt:not([disabled])")?.click());
    body.append(wrap, list);
    paintAddList();
    focusAfterPresent(input);
    return sheet;
}
/** The dashed tile that ends the board in edit mode. */
function buildAddTile() {
    const tile = el("div", "add-tile");
    const full = cards.length >= MAX_CARDS;
    const btn = el("button", "add-btn");
    btn.type = "button";
    btn.disabled = full;
    btn.append(el("span", "add-plus", "+"), el("span", undefined, full ? `Limit of ${MAX_CARDS} stops` : "Add stop"));
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (full)
            return;
        const wasOpen = addMenuOpen;
        closeAllMenus();
        addMenuOpen = !wasOpen;
        render();
    });
    tile.appendChild(btn);
    if (!full && cards.length >= WARN_FROM) {
        tile.appendChild(el("div", "add-note", "Cards are getting tight at this many stops."));
    }
    return tile;
}
// ---- Per-card edit controls ------------------------------------------------
function iconButton(cls, glyph, label, onClick, disabled = false) {
    const btn = el("button", cls, glyph);
    btn.type = "button";
    btn.disabled = disabled;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
    });
    return btn;
}
function buildEditControls(card, index) {
    const bar = el("div", "card-edit");
    bar.append(iconButton("ce-btn", "\u2191", "Move up", () => moveCard(index, -1), index === 0), iconButton("ce-btn", "\u2193", "Move down", () => moveCard(index, +1), index === cards.length - 1), iconButton("ce-btn" + (card.primary ? " on" : ""), card.primary ? "\u2605" : "\u2606", card.primary ? "Primary card" : "Make primary", () => setPrimary(card), !!card.primary), iconButton("ce-btn" + (settingsCardId === card.id ? " on" : ""), "\u2699", "Stop settings", () => {
        const wasOpen = settingsCardId === card.id;
        closeAllMenus();
        if (!wasOpen)
            settingsCardId = card.id;
        render();
    }), iconButton("ce-btn danger", "\u2715", "Remove stop", () => removeCard(card), cards.length <= 1));
    return bar;
}
function buildSettingsSheet(host, card, stop) {
    const sheet = el("div", "settings-sheet");
    sheet.addEventListener("click", (e) => e.stopPropagation());
    const walkRow = el("div", "set-row");
    walkRow.appendChild(el("span", "set-label", "Walk to stop"));
    const stepper = el("div", "set-stepper");
    stepper.append(iconButton("ce-btn", "\u2212", "Less walking time", () => {
        const i = WALK_STOPS.indexOf(effectiveWalk(card));
        setCardWalk(card, WALK_STOPS[Math.max(0, (i < 0 ? 1 : i) - 1)]);
    }), el("span", "set-value", effectiveWalk(card) + " min"), iconButton("ce-btn", "+", "More walking time", () => {
        const i = WALK_STOPS.indexOf(effectiveWalk(card));
        setCardWalk(card, WALK_STOPS[Math.min(WALK_STOPS.length - 1, (i < 0 ? 0 : i) + 1)]);
    }));
    walkRow.appendChild(stepper);
    sheet.appendChild(walkRow);
    sheet.appendChild(el("div", "set-hint", "Departures you could not reach in time are hidden."));
    const options = routeOptions(stop);
    if (options.length > 1) {
        const head = el("div", "set-row");
        head.appendChild(el("span", "set-label", "Routes"));
        const allOn = !card.routeIds || card.routeIds.length === 0;
        const allBtn = el("button", "chip" + (allOn ? " on" : ""), "All");
        allBtn.type = "button";
        allBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            card.routeIds = undefined;
            saveLayout();
            render();
        });
        head.appendChild(allBtn);
        sheet.appendChild(head);
        const chips = el("div", "chip-row");
        const allIds = options.map((o) => o.id);
        for (const opt of options) {
            const on = allOn || (card.routeIds ?? []).includes(opt.id);
            const chip = el("button", "chip" + (on ? " on" : ""), opt.label);
            chip.type = "button";
            chip.addEventListener("click", (e) => {
                e.stopPropagation();
                toggleCardRoute(card, opt.id, allIds);
            });
            chips.appendChild(chip);
        }
        sheet.appendChild(chips);
    }
    const done = el("button", "set-done", "Done");
    done.type = "button";
    done.addEventListener("click", (e) => {
        e.stopPropagation();
        settingsCardId = null;
        render();
    });
    sheet.appendChild(done);
    host.appendChild(sheet);
}
/** Small chips in the card header showing filters that are actually on, so a
 *  card never hides departures for a reason you cannot see. */
function buildFilterChips(card) {
    const walk = effectiveWalk(card);
    const routes = card.routeIds?.length ?? 0;
    if (walk === 0 && routes === 0)
        return null;
    // The number carries the meaning, so it takes the heavier weight and the
    // word beside it stays quiet - the house treatment for a value plus a unit.
    const chip = el("span", "filter-chip");
    if (walk > 0)
        chip.append(el("b", undefined, String(walk)), " min walk");
    if (routes > 0) {
        if (walk > 0)
            chip.appendChild(el("span", "chip-sep", "\u00b7"));
        chip.append(el("b", undefined, String(routes)), " routes");
    }
    return chip;
}
function buildUndoToast() {
    const toast = el("div", "toast");
    toast.appendChild(el("span", undefined, "Stop removed"));
    const btn = el("button", "toast-undo", "Undo");
    btn.type = "button";
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        undoRemove();
    });
    toast.appendChild(btn);
    return toast;
}
// ---- Render ---------------------------------------------------------------
/**
 * The name a card wears in its header.
 *
 * Every metro station name ends in "Station", so the word carries no
 * information on a card that is already unmistakably a train - and the merged
 * pairs are much the longest labels on the board. Only a trailing occurrence
 * goes, and only on train cards, so a bus stop named "Southern Cross
 * Station/Collins St" keeps its name intact. The picker, the search results
 * and the stored label all stay full: you want certainty when choosing a stop,
 * and brevity once it is yours.
 */
function cardTitle(card, stop) {
    if (card.mode !== "train")
        return stop.label;
    return stop.label
        .split(" / ")
        .map((part) => {
        const trimmed = part.replace(/\s+Station$/i, "").trim();
        return trimmed || part; // a stop named only "Station" keeps its name
    })
        .join(" / ");
}
function buildCardSection(card, index, isGrid) {
    const stop = boardForCard(card);
    if (!stop)
        return null; // payload predates a just-changed card; next refresh fixes it
    const isTrain = card.mode === "train";
    const section = el("section");
    section.dataset.cardId = card.id;
    if (!isGrid && isCollapsed(card))
        section.dataset.collapsed = "true";
    const known = cardSize.get(card.id);
    if (known)
        section.dataset.density = densityFor(known.w, known.h);
    const h2 = el("h2", "picker");
    const nameEl = el("span", "h2-name");
    // Both train and bus headers are pickers; only the menu differs.
    nameEl.append(el("span", undefined, cardTitle(card, stop)), el("span", "caret", "\u25be"));
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
    const chip = buildFilterChips(card);
    if (chip)
        h2.appendChild(chip);
    section.appendChild(h2);
    if (editMode)
        section.appendChild(buildEditControls(card, index));
    if (isTrain) {
        const split = splitForType(stop.stationType);
        // Height-constrained cards fill and get trimmed; free-flowing ones use a
        // fixed cap. Whether the columns sit side by side is a separate,
        // width-driven question.
        if (isGrid)
            buildTrainGrid(section, card, stop, split, splitSideBySide(card, isGrid));
        else
            buildTrainPortrait(section, card, stop, h2, split);
    }
    else {
        if (isGrid)
            buildBusGrid(section, card, stop);
        else
            buildBusPortrait(section, card, stop, h2);
    }
    // The stop pickers are bottom sheets mounted on the body, so nothing here
    // has to make room for them or let them out past the card's own bounds.
    if (settingsCardId === card.id)
        buildSettingsSheet(section, card, stop);
    return section;
}
// Page indicator for a board that is cycling. Clickable, so the dots double as
// a way to jump straight to a page rather than waiting for it to come round.
function buildPageDots(pages) {
    const wrap = el("div", "page-dots");
    for (let i = 0; i < pages; i++) {
        const dot = el("button", "page-dot" + (i === pageIndex ? " on" : ""));
        dot.type = "button";
        dot.setAttribute("aria-label", `Page ${i + 1} of ${pages}`);
        dot.addEventListener("click", (e) => {
            e.stopPropagation();
            pageIndex = i;
            pageJustTurned = true;
            startCycling(pages); // restart the dwell so a tap gets a full interval
            render();
        });
        wrap.appendChild(dot);
    }
    return wrap;
}
/** Is this card's content wide enough to deserve the larger column? */
function wantsWideColumn(card) {
    if (card.mode !== "train")
        return false;
    const stop = boardForCard(card);
    return splitForType(stop?.stationType) !== null;
}
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
    let ordered;
    let plan = null;
    if (isGrid) {
        const primary = primaryCard();
        const secondaries = cards.filter((c) => c !== primary);
        const rect = board.getBoundingClientRect();
        plan = planLandscape(rect.width, rect.height, secondaries.length, primary ? wantsWideColumn(primary) : false);
        if (pageIndex >= plan.pages)
            pageIndex = 0;
        const from = pageIndex * plan.perPage;
        const page = plan.pages > 1 ? secondaries.slice(from, from + plan.perPage) : secondaries;
        board.style.gridTemplateColumns =
            `${plan.primaryFr}fr` + (plan.cols > 0 ? ` repeat(${plan.cols}, 1fr)` : "");
        board.style.gridTemplateRows = `repeat(${plan.rows}, 1fr)`;
        ordered = primary ? [primary, ...page] : page;
    }
    else {
        // Portrait scrolls, so every card is present and the grid is not in play.
        board.style.gridTemplateColumns = "";
        board.style.gridTemplateRows = "";
        ordered = cards;
        stopCycling();
    }
    board.classList.toggle("editing", editMode);
    ordered.forEach((card, i) => {
        const section = buildCardSection(card, cards.indexOf(card), isGrid);
        if (!section)
            return;
        if (isGrid && plan) {
            if (i === 0) {
                section.dataset.role = "primary";
                section.style.gridColumn = "1";
                section.style.gridRow = `1 / span ${plan.rows}`;
            }
            else {
                const k = i - 1;
                section.dataset.role = "secondary";
                section.style.gridColumn = String(2 + (k % plan.cols));
                section.style.gridRow = String(1 + Math.floor(k / plan.cols));
            }
        }
        board.appendChild(section);
        cardObserver.observe(section);
    });
    // The add tile only exists in edit mode, and never competes for a grid cell.
    if (editMode)
        board.appendChild(buildAddTile());
    if (pendingUndo)
        board.appendChild(buildUndoToast());
    if (isGrid && plan && plan.pages > 1 && !editMode) {
        board.appendChild(buildPageDots(plan.pages));
        startCycling(plan.pages);
    }
    else {
        stopCycling();
    }
    // Only the render that follows a page turn animates; a routine refresh must
    // not make the whole board flicker.
    board.classList.toggle("page-turn", pageJustTurned);
    pageJustTurned = false;
    trimOverflow(isGrid);
    // Last, because the sheet lives outside #board and only wants touching when
    // what should be open has actually changed.
    syncSheet();
}
// ---- Edit mode toggle ------------------------------------------------------
function setEditMode(on) {
    editMode = on;
    if (!on)
        closeAllMenus();
    const btn = must("edit-toggle");
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Done editing" : "Edit board";
    render();
}
// ---- Data fetch -----------------------------------------------------------
function boardUrl() {
    const stops = cards.map(stopKeyFor).join(",");
    return "/api/board?stops=" + encodeURIComponent(stops);
}
async function refresh() {
    try {
        const res = await fetch(boardUrl());
        if (!res.ok)
            throw new Error("HTTP " + res.status);
        lastPayload = (await res.json());
    }
    catch {
        // The previous payload stays on screen. Departure rows carry their own
        // absolute times, so a stale board is still readable rather than blank.
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
    // Write the migrated layout back on first run, so the card list becomes the
    // stored source of truth even if the user never changes anything.
    saveLayout();
    must("edit-toggle").addEventListener("click", (e) => {
        e.stopPropagation();
        setEditMode(!editMode);
    });
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
