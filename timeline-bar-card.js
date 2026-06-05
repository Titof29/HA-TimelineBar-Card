// =============================================================================
// timeline-bar-card  v3.2
// A Home Assistant custom card that shows a 24-hour timeline bar for one or
// more binary sensors, with coloured segments when the sensor is active.
//
// v3.1 — Secondary entity support
// v3.2 — UI editor (getConfigElement / getStubConfig)
//   Each entry in `entities:` now accepts an optional `secondary_entity` and
//   `secondary_color`.  The secondary layer is painted first; the primary
//   entity is painted on top, so it always wins on overlap.
//
//   Example YAML:
//     entities:
//       - entity: binary_sensor.tariff_peak
//         name: Peak                         # bar title
//         color: "#e07b39"
//         legend_label: Peak                 # optional — overrides "Active" in legend
//         secondary_entity: binary_sensor.tariff_shoulder
//         secondary_color:  "#f5c842"
//         secondary_legend_label: Shoulder   # optional — label for secondary swatch"
// =============================================================================
console.log("[timeline-bar-card] loading...");


// =============================================================================
// CARD CLASS
// =============================================================================
class TimelineBarCard extends HTMLElement {

  // ---------------------------------------------------------------------------
  // LIFECYCLE — constructor, setConfig, hass setter
  // ---------------------------------------------------------------------------

  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    // Internal state
    this._hass      = null;   // Home Assistant object, set by HA on each state update
    this._config    = {};     // Parsed card config (title, days, bar_height, toggles)
    this._entities  = [];     // Array of { entity, name, color, secondary_entity, secondary_color }
    this._histories = {};     // History data keyed by entity_id
    this._loading   = false;  // True while the API fetch is in progress
    this._error     = null;   // Error message string, or null
    this._lastFetch = null;   // Timestamp of the last successful fetch
  }

  // Called by HA when the YAML config is loaded or changed.
  setConfig(config) {

    // --- Parse entity list ---
    // Supports both a single `entity:` (backwards compatible) and `entities:` list.
    if (config.entities && config.entities.length > 0) {
      this._entities = config.entities.map((e, i) => ({
        entity:           e.entity,
        name:             e.name  || e.entity,
        color:            e.color || `hsl(${i * 60}, 60%, 55%)`,
        // Secondary entity — optional overlay painted beneath the primary
        secondary_entity:       e.secondary_entity       || null,
        secondary_color:        e.secondary_color        || `hsl(${i * 60 + 30}, 40%, 65%)`,
        // Legend labels — optional overrides for the Active / secondary swatches
        legend_label:           e.legend_label           || "Active",
        secondary_legend_label: e.secondary_legend_label || "Secondary",
      }));
    } else if (config.entity) {
      // Backwards-compatible single entity
      this._entities = [{
        entity:           config.entity,
        name:             config.title || config.entity,
        color:            config.color || "#6c8ebf",
        secondary_entity: null,
        secondary_color:  null,
      }];
    } else {
      // Throwing an error causes HA to display it as a red error card — clear and visible
      throw new Error("No entities specified. Please add at least one entity under 'entities:'");
    }

    // --- Parse general settings ---
    // All options have sensible defaults so only changed values need to be in YAML.
    this._config = {
      title:        config.title        ?? "Tariff Timeline", // Card header title
      bar_height:   config.bar_height   ?? 28,                // Height of each bar in pixels
      days:         config.days         ?? 1,                  // Number of days to show (1–7)

      // Display toggles — set to false in YAML to hide that element
      show_title:   config.show_title   ?? true,  // Show/hide the card title header
      show_names:   config.show_names   ?? true,  // Show/hide the entity name labels
      show_legend:  config.show_legend  ?? true,  // Show/hide the Active/Inactive legend

      // Compact mode — hides legend, dividers, and tick labels; ideal for stacking
      // under another card (e.g. apexcharts-card). Default: false.
      compact:      config.compact      ?? false,

      // Reverse days order — set to true to show today first, oldest last.
      // Default: false (oldest day first, today at the bottom).
      reverse_days:  config.reverse_days  ?? false,

      // start_hour:  0  = standard midnight-to-midnight (default)
      //             22  = starts at 22:00 the previous day, ends at 22:00 today
      //                   (matches an apexcharts-card with an offset timeline)
      start_hour:   config.start_hour   ?? 0,
    };

    this._render();
  }

  // Called by HA every time any entity state changes.
  // We use it to trigger a data refresh every 5 minutes.
  set hass(hass) {
    this._hass = hass;
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    if (!this._lastFetch || now - this._lastFetch > fiveMinutes) {
      this._fetchHistory();
    }
  }


  // ---------------------------------------------------------------------------
  // GRID SIZING — tells HA how much space to reserve for this card
  // ---------------------------------------------------------------------------

  // Used by masonry layout
  getCardSize() {
    const card = this.shadowRoot && this.shadowRoot.getElementById("card");
    if (card && card.offsetHeight) {
      return Math.ceil(card.offsetHeight / 50);
    }
    const entities = this._entities.length;
    const days     = Math.max(1, this._config.days || 1);
    return entities * (days + 1);
  }

  // Used by sections layout.
  // We do NOT set `rows` here — per the HA docs, omitting `rows` tells the
  // sections layout to size the card automatically based on its content height.
  getGridOptions() {
    return {
      columns: 12,
      min_rows: 1,
    };
  }


  // ---------------------------------------------------------------------------
  // DATA FETCHING — calls the HA history API
  // ---------------------------------------------------------------------------

  async _fetchHistory() {
    if (!this._hass || this._loading) return;

    this._loading = true;
    this._error   = null;
    this._renderContent(); // Show "Loading…" immediately

    try {
      const days      = Math.max(1, Math.min(7, this._config.days));
      const startHour = Math.max(0, Math.min(23, this._config.start_hour));
      const now       = new Date();

      // Start = midnight of the earliest day, minus one extra day if start_hour > 0
      // (because e.g. start_hour:22 means we need data from 22:00 the day before)
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const extraMs      = startHour > 0 ? 86400000 : 0;
      const start        = new Date(startOfToday.getTime() - (days - 1) * 86400000 - extraMs);

      // Collect ALL entity IDs to fetch — primary + any secondary entities.
      // Deduplicate in case two primaries share a secondary (edge case but safe).
      const entityIdSet = new Set();
      for (const e of this._entities) {
        entityIdSet.add(e.entity);
        if (e.secondary_entity) entityIdSet.add(e.secondary_entity);
      }
      const entityIds = [...entityIdSet].join(",");

      // Use hass.callApi instead of fetch() with a manual Bearer token.
      // callApi is the correct method for custom cards — it handles auth internally
      // and does NOT trigger "login attempt" notifications in HA.
      const path = `history/period/${start.toISOString()}` +
        `?filter_entity_id=${entityIds}` +
        `&end_time=${now.toISOString()}` +
        `&minimal_response` +
        `&significant_changes_only=false`;

      const data = await this._hass.callApi("GET", path);

      // HA returns one array per entity, not necessarily in request order.
      // We index them by entity_id for easy lookup.
      this._histories = {};
      for (const entityHistory of (data || [])) {
        if (entityHistory.length > 0) {
          this._histories[entityHistory[0].entity_id] = entityHistory;
        }
      }

      this._lastFetch = Date.now();
    } catch (e) {
      this._error = e.message;
    }

    this._loading = false;
    this._renderContent(); // Re-render with real data (or error)
  }


  // ---------------------------------------------------------------------------
  // RENDERING — builds the card HTML and CSS
  // ---------------------------------------------------------------------------

  // _render() builds the card shell (styles + static structure).
  // It is called once when config is set.
  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        /* --- Reset & host --- */
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; }

        /* --- Card container --- */
        .card {
          background:    var(--card-background-color, #1c1c1e);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow:    var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.2));
          padding:       14px 16px 16px;
          width:         100%;
          font-family:   var(--paper-font-body1_-_font-family, sans-serif);
        }

        /* --- Card header (title + refresh button) --- */
        .header {
          display:         flex;
          justify-content: space-between;
          align-items:     center;
          margin-bottom:   12px;
        }
        .title {
          font-size:   0.95em;
          font-weight: 500;
          color:       var(--primary-text-color, #e5e5ea);
        }
        .refresh-btn {
          background:  none;
          border:      none;
          cursor:      pointer;
          color:       var(--secondary-text-color, #8e8e93);
          font-size:   16px;
          line-height: 1;
          padding:     2px 4px;
          border-radius: 4px;
        }
        .refresh-btn:hover { color: var(--primary-color, #03a9f4); }

        /* --- Entity block (one per sensor) --- */
        .entity-block { margin-bottom: 12px; }
        .entity-block:last-child { margin-bottom: 0; }

        .entity-label {
          display:        flex;
          align-items:    center;
          gap:            6px;
          font-size:      0.78em;
          font-weight:    500;
          color:          var(--secondary-text-color, #8e8e93);
          margin-bottom:  4px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .entity-label .entity-legend {
          margin-left: auto;
          text-transform: none;
          letter-spacing: normal;
        }
        .entity-dot {
          width:        8px;
          height:       8px;
          border-radius: 50%;
          flex-shrink:  0;
        }

        /* --- Compact mode overrides --- */
        .compact .entity-block { margin-bottom: 4px; }
        .compact .entity-label {
          font-size:      0.55em;
          font-weight:    550;
          margin-bottom:  -1.5px;
          letter-spacing: 0.01em;
        }
        .compact .entity-dot {
          width:  5px;
          height: 5px;
        }

        /* --- Day rows (one bar per day) --- */
        .day-row { margin-bottom: 3px; }
        .day-row:last-child { margin-bottom: 0; }

        .day-label {
          font-size: 0.68em;
          color:     var(--secondary-text-color, #8e8e93);
          margin-bottom: 2px;
          opacity:   0.7;
        }

        /* --- Timeline bar --- */
        .bar-outer {
          position:      relative;
          width:         100%;
          height:        var(--bar-height, 28px);
          border-radius: 5px;
          overflow:      hidden;
        }
        .bar-segment {
          position: absolute;
          top:      0;
          height:   100%;
        }

        /* --- Hour tick marks below each bar group --- */
        .tick-row {
          position:   relative;
          width:      100%;
          height:     14px;
          margin-top: 3px;
        }
        .tick {
          position:    absolute;
          font-size:   0.65em;
          color:       var(--secondary-text-color, #8e8e93);
          white-space: nowrap;
        }

        /* --- Divider line between entities --- */
        .entity-divider {
          border:     none;
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.06));
          margin:     10px 0;
        }

        /* --- Entity header row: name left, legend right --- */

        .entity-legend {
          display:     flex;
          gap:         10px;
          flex-shrink: 0;
          flex-wrap:   wrap;
          justify-content: flex-end;
        }
        .legend-item {
          display:     flex;
          align-items: center;
          gap:         3px;
          font-size:   0.68em;
          color:       var(--secondary-text-color, #8e8e93);
          line-height: 1;
        }
        .legend-swatch {
          width:         8px;
          height:        8px;
          border-radius: 2px;
          flex-shrink:   0;
        }

        /* --- Status / error messages --- */
        .status {
          font-size:  0.82em;
          color:      var(--secondary-text-color, #8e8e93);
          text-align: center;
          padding:    12px 0;
        }
        .error {
          font-size:  0.82em;
          color:      var(--error-color, #f44336);
          text-align: center;
          padding:    8px 0;
        }
      </style>

      <div class="card" id="card">
        <div class="header" id="header">
          <span class="title" id="title"></span>
          <button class="refresh-btn" id="refresh" title="Refresh">↻</button>
        </div>
        <div id="content"></div>
      </div>
    `;

    // Apply config values to the shell
    const cfg = this._config;
    this.shadowRoot.getElementById("title").textContent = cfg.title;
    this.shadowRoot.getElementById("card").style.setProperty("--bar-height", `${cfg.bar_height}px`);

    // Hide the entire header row if show_title is false
    this.shadowRoot.getElementById("header").style.display = cfg.show_title ? "flex" : "none";

    // Refresh button click handler
    this.shadowRoot.getElementById("refresh").addEventListener("click", () => {
      this._lastFetch = null;
      this._fetchHistory();
    });

    this._renderContent();
  }

  // _renderContent() fills the #content div with the timeline bars.
  // It is called after every data fetch, and on loading/error state changes.
  _renderContent() {
    const el = this.shadowRoot.getElementById("content");
    if (!el) return;

    // --- Loading / error / waiting states ---
    if (this._loading) {
      el.innerHTML = `<div class="status">Loading history…</div>`;
      return;
    }
    if (this._error) {
      el.innerHTML = `<div class="error">Error: ${this._error}</div>`;
      return;
    }
    if (!this._histories) {
      el.innerHTML = `<div class="status">Waiting for data…</div>`;
      return;
    }

    const cfg        = this._config;
    const days       = Math.max(1, Math.min(7, cfg.days));
    const compact    = cfg.compact;
    const startHour  = Math.max(0, Math.min(23, cfg.start_hour));
    const now        = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    // Build a list of { windowStart, windowEnd, isToday } for each day to display.
    //
    // When start_hour = 0 (default):
    //   Each window is midnight → midnight (standard 24h bar).
    //
    // When start_hour > 0 (e.g. 22):
    //   Each window is start_hour on the PREVIOUS day → start_hour today.
    const dayWindows = [];
    for (let d = days - 1; d >= 0; d--) {
      const dayBase = new Date(startOfToday.getTime() - d * 86400000);

      const windowStart = startHour > 0
        ? new Date(dayBase.getTime() - (24 - startHour) * 3600000)
        : dayBase;

      const windowEnd = new Date(dayBase.getTime() + 86400000);

      dayWindows.push({ windowStart, windowEnd, isToday: d === 0 });
    }

    // Reverse so today appears first if requested
    if (cfg.reverse_days) dayWindows.reverse();

    // --- Build one entity block per sensor ---
    const blocks = this._entities.map((ent, idx) => {
      const primaryHistory   = this._histories[ent.entity]           || [];
      const secondaryHistory = ent.secondary_entity
        ? (this._histories[ent.secondary_entity] || [])
        : null;
      const isLast = idx === this._entities.length - 1;

      // --- Build one day row per day ---
      const dayRowsHtml = dayWindows.map(({ windowStart, windowEnd, isToday }, dayIdx) => {
        const windowMs = windowEnd - windowStart;

        // For today: only fill up to the current time, leave the future empty
        const nowPct = isToday
          ? (((now - windowStart) / windowMs) * 100).toFixed(3)
          : 100;

        // Reusable helper: converts a history array + color into positioned segment divs.
        // `clipToNow` trims segments so they don't extend past the current time on today's bar.
        const buildSegsHtml = (history, color) =>
          this._buildSegments(history, windowStart, windowEnd).map(seg => {
            const leftPct  = ((seg.start - windowStart) / windowMs) * 100;
            const widthPct = ((seg.end   - seg.start)   / windowMs) * 100;
            if (widthPct <= 0) return "";

            const isOn = seg.state === "on" || seg.state === "true" || seg.state === "1";
            if (!isOn) return "";

            // Clip the segment so it doesn't extend into the future (today only)
            const clippedRight = Math.min(leftPct + widthPct, parseFloat(nowPct));
            const clippedWidth = clippedRight - leftPct;
            if (clippedWidth <= 0) return "";

            return `<div class="bar-segment" style="
              left:       ${leftPct.toFixed(3)}%;
              width:      ${clippedWidth.toFixed(3)}%;
              background: ${color};
              opacity:    0.85;
            "></div>`;
          }).join("");

        // Paint secondary first, then primary on top — DOM order gives primary
        // z-index precedence with no extra CSS needed.
        const secondarySegsHtml = secondaryHistory !== null
          ? buildSegsHtml(secondaryHistory, ent.secondary_color)
          : "";
        const primarySegsHtml = buildSegsHtml(primaryHistory, ent.color);

        // For today: grey background only covers the elapsed portion; future is transparent
        const barStyle = isToday
          ? `background: linear-gradient(to right,
               var(--divider-color, rgba(255,255,255,0.08)) ${nowPct}%,
               transparent ${nowPct}%);`
          : `background: var(--divider-color, rgba(255,255,255,0.08));`;

        // Day label — only shown in multi-day non-compact view
        const dayLabelHtml = (days > 1 && !compact)
          ? `<div class="day-label">${this._dayLabel(windowStart, now)}</div>`
          : "";

        // Hour ticks — hidden in compact mode; shown below the last rendered day row only
        const isLastDay = dayIdx === dayWindows.length - 1;
        const ticksHtml = (isLastDay && !compact)
          ? `<div class="tick-row">${this._renderTicks(windowStart, windowEnd)}</div>`
          : "";

        return `
          <div class="day-row">
            ${dayLabelHtml}
            <div class="bar-outer" style="${barStyle}">
              ${secondarySegsHtml}
              ${primarySegsHtml}
            </div>
            ${ticksHtml}
          </div>`;
      }).join("");

      // --- Entity header row: name (left) + legend swatches (right) ---
      // The header is a single flex row. Left side: one coloured dot + entity name.
      // Right side: legend swatches (primary + optional secondary), no "Inactive" entry.
      // Hidden entirely in compact mode or when both show_names and show_legend are false.
      // Legend sits inside entity-label using margin-left:auto to push it right.
      // No wrapper div — label margin-bottom controls spacing to bar directly.
      const legendInlineHtml = (cfg.show_legend && !compact) ? `
        <div class="entity-legend">
          <div class="legend-item">
            <div class="legend-swatch" style="background:${ent.color};opacity:0.85;"></div>
            ${ent.legend_label}
          </div>
          ${secondaryHistory !== null ? `
          <div class="legend-item">
            <div class="legend-swatch" style="background:${ent.secondary_color};opacity:0.85;"></div>
            ${ent.secondary_legend_label}
          </div>` : ""}
        </div>` : "";

      const headerHtml = cfg.show_names ? `
        <div class="entity-label">
          <div class="entity-dot" style="background:${ent.color};"></div>
          ${ent.name}
          ${legendInlineHtml}
        </div>` : (cfg.show_legend && !compact ? `
        <div class="entity-label">
          ${legendInlineHtml}
        </div>` : "");

      // --- Divider — hidden in compact mode ---
      const dividerHtml = (!isLast && !compact) ? `<hr class="entity-divider">` : "";

      return `
        <div class="entity-block">
          ${headerHtml}
          ${dayRowsHtml}
        </div>
        ${dividerHtml}`;
    }).join("");

    el.innerHTML = `<div class="${compact ? 'compact' : ''}">${blocks}</div>`;
  }


  // ---------------------------------------------------------------------------
  // HELPER METHODS
  // ---------------------------------------------------------------------------

  // Converts raw HA history entries into a flat list of { start, end, state }
  // segments covering the full window, filling gaps from the last known state.
  _buildSegments(history, windowStart, windowEnd) {
    // Find the state that was active at the start of the window
    let initialState = "off";
    for (let i = history.length - 1; i >= 0; i--) {
      const t = new Date(history[i].last_changed);
      if (t <= windowStart) {
        initialState = history[i].state;
        break;
      }
    }

    // Build a list of state changes within the window
    const changes = [{ time: windowStart, state: initialState }];
    for (const entry of history) {
      const t = new Date(entry.last_changed);
      if (t > windowStart && t < windowEnd) {
        changes.push({ time: t, state: entry.state });
      }
    }
    changes.push({ time: windowEnd, state: null }); // Sentinel to close the last segment

    // Convert change list into segments
    const segments = [];
    for (let i = 0; i < changes.length - 1; i++) {
      segments.push({
        start: changes[i].time,
        end:   changes[i + 1].time,
        state: changes[i].state,
      });
    }
    return segments;
  }

  // Returns a human-readable label for a given day
  _dayLabel(dayStart, now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff  = Math.round((today - dayStart) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return dayStart.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  // Renders hour tick labels for a given time window.
  // Works with any start time, not just midnight — so it handles offset windows
  // like 22:00 → 22:00 correctly.
  _renderTicks(windowStart, windowEnd) {
    const totalMs = windowEnd - windowStart;
    const ticks   = [];

    const stepHours = (totalMs / 3600000) > 24 ? 4 : 3;
    let t = new Date(windowStart);
    // Snap to the next clean hour boundary
    t.setMinutes(0, 0, 0);
    if (t < windowStart) t = new Date(t.getTime() + 3600000);

    while (t <= windowEnd) {
      if (t.getHours() % stepHours === 0) {
        const pct   = ((t - windowStart) / totalMs) * 100;
        const label = `${String(t.getHours()).padStart(2, "0")}:00`;

        let left, transform;
        if      (pct < 5)  { left = "0%";                  transform = "none"; }
        else if (pct > 95) { left = "100%";                 transform = "translateX(-100%)"; }
        else               { left = `${pct.toFixed(2)}%`;   transform = "translateX(-50%)"; }

        ticks.push(`<span class="tick" style="left:${left};transform:${transform};">${label}</span>`);
      }
      t = new Date(t.getTime() + 3600000);
    }

    return ticks.join("");
  }

  // ---------------------------------------------------------------------------
  // UI EDITOR — static hooks called by HA's card picker
  // ---------------------------------------------------------------------------

  // Returns a default config so HA can pre-fill the editor when the card is
  // first added via the UI.
  static getStubConfig() {
    return {
      title:      "Timeline",
      days:       1,
      bar_height: 28,
      entities:   [{ entity: "" }],
    };
  }

  // Returns the editor element.  HA renders this inside the card picker panel.
  static getConfigElement() {
    return document.createElement("timeline-bar-card-editor");
  }


}


// =============================================================================
// REGISTRATION
// Guard against double-registration (e.g. on hot-reload)
// =============================================================================
if (!customElements.get("timeline-bar-card")) {
  customElements.define("timeline-bar-card", TimelineBarCard);
  console.log("[timeline-bar-card] v3.2 registered OK");
}

// =============================================================================
// EDITOR CLASS
// Rendered by HA inside the card picker when the user edits the card via UI.
// Fires a "config-changed" CustomEvent whenever any field changes.
// =============================================================================
class TimelineBarCardEditor extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config      = {};
    this._hass        = null;
    this._initialized = false; // DOM built once; subsequent setConfig calls only sync values
  }

  // -------------------------------------------------------------------------
  // HA API
  // -------------------------------------------------------------------------

  // hass is set by HA whenever the object updates.
  // We use it to populate the entity datalist for autocomplete.
  set hass(hass) {
    const first = !this._hass;
    this._hass  = hass;
    if (first && this._initialized) {
      this._populateEntityList();
      this._syncEntityRows(this._config.entities || []);
    }
  }

  // Fills the shared <datalist id="entity-options"> with all entity_ids from hass.
  _populateEntityList() {
    const dl = this.shadowRoot.getElementById("entity-options");
    if (!dl || !this._hass) return;
    dl.innerHTML = "";
    Object.keys(this._hass.states).sort().forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      dl.appendChild(opt);
    });
  }

  // setConfig is called on open and on every external config change (e.g. YAML tab).
  // We build the DOM once, then sync values on subsequent calls so the DOM is stable
  // and ha-entity-picker / ha-switch keep their internal state between updates.
  setConfig(config) {
    this._config = JSON.parse(JSON.stringify(config));
    if (!this._initialized) {
      this._buildDOM();
      this._initialized = true;
    }
    this._syncValues();
  }

  // Fires config-changed so HA picks up the new config and live-previews the card.
  _fire(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail:   { config },
      bubbles:  true,
      composed: true,
    }));
  }

  _int(val, def) {
    const n = parseInt(val, 10);
    return isNaN(n) ? def : n;
  }

  // -------------------------------------------------------------------------
  // DOM BUILD  (runs once)
  // -------------------------------------------------------------------------
  _buildDOM() {
    const root = this.shadowRoot;

    // --- Styles ---
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      :host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); }

      .section-title {
        font-size: 0.78em; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.06em; color: var(--secondary-text-color, #8e8e93);
        margin: 16px 0 6px;
      }
      .section-title:first-child { margin-top: 0; }

      .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .span-2  { grid-column: span 2; }

      .field { display: flex; flex-direction: column; gap: 4px; }
      .field label { font-size: 0.72em; color: var(--secondary-text-color, #8e8e93); }

      input[type="text"], input[type="number"] {
        width: 100%; padding: 6px 8px;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        border-radius: 4px;
        background: var(--card-background-color, #1c1c1e);
        color: var(--primary-text-color, #e5e5ea);
        font-size: 0.88em;
      }
      input:focus { outline: 2px solid var(--primary-color, #03a9f4); }

      .toggles { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
      .toggle-item {
        display: flex; align-items: center; gap: 6px;
        font-size: 0.82em; color: var(--primary-text-color, #e5e5ea); cursor: pointer;
      }

      .entity-list { display: flex; flex-direction: column; gap: 12px; }

      .entity-row {
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        border-radius: 8px; padding: 10px;
      }
      .entity-row-header {
        display: flex; justify-content: space-between;
        align-items: center; margin-bottom: 8px;
      }
      .entity-row-title {
        font-size: 0.78em; font-weight: 600;
        color: var(--secondary-text-color, #8e8e93);
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .remove-btn {
        background: none; border: none; cursor: pointer;
        color: var(--error-color, #f44336);
        font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 4px;
      }
      .remove-btn:hover { opacity: 0.7; }

      .secondary-section {
        margin-top: 8px; padding-top: 8px;
        border-top: 1px dashed var(--divider-color, rgba(255,255,255,0.08));
      }
      .secondary-toggle {
        display:     flex;
        align-items: center;
        gap:         6px;
        font-size:   0.75em;
        color:       var(--primary-color, #03a9f4);
        cursor:      pointer;
        background:  none;
        border:      none;
        padding:     0;
      }
      .secondary-toggle:hover { opacity: 0.8; }
      .secondary-fields { display: none; margin-top: 8px; }
      .secondary-fields.open { display: block; }
      .secondary-title {
        font-size: 0.70em; font-weight: 600;
        color: var(--secondary-text-color, #8e8e93);
        text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;
      }

      .add-btn {
        display: flex; align-items: center; justify-content: center;
        gap: 6px; margin-top: 8px; padding: 7px 12px;
        background: none;
        border: 1px dashed var(--primary-color, #03a9f4);
        border-radius: 6px; color: var(--primary-color, #03a9f4);
        font-size: 0.82em; cursor: pointer; width: 100%;
      }
      .add-btn:hover { background: rgba(3,169,244,0.07); }


    `;
    root.appendChild(style);

    // Shared datalist for entity autocomplete — populated when hass arrives
    const dl = document.createElement("datalist");
    dl.id = "entity-options";
    root.appendChild(dl);

    // --- Card settings section ---
    root.appendChild(this._el("div", { className: "section-title" }, "Card settings"));

    const grid = this._el("div", { className: "grid-2" });
    grid.appendChild(this._field("span-2", "Title",
      this._input("text",   "cfg-title")));
    grid.appendChild(this._field("",       "Days (1–7)",
      this._input("number", "cfg-days",       { min: 1,  max: 7  })));
    grid.appendChild(this._field("",       "Bar height (px)",
      this._input("number", "cfg-bar-height", { min: 4,  max: 80 })));
    grid.appendChild(this._field("",       "Start hour (0–23)",
      this._input("number", "cfg-start-hour", { min: 0,  max: 23 })));
    root.appendChild(grid);

    // --- Toggles section ---
    // Row 1: show_title, show_names, compact (always enabled)
    // Row 2: show_legend, reverse_days — greyed out and disabled when compact is on
    root.appendChild(this._el("div", { className: "section-title" }, "Display options"));

    const toggleWrap = this._el("div", { className: "toggles" });
    for (const [id, label] of [
      ["tog-show-title", "Show title"],
      ["tog-show-names", "Show names"],
      ["tog-compact",    "Compact"],
    ]) {
      const sw = document.createElement("ha-switch");
      sw.id    = id;
      const lbl = this._el("label", { className: "toggle-item" });
      lbl.appendChild(sw);
      lbl.appendChild(document.createTextNode(" " + label));
      toggleWrap.appendChild(lbl);
    }
    root.appendChild(toggleWrap);

    // Row 2 — dependent toggles (disabled + greyed when compact)
    const toggleWrap2 = this._el("div", { className: "toggles", id: "toggles-compact-dep" });
    toggleWrap2.style.marginTop = "8px";
    for (const [id, label] of [
      ["tog-show-legend", "Show legend"],
      ["tog-reverse",     "Reverse days"],
    ]) {
      const sw = document.createElement("ha-switch");
      sw.id    = id;
      const lbl = this._el("label", { className: "toggle-item" });
      lbl.appendChild(sw);
      lbl.appendChild(document.createTextNode(" " + label));
      toggleWrap2.appendChild(lbl);
    }
    root.appendChild(toggleWrap2);

    // --- Entity list section ---
    root.appendChild(this._el("div", { className: "section-title" }, "Entities"));
    root.appendChild(this._el("div", { id: "entity-list", className: "entity-list" }));

    const addBtn  = this._el("button", { className: "add-btn", id: "add-entity" }, "＋ Add entity");
    root.appendChild(addBtn);

    // --- Wire card-level listeners (done once, stable IDs) ---
    this._wireCfgListeners();
  }

  // -------------------------------------------------------------------------
  // VALUE SYNC  (runs on every setConfig call)
  // Pushes current config values into existing DOM elements without rebuilding.
  // -------------------------------------------------------------------------
  _syncValues() {
    const c    = this._config;
    const root = this.shadowRoot;

    // Card-level inputs
    this._setInputVal("cfg-title",      c.title      ?? "Timeline");
    this._setInputVal("cfg-days",       c.days        ?? 1);
    this._setInputVal("cfg-bar-height", c.bar_height  ?? 28);
    this._setInputVal("cfg-start-hour", c.start_hour  ?? 0);

    // Toggles — set .checked as a JS property, NOT an attribute
    this._setSwitch("tog-show-title",  c.show_title  !== false);
    this._setSwitch("tog-show-names",  c.show_names  !== false);
    this._setSwitch("tog-show-legend", c.show_legend !== false);
    this._setSwitch("tog-compact",     c.compact     === true);
    this._setSwitch("tog-reverse",     c.reverse_days === true);

    // Grey out / disable the compact-dependent row when compact is on
    const depRow = this.shadowRoot.getElementById("toggles-compact-dep");
    if (depRow) {
      const isCompact = c.compact === true;
      depRow.style.opacity        = isCompact ? "0.4" : "1";
      depRow.style.pointerEvents  = isCompact ? "none" : "";
    }

    // Reconcile entity rows
    this._syncEntityRows(c.entities || []);
  }

  _setInputVal(id, val) {
    const el = this.shadowRoot.getElementById(id);
    if (el && document.activeElement !== el) el.value = val;
  }

  _setSwitch(id, checked) {
    const el = this.shadowRoot.getElementById(id);
    if (el) el.checked = checked;
  }

  // -------------------------------------------------------------------------
  // ENTITY ROW RECONCILIATION
  // Add / remove rows to match the entity array length, then push values.
  // This avoids destroying pickers that are mid-interaction.
  // -------------------------------------------------------------------------
  _syncEntityRows(entities) {
    const list     = this.shadowRoot.getElementById("entity-list");
    const existing = Array.from(list.querySelectorAll(".entity-row"));

    // Add missing rows
    while (list.children.length < entities.length) {
      const idx = list.children.length;
      list.appendChild(this._buildEntityRow(idx));
    }
    // Remove extra rows (from the end)
    while (list.children.length > entities.length) {
      list.removeChild(list.lastChild);
    }

    // Sync values into each row
    entities.forEach((ent, i) => {
      const row = list.children[i];
      if (!row) return;
      // Update title
      const title = row.querySelector(".entity-row-title");
      if (title) title.textContent = `Entity ${i + 1}`;

      this._setRowInput(row, "entity",                 ent.entity                || "");
      this._setRowInput(row, "name",                   ent.name                  || "");
      this._setRowInput(row, "color",                  ent.color                 || "");
      this._setRowInput(row, "legend_label",           ent.legend_label          || "");
      this._setRowInput(row, "secondary_entity",       ent.secondary_entity      || "");
      this._setRowInput(row, "secondary_color",        ent.secondary_color       || "");
      this._setRowInput(row, "secondary_legend_label", ent.secondary_legend_label|| "");

      // Expand or collapse the secondary section based on whether a value exists
      const secFields = row.querySelector(".secondary-fields");
      const secToggle = row.querySelector(".secondary-toggle");
      if (secFields && secToggle) {
        const hasSecondary = !!(ent.secondary_entity);
        secFields.classList.toggle("open", hasSecondary);
        secToggle.style.display = hasSecondary ? "none" : "";
      }
    });
  }

  // Set a value on any input inside a row (all are now plain <input> elements).
  _setRowInput(row, field, value) {
    const el = row.querySelector(`[data-field="${field}"]`);
    if (el && document.activeElement !== el) el.value = value || "";
  }

  // -------------------------------------------------------------------------
  // BUILD ONE ENTITY ROW  (creates DOM elements imperatively)
  // -------------------------------------------------------------------------
  _buildEntityRow(i) {
    const row = this._el("div", { className: "entity-row" });

    // Header
    const header = this._el("div", { className: "entity-row-header" });
    header.appendChild(this._el("span", { className: "entity-row-title" }, `Entity ${i + 1}`));
    const removeBtn = this._el("button", { className: "remove-btn", title: "Remove" }, "✕");
    removeBtn.addEventListener("click", () => {
      const entities = (this._config.entities || []).filter((_, j) => j !== i);
      this._fire({ ...this._config, entities });
    });
    header.appendChild(removeBtn);
    row.appendChild(header);

    // Primary fields grid
    const grid = this._el("div", { className: "grid-2" });

    // Entity input with datalist autocomplete
    const picker = document.createElement("input");
    picker.type        = "text";
    picker.setAttribute("data-field", "entity");
    picker.setAttribute("list", "entity-options");
    picker.placeholder = "e.g. binary_sensor.my_sensor";
    picker.addEventListener("change", e => {
      this._updateEntity(i, "entity", e.target.value || "");
    });
    grid.appendChild(this._field("span-2", "Entity ID", picker));

    // Text inputs
    grid.appendChild(this._field("", "Name (bar title)",
      this._rowInput("name", i)));
    grid.appendChild(this._field("", "Color",
      this._rowInput("color", i, "e.g. #e07b39")));
    grid.appendChild(this._field("span-2", "Legend label",
      this._rowInput("legend_label", i, "Active")));
    row.appendChild(grid);

    // Secondary section — collapsed by default, expands when secondary entity is set
    const sec = this._el("div", { className: "secondary-section" });

    // Toggle button (shown when no secondary entity set)
    const secToggle = this._el("button", { className: "secondary-toggle" }, "＋ Add secondary entity");
    secToggle.addEventListener("click", () => {
      secFields.classList.add("open");
      secToggle.style.display = "none";
    });
    sec.appendChild(secToggle);

    // Expanded fields (hidden until toggled or a value exists)
    const secFields = this._el("div", { className: "secondary-fields" });
    secFields.appendChild(this._el("div", { className: "secondary-title" }, "Secondary entity"));

    // Remove secondary button
    const removeSec = this._el("button", { className: "secondary-toggle" }, "✕ Remove secondary entity");
    removeSec.style.marginBottom = "6px";
    removeSec.addEventListener("click", () => {
      secFields.classList.remove("open");
      secToggle.style.display = "";
      // Clear all secondary values
      ["secondary_entity","secondary_color","secondary_legend_label"].forEach(f => {
        this._updateEntity(i, f, "");
        const el = row.querySelector(`[data-field="${f}"]`);
        if (el) el.value = "";
      });
    });
    secFields.appendChild(removeSec);

    const secGrid = this._el("div", { className: "grid-2" });

    const secPicker = document.createElement("input");
    secPicker.type        = "text";
    secPicker.setAttribute("data-field", "secondary_entity");
    secPicker.setAttribute("list", "entity-options");
    secPicker.placeholder = "e.g. binary_sensor.my_sensor";
    secPicker.addEventListener("change", e => {
      this._updateEntity(i, "secondary_entity", e.target.value || "");
    });
    secGrid.appendChild(this._field("span-2", "Secondary entity ID", secPicker));

    secGrid.appendChild(this._field("", "Secondary legend label",
      this._rowInput("secondary_legend_label", i, "Secondary")));
    secGrid.appendChild(this._field("", "Secondary color",
      this._rowInput("secondary_color", i, "e.g. #f5c842")));

    secFields.appendChild(secGrid);
    sec.appendChild(secFields);
    row.appendChild(sec);

    return row;
  }

  // -------------------------------------------------------------------------
  // CARD-LEVEL LISTENERS  (wired once after _buildDOM)
  // -------------------------------------------------------------------------
  _wireCfgListeners() {
    const root = this.shadowRoot;

    // Text / number inputs
    const cardInputs = {
      "cfg-title":      (v) => ({ title:       v }),
      "cfg-days":       (v) => ({ days:         this._int(v, 1) }),
      "cfg-bar-height": (v) => ({ bar_height:   this._int(v, 28) }),
      "cfg-start-hour": (v) => ({ start_hour:   this._int(v, 0) }),
    };
    for (const [id, updater] of Object.entries(cardInputs)) {
      root.getElementById(id)?.addEventListener("change", e => {
        this._fire({ ...this._config, ...updater(e.target.value) });
      });
    }

    // Toggles — ha-switch fires "change" with e.target.checked
    const toggleMap = {
      "tog-show-title":  "show_title",
      "tog-show-names":  "show_names",
      "tog-show-legend": "show_legend",
      "tog-compact":     "compact",
      "tog-reverse":     "reverse_days",
    };
    for (const [id, field] of Object.entries(toggleMap)) {
      root.getElementById(id)?.addEventListener("change", e => {
        this._fire({ ...this._config, [field]: e.target.checked });
      });
    }

    // Add entity button
    root.getElementById("add-entity")?.addEventListener("click", () => {
      const entities = [...(this._config.entities || []), { entity: "" }];
      this._fire({ ...this._config, entities });
    });
  }

  // -------------------------------------------------------------------------
  // ENTITY UPDATE HELPER
  // -------------------------------------------------------------------------
  _updateEntity(idx, field, value) {
    const entities = JSON.parse(JSON.stringify(this._config.entities || []));
    if (!entities[idx]) return;
    const optional = ["secondary_entity", "secondary_color", "secondary_legend_label",
                      "legend_label", "color", "name"];
    entities[idx][field] = (optional.includes(field) && value === "") ? null : value;
    this._fire({ ...this._config, entities });
  }

  // -------------------------------------------------------------------------
  // SMALL DOM HELPERS
  // -------------------------------------------------------------------------

  // Creates a labelled field wrapper div; appends inputEl inside it.
  _field(spanClass, labelText, inputEl) {
    const wrap  = this._el("div", { className: "field" + (spanClass ? " " + spanClass : "") });
    const label = this._el("label", {}, labelText);
    wrap.appendChild(label);
    wrap.appendChild(inputEl);
    return wrap;
  }

  // Creates a text/number input (card-level, identified by id).
  _input(type, id, attrs = {}) {
    const el  = document.createElement("input");
    el.type   = type;
    el.id     = id;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // Creates a text input for an entity row field (identified by data-field).
  _rowInput(field, idx, placeholder = "") {
    const el = document.createElement("input");
    el.type  = "text";
    el.setAttribute("data-field", field);
    el.placeholder = placeholder;
    el.addEventListener("change", e => {
      this._updateEntity(idx, field, e.target.value);
    });
    return el;
  }

  // Creates a generic element with optional properties and text content.
  _el(tag, props = {}, text = "") {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) el[k] = v;
    if (text) el.textContent = text;
    return el;
  }
}

// Register editor
if (!customElements.get("timeline-bar-card-editor")) {
  customElements.define("timeline-bar-card-editor", TimelineBarCardEditor);
  console.log("[timeline-bar-card-editor] registered OK");
}


window.customCards = window.customCards || [];
if (!window.customCards.find(c => c.type === "timeline-bar-card")) {
  window.customCards.push({
    type:        "timeline-bar-card",
    name:        "Timeline Bar Card",
    preview:     false,
    description: "Multi-entity 24h timeline showing binary sensor states as coloured bars.",
  });
}