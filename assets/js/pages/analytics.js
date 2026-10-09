// Analytics: the selected season replayed round by round. The timeline picks a
// point in the season and everything below it (insights, charts, heatmap,
// head-to-head) is computed from standings(..., { throughRound }) at that point.

import { standings, headToHead, completedRounds } from "../league.js";
import { initPage, esc, link, driverId } from "../ui.js";

const TOP_N = 8;
const PLAY_MS = 2000;
const FONT = '"Titillium Web", "Segoe UI", system-ui, sans-serif';
const INK = "#15151e";
const INK_2 = "#4f4f5a";
const INK_3 = "#6b6b76";
const GRID = "#ebe9e4";
const AXIS = "#c9c6bf";
const PHONE = window.matchMedia("(max-width: 640px)");
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

// Fixed accessible categorical palette, used when a team colour is already taken.
const FALLBACK_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const POINT_STYLES = ["circle", "rect", "triangle", "rectRot", "star", "crossRot", "cross", "rectRounded"];
const STROKE_ONLY = new Set(["star", "crossRot", "cross"]);
// Many team colours are near-white (Mercedes, Williams, Kick Sauber) and vanish
// as 2px lines on a white card, so series colours are capped at this OKLCH lightness.
const MAX_SERIES_L = 0.68;
// Two colours closer than this (OKLab ΔE ×100) count as the same colour.
const SAME_COLOR_DE = 10;
const HEAT_HUE = (29.5 * Math.PI) / 180; // hue of F1 red, for the heatmap ramp

// Ordinal one-hue ramp, darkest = best result.
const FINISH_BANDS = [
  { label: "Wins", color: "#790000", test: (p) => p === 1 },
  { label: "P2", color: "#a50000", test: (p) => p === 2 },
  { label: "P3", color: "#d41007", test: (p) => p === 3 },
  { label: "P4–P10", color: "#e45e4e", test: (p) => p >= 4 && p <= 10 },
  { label: "P11+", color: "#f09081", test: (p) => p >= 11 },
];

const LINE_CHARTS = {
  points: renderPoints,
  gap: renderGap,
  position: renderPosition,
  form: renderForm,
};

const ICON = {
  play: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" fill="currentColor"/></svg>',
  reset: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4"/><path d="M2.5 2v3.5H6"/></svg>',
};

const state = {
  league: null,
  season: null,
  rounds: [], // completed rounds, in order
  tables: [], // tables[i] = standings through the (i + 1)th completed round
  ranks: [], // ranks[i] = Map(driverId -> championship rank) after that round
  fastest: [], // fastest[i] = driver ids with the fastest lap in that round
  drivers: [], // final standings rows: fixed series order for the whole season
  info: new Map(),
  series: new Map(), // driverId -> { color, pointStyle, order }
  maxPosition: 20,
  through: 0,
  charts: new Map(),
  hidden: new Map(), // chart key -> Set of driver ids toggled off in its legend
  positionMode: "championship",
  heatSort: "points",
  podiumTop: "10",
  h2h: { a: null, b: null, user: false },
  timer: null,
  frame: 0,
};

async function render({ league, season }) {
  const main = document.getElementById("main");
  if (!season) {
    main.innerHTML = `<div class="container"><div class="card empty-state"><h3>No seasons yet</h3><p>Add a season to data/league.json.</p></div></div>`;
    return;
  }
  document.title = `${season.label} Analytics — Slayter League`;

  const rounds = completedRounds(season);
  if (!rounds.length) {
    main.innerHTML = pageHead(season, false) + emptyState(league, season);
    return;
  }

  state.league = league;
  state.season = season;
  state.rounds = rounds;
  state.through = rounds.length;
  state.tables = rounds.map((round) => standings(league, season, { throughRound: round.round }));
  state.ranks = state.tables.map((table) => new Map(table.rows.map((row) => [row.id, row.rank])));
  state.fastest = rounds.map((round) =>
    round.results.filter((res) => res.fastestLap).map((res) => league.resolveDriver(res.driver)).filter(Boolean),
  );
  state.drivers = state.tables[rounds.length - 1].rows;
  state.info = new Map(state.drivers.map((row) => [row.id, row]));
  state.series = assignSeries(state.drivers);
  state.maxPosition = Math.max(20, ...state.drivers.flatMap((row) => row.positions.filter((p) => p !== null)));

  main.innerHTML = [pageHead(season, true), timelineSection(), insightsSection(), chartsSection()].join("");
  wireTimeline();
  wireControls();
  wireHeatmap();
  watchStickyOffsets();

  await fontsReady();
  setupChartDefaults();
  update();

  PHONE.addEventListener("change", () => {
    renderHeatmap(currentTable());
    renderCharts(currentTable());
  });
  if (window.location.hash === "#insights") document.getElementById("insights").scrollIntoView();
}

// ---------- Page sections ----------

function pageHead(season, hasData) {
  return `<section class="page-head">
    <div class="container page-head__inner">
      <div>
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}${season.status === "complete" ? " · Final" : ""}</p>
        <h1 class="title">${esc(season.label)} <em>Analytics</em></h1>
        <p class="lede">${hasData
          ? "Replay the championship round by round. Every insight and chart below follows the timeline."
          : "Charts, form and head-to-heads appear here once the first race results are in."}</p>
      </div>
    </div>
  </section>`;
}

function emptyState(league, season) {
  const other = league.seasons.find((s) => s.id !== season.id && completedRounds(s).length);
  return `<div class="container">
    <section class="card f1-corner f1-corner--red an-empty" aria-labelledby="emptyTitle">
      <svg class="an-empty__art" viewBox="0 0 320 120" aria-hidden="true" focusable="false">
        <g stroke="#e3e1dc" stroke-width="1"><path d="M0 20H320M0 50H320M0 80H320M0 110H320"/></g>
        <polyline points="0,108 46,96 92,90 138,70 184,64 230,46 276,38 320,22" fill="none" stroke="#e10600" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="0,110 46,100 92,98 138,86 184,76 230,72 276,60 320,52" fill="none" stroke="#15151e" stroke-opacity=".35" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="0,112 46,106 92,104 138,100 184,96 230,90 276,88 320,80" fill="none" stroke="#c9c6bf" stroke-width="2" stroke-dasharray="6 5" stroke-linecap="round"/>
      </svg>
      <h2 class="an-empty__title" id="emptyTitle">No race data yet</h2>
      <p class="an-empty__text">Points progression, championship positions, form and head-to-heads unlock after ${esc(season.label)}'s first race results are in.${other ? ` ${esc(other.label)} is ready to explore now.` : ""}</p>
      <div class="btn-row">
        ${other ? `<a class="btn" href="${link("analytics/", { season: other.id })}">Explore ${esc(other.label)} analytics</a>` : ""}
        <a class="btn btn--ghost" href="${link("schedule/")}">${esc(season.label)} schedule</a>
      </div>
    </section>
  </div>`;
}

function timelineSection() {
  const n = state.rounds.length;
  const single = n < 2;
  const every = Math.ceil(n / 12);
  const ticks = state.rounds
    .map((round, i) => {
      const at = single ? 0 : i / (n - 1);
      const label = i % every === 0 || i === n - 1 ? `R${esc(round.round)}` : "";
      return `<span class="timeline__tick" data-index="${i + 1}" style="--at:${at}">${label}</span>`;
    })
    .join("");
  return `<div class="timeline-wrap" id="timelineWrap">
    <div class="container">
      <section class="timeline" aria-label="Season timeline">
        <div class="timeline__buttons">
          <button class="tl-btn tl-btn--play" id="tlPlay" type="button"${single ? " disabled" : ""}>${ICON.play}<span>Play</span></button>
          <button class="tl-btn" id="tlReset" type="button"${single ? " disabled" : ""}>${ICON.reset}<span>Reset</span></button>
        </div>
        <div class="timeline__main">
          <p class="timeline__readout"><span class="timeline__label">Through</span> <strong id="tlValue">All races</strong></p>
          <div class="timeline__slider">
            <input class="timeline__range" id="tlSlider" type="range" min="1" max="${n}" step="1" value="${n}" aria-label="Show the season through round"${single ? " disabled" : ""} />
            <div class="timeline__ticks" aria-hidden="true">${ticks}</div>
          </div>
        </div>
        <p class="sr-only" id="tlStatus" aria-live="polite"></p>
      </section>
    </div>
  </div>`;
}

function insightsSection() {
  return `<section class="section container" id="insights" aria-labelledby="insightsTitle">
    <div class="section-head">
      <div>
        <p class="kicker" id="insightsKicker"></p>
        <h2 class="section-title" id="insightsTitle">Championship insights</h2>
      </div>
    </div>
    <div class="insight-cards" id="insightCards"></div>
    <div class="insight-panels">
      <article class="card insight-panel" aria-labelledby="pulseTitle">
        <header class="insight-panel__head">
          <h3 class="insight-panel__title" id="pulseTitle">Performance pulse</h3>
          <p class="insight-panel__sub">The top five on points</p>
        </header>
        <ol class="pulse" id="pulseList"></ol>
      </article>
      <article class="card insight-panel" aria-labelledby="spotTitle">
        <header class="insight-panel__head">
          <h3 class="insight-panel__title" id="spotTitle">Podium spotlight</h3>
          <p class="insight-panel__sub">Podiums, and the share of starts that ended on one</p>
        </header>
        <ul class="podium-spot" id="podiumSpot"></ul>
      </article>
    </div>
  </section>`;
}

function chartsSection() {
  const positionControls = `<div class="tabs tabs--compact" role="group" aria-label="Plot">
      <button type="button" data-position-mode="championship" aria-pressed="true">Championship</button>
      <button type="button" data-position-mode="race" aria-pressed="false">Race finishes</button>
    </div>`;
  const podiumControls = `<label class="field">Show
      <select class="select select--compact" id="podiumTop">
        <option value="5">Top 5</option>
        <option value="10" selected>Top 10</option>
        <option value="all">All drivers</option>
      </select>
    </label>`;
  const h2hControls = `<label class="field">Driver A<select class="select select--compact" id="h2hA"></select></label>
    <span class="h2h-vs" aria-hidden="true">vs</span>
    <label class="field">Driver B<select class="select select--compact" id="h2hB"></select></label>`;

  return `<section class="section container" aria-labelledby="chartsTitle">
    <div class="section-head">
      <div>
        <p class="kicker" id="chartsKicker"></p>
        <h2 class="section-title" id="chartsTitle">Race by race</h2>
      </div>
    </div>
    <div class="chart-grid">
      ${chartCard({ key: "points", title: "Points progression", sub: "Cumulative championship points after each round · top 8" })}
      ${chartCard({ key: "gap", title: "Gap to leader", sub: "Points behind the championship leader after each round · top 8" })}
      ${chartCard({ key: "position", title: "Championship position", sub: "", controls: positionControls })}
      ${chartCard({ key: "form", title: "Form guide", sub: "Average finish over the last three races (races not started are skipped) · top 8" })}
      ${heatmapCard()}
      ${chartCard({ key: "podium", title: "Podium distribution", sub: "How every start finished, by result band", controls: podiumControls })}
      ${chartCard({ key: "fastest", title: "Fastest laps", sub: "Fastest laps set, and the average finish in those races", after: '<p class="chart-empty" id="fastestEmpty" hidden></p><div class="fl-cards" id="fastestCards"></div>' })}
      ${chartCard({ key: "h2h", title: "Head-to-head", sub: "Race finishes compared round by round", controls: h2hControls, wide: true, after: '<div class="h2h-summary" id="h2hSummary"></div>' })}
    </div>
  </section>`;
}

function chartCard({ key, title, sub, controls = "", wide = false, after = "" }) {
  return `<article class="card f1-corner chart-card${wide ? " chart-card--wide" : ""}" id="${key}Card" aria-labelledby="${key}Title">
    <header class="chart-card__head">
      <div class="chart-card__heading">
        <h3 class="chart-card__title" id="${key}Title">${title}</h3>
        <p class="chart-card__sub" id="${key}Sub">${sub}</p>
      </div>
      ${controls ? `<div class="chart-card__controls">${controls}</div>` : ""}
    </header>
    <div class="chart-box" id="${key}Box"><canvas id="${key}Chart" role="img" aria-label="${title}"></canvas></div>
    <div class="chart-legend" id="${key}Legend"></div>
    ${after}
    <details class="chart-data">
      <summary>Data table</summary>
      <div class="table-wrap" id="${key}Table"></div>
    </details>
  </article>`;
}

function heatmapCard() {
  return `<article class="card f1-corner chart-card chart-card--wide" id="heatCard" aria-labelledby="heatTitle">
    <header class="chart-card__head">
      <div class="chart-card__heading">
        <h3 class="chart-card__title" id="heatTitle">Position heatmap</h3>
        <p class="chart-card__sub">Finishing position in every round. Deeper red means a better finish.</p>
      </div>
      <div class="chart-card__controls">
        <label class="field">Sort by
          <select class="select select--compact" id="heatSort">
            <option value="points">Total points</option>
            <option value="avg">Avg finish</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
    </header>
    <div class="heatmap" id="heatmap"></div>
    <div class="heat-key" aria-hidden="true">
      <span class="heat-key__scale"><span>P1</span><span class="heat-key__bar" style="background:linear-gradient(90deg, ${heatColor(1)}, ${heatColor(0.5)}, ${heatColor(0)})"></span><span>P${state.maxPosition}</span></span>
      <span><span class="heat-key__dns">DNS</span> Did not start</span>
      <span><span class="heat-key__fl"></span> Fastest lap</span>
    </div>
    <p class="note">Hover or focus a cell for details. Use the arrow keys to move between cells.</p>
    <div class="heat-tip" id="heatTip" hidden></div>
  </article>`;
}

// ---------- Timeline ----------

function wireTimeline() {
  const slider = document.getElementById("tlSlider");
  slider.addEventListener("input", () => {
    pause();
    setThrough(Number(slider.value));
  });
  document.getElementById("tlPlay").addEventListener("click", () => (state.timer ? pause() : play()));
  document.getElementById("tlReset").addEventListener("click", () => {
    pause();
    setThrough(state.rounds.length);
    announce(`Reset to ${throughLabel()}`);
  });
}

function play() {
  const last = state.rounds.length;
  if (state.through >= last) setThrough(1);
  setPlayButton(true);
  announce(throughLabel());
  state.timer = window.setInterval(() => {
    setThrough(Math.min(state.through + 1, last));
    announce(throughLabel());
    if (state.through >= last) pause();
  }, PLAY_MS);
}

function pause() {
  if (!state.timer) return;
  window.clearInterval(state.timer);
  state.timer = null;
  setPlayButton(false);
}

function setPlayButton(playing) {
  const button = document.getElementById("tlPlay");
  button.innerHTML = playing ? `${ICON.pause}<span>Pause</span>` : `${ICON.play}<span>Play</span>`;
}

function announce(text) {
  const status = document.getElementById("tlStatus");
  if (status) status.textContent = text;
}

// Coalesces rapid slider input into one render per frame.
function setThrough(value) {
  state.through = Math.max(1, Math.min(value, state.rounds.length));
  document.getElementById("tlSlider").value = String(state.through);
  cancelAnimationFrame(state.frame);
  state.frame = requestAnimationFrame(update);
}

function renderTimeline() {
  const slider = document.getElementById("tlSlider");
  const n = state.rounds.length;
  const label = throughLabel();
  document.getElementById("tlValue").textContent = label;
  slider.setAttribute("aria-valuetext", label);
  slider.style.setProperty("--p", n > 1 ? (state.through - 1) / (n - 1) : 1);
  document.querySelectorAll(".timeline__tick").forEach((tick) => {
    const index = Number(tick.dataset.index);
    tick.classList.toggle("is-past", index <= state.through);
    tick.classList.toggle("is-current", index === state.through);
  });
}

function throughLabel() {
  if (state.through >= state.rounds.length) return "All races";
  const round = state.rounds[state.through - 1];
  return `Round ${round.round} · ${round.name}`;
}

// "through round 3 (Bahrain)" / "across all 8 rounds", for sentences.
function throughPhrase() {
  const n = state.rounds.length;
  if (state.through >= n) return n === 1 ? "after round 1" : `across all ${n} rounds`;
  const round = state.rounds[state.through - 1];
  return `through round ${round.round} (${round.name})`;
}

function throughKicker() {
  const n = state.rounds.length;
  const round = state.rounds[state.through - 1];
  if (state.through >= n) {
    return state.season.status === "complete" ? `Final · all ${n} rounds` : `After round ${round.round} · latest`;
  }
  return `Through round ${round.round} · ${round.name}`;
}

// The toolbar sticks under the site header on larger screens; anchors need to
// clear both.
function watchStickyOffsets() {
  const header = document.getElementById("site-header");
  const wrap = document.getElementById("timelineWrap");
  const root = document.documentElement;
  const sync = () => {
    root.style.setProperty("--an-header", `${header ? header.offsetHeight : 0}px`);
    root.style.setProperty("--an-timeline", `${wrap.offsetHeight}px`);
  };
  sync();
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(sync);
    if (header) observer.observe(header);
    observer.observe(wrap);
  }
}

// ---------- Render all ----------

function currentTable() {
  return state.tables[state.through - 1];
}

function update() {
  const table = currentTable();
  renderTimeline();
  document.getElementById("insightsKicker").textContent = throughKicker();
  document.getElementById("chartsKicker").textContent = throughKicker();
  renderInsights(table);
  renderHeatmap(table);
  renderCharts(table);
}

// Without Chart.js (CDN blocked/offline) the data tables and summaries still render.
function renderCharts(table) {
  if (!window.Chart) chartsUnavailable();
  for (const render of Object.values(LINE_CHARTS)) render(table);
  renderPodium(table);
  renderFastest(table);
  renderH2H(table);
}

function chartsUnavailable() {
  document.querySelectorAll(".chart-box").forEach((box) => {
    if (box.querySelector(".chart-offline")) return;
    box.classList.add("chart-box--offline");
    box.innerHTML = '<p class="chart-offline">The chart library could not load. The data is in the table below.</p>';
  });
}

// ---------- Insights ----------

function renderInsights(table) {
  const rows = table.rows;
  const cards = document.getElementById("insightCards");
  // Same order as the standings page (points, then countback).
  const leader = rows[0];
  const mostWins = rows.slice().sort((a, b) => b.wins - a.wins || b.points - a.points || best(a) - best(b))[0];
  const watch = pickWatch(rows, leader);
  const runnerUp = rows.find((row) => row.id !== leader.id);

  let leaderMeta = `${leader.wins} ${plural(leader.wins, "win")} · avg finish P${fmt1(leader.avgFinish)}`;
  if (runnerUp) {
    const margin = leader.points - runnerUp.points;
    leaderMeta = margin > 0
      ? `+${margin} pts over ${esc(runnerUp.name)}`
      : `Level with ${esc(runnerUp.name)} · ahead on countback`;
  }

  const span = Math.min(3, state.through);
  const raceWord = span === 1 ? "race" : `${span} races`;
  const watchMeta = watch
    ? watch.gain > 0
      ? `+${watch.gain} pts in last ${raceWord} · Best finish P${watch.row.bestFinish}`
      : `Avg finish P${fmt1(watch.row.avgFinish)} · Best finish P${watch.row.bestFinish}`
    : "Needs a second driver on the grid";

  cards.innerHTML = [
    insightCard({ label: "Championship leader", row: leader, value: leader.points, unit: "pts", meta: leaderMeta, accent: true }),
    insightCard({
      label: "Most wins",
      row: mostWins.wins ? mostWins : null,
      value: mostWins.wins,
      unit: plural(mostWins.wins, "win"),
      meta: mostWins.wins ? `${mostWins.podiums} ${plural(mostWins.podiums, "podium")} · ${mostWins.points} pts` : "No league driver has won yet",
    }),
    insightCard({
      label: "Driver to watch",
      row: watch ? watch.row : null,
      value: watch ? `+${watch.gain}` : "—",
      unit: watch ? "pts" : "",
      meta: watchMeta,
    }),
  ].join("");

  renderPulse(rows);
  renderPodiumSpotlight(rows);
}

// Biggest points haul over the last (up to) three rounds, leader excluded.
function pickWatch(rows, leader) {
  const last = state.through - 1;
  const from = last - Math.min(3, state.through);
  return rows
    .filter((row) => row.id !== leader.id)
    .map((row) => ({ row, gain: row.cumulative[last] - (from >= 0 ? row.cumulative[from] : 0) }))
    .sort((a, b) => b.gain - a.gain || best(a.row) - best(b.row) || a.row.rank - b.row.rank)[0] || null;
}

function insightCard({ label, row, value, unit, meta, accent = false }) {
  return `<article class="card f1-corner insight${accent ? " f1-corner--red" : ""}">
    <p class="insight__label">${label}</p>
    <div class="insight__driver">${row ? driverTag(row) : '<span class="muted">—</span>'}</div>
    <p class="insight__value">${esc(value)}${unit ? `<span>${unit}</span>` : ""}</p>
    <p class="insight__meta">${meta}</p>
  </article>`;
}

function renderPulse(rows) {
  const top = rows.slice(0, 5);
  const max = Math.max(1, ...top.map((row) => row.points));
  document.getElementById("pulseList").innerHTML = top
    .map((row) => `<li class="pulse__item">
      <div class="pulse__top">
        <span class="pulse__rank">${row.rank}</span>
        ${driverTag(row)}
        <strong class="pulse__pts">${row.points}<span>pts</span></strong>
      </div>
      <div class="pulse__bar" aria-hidden="true"><span style="width:${Math.max(2, (row.points / max) * 100).toFixed(1)}%;background:${seriesColor(row.id)}"></span></div>
      <p class="pulse__meta">${row.wins} ${plural(row.wins, "win")} · ${row.podiums} ${plural(row.podiums, "podium")} · ${row.fastestLaps} FL</p>
    </li>`)
    .join("");
}

function renderPodiumSpotlight(rows) {
  const list = rows
    .filter((row) => row.podiums > 0)
    .sort((a, b) => b.podiums - a.podiums || b.podiums / b.starts - a.podiums / a.starts || a.rank - b.rank)
    .slice(0, 6);
  const el = document.getElementById("podiumSpot");
  if (!list.length) {
    el.innerHTML = `<li class="podium-spot__empty muted">No podiums for league drivers ${esc(throughPhrase())}.</li>`;
    return;
  }
  el.innerHTML = list
    .map((row) => {
      const rate = Math.round((row.podiums / row.starts) * 100);
      return `<li class="podium-spot__item">
        <span class="podium-spot__count">${row.podiums}</span>
        <div class="podium-spot__body">
          ${driverTag(row)}
          <div class="podium-spot__meter" aria-hidden="true"><span style="width:${rate}%"></span></div>
          <p class="podium-spot__meta"><strong>${rate}%</strong> podium rate · ${row.podiums} of ${row.starts} ${plural(row.starts, "start")}</p>
        </div>
      </li>`;
    })
    .join("");
}

// Driver name + series colour bar, linked to the driver page.
function driverTag(row) {
  return driverId({ ...row, teamColor: seriesColor(row.id) });
}

// ---------- Heatmap ----------

function renderHeatmap(table) {
  hideTip();
  const rounds = state.rounds.slice(0, state.through);
  const rows = table.rows.slice();
  if (state.heatSort === "avg") rows.sort((a, b) => avg(a) - avg(b) || a.rank - b.rank);
  else if (state.heatSort === "name") rows.sort((a, b) => a.name.localeCompare(b.name));

  let first = true;
  const cell = (row, position, index) => {
    const round = rounds[index];
    const tab = first ? 0 : -1;
    first = false;
    if (position === null) {
      return `<td class="heat__cell heat__cell--dns" tabindex="${tab}" data-tip="${esc(`${row.name} did not start at ${round.name}`)}">DNS</td>`;
    }
    const fl = state.fastest[index].includes(row.id);
    const t = 1 - (position - 1) / (state.maxPosition - 1);
    const bg = heatColor(t);
    const fg = contrast(bg, "#ffffff") >= 4.5 ? "#ffffff" : INK;
    const tip = `${row.name} finished P${position} at ${round.name}${fl ? " · fastest lap" : ""}`;
    return `<td class="heat__cell${fl ? " heat__cell--fl" : ""}" tabindex="${tab}" style="--bg:${bg};--fg:${fg}" data-tip="${esc(tip)}">P${position}</td>`;
  };

  document.getElementById("heatmap").innerHTML = `<div class="heatmap__scroll">
    <table class="heat">
      <caption class="sr-only">Finishing position by driver and round, ${esc(throughPhrase())}. DNS means did not start.</caption>
      <thead><tr><th scope="col" class="heat__corner">Driver</th>${rounds
        .map((round) => `<th scope="col"><span title="${esc(round.name)}">R${esc(round.round)}</span></th>`)
        .join("")}</tr></thead>
      <tbody>${rows
        .map((row) => `<tr>
          <th scope="row" class="heat__driver"><span class="team-bar" style="--team:${seriesColor(row.id)}"></span><a href="${link("drivers/", { id: row.id })}"><span class="heat__name">${esc(row.name)}</span><span class="heat__code" aria-hidden="true">${esc(row.code)}</span></a></th>
          ${row.positions.map((p, i) => cell(row, p, i)).join("")}
        </tr>`)
        .join("")}</tbody>
    </table>
  </div>`;
}

function wireHeatmap() {
  const box = document.getElementById("heatmap");
  box.addEventListener("keydown", (event) => {
    const cell = event.target.closest("td.heat__cell");
    if (!cell) return;
    const row = cell.parentElement;
    let target = null;
    switch (event.key) {
      case "ArrowRight": target = cell.nextElementSibling; break;
      case "ArrowLeft": target = cell.previousElementSibling; break;
      case "ArrowDown": target = row.nextElementSibling && row.nextElementSibling.cells[cell.cellIndex]; break;
      case "ArrowUp": target = row.previousElementSibling && row.previousElementSibling.cells[cell.cellIndex]; break;
      case "Home": target = row.cells[1]; break;
      case "End": target = row.cells[row.cells.length - 1]; break;
      case "Escape": hideTip(); return;
      default: return;
    }
    event.preventDefault();
    if (!target || !target.matches("td.heat__cell")) return;
    box.querySelectorAll('td[tabindex="0"]').forEach((td) => (td.tabIndex = -1));
    target.tabIndex = 0;
    target.focus();
  });
  box.addEventListener("focusin", (event) => {
    const cell = event.target.closest("td.heat__cell");
    if (cell) showTip(cell);
  });
  box.addEventListener("focusout", hideTip);
  box.addEventListener("pointerover", (event) => {
    const cell = event.target.closest("td.heat__cell");
    if (cell) showTip(cell);
    else hideTip();
  });
  box.addEventListener("pointerleave", hideTip);
  box.addEventListener("scroll", hideTip, true);
}

function showTip(cell) {
  const tip = document.getElementById("heatTip");
  const card = tip.parentElement;
  tip.textContent = cell.dataset.tip;
  tip.hidden = false;
  const c = cell.getBoundingClientRect();
  const k = card.getBoundingClientRect();
  const left = Math.max(8, Math.min(c.left - k.left + c.width / 2 - tip.offsetWidth / 2, k.width - tip.offsetWidth - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${c.top - k.top - tip.offsetHeight - 8}px`;
}

function hideTip() {
  const tip = document.getElementById("heatTip");
  if (tip) tip.hidden = true;
}

// ---------- Controls ----------

function wireControls() {
  document.querySelectorAll("[data-position-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.positionMode = button.dataset.positionMode;
      document.querySelectorAll("[data-position-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      renderPosition(currentTable());
    });
  });
  document.getElementById("heatSort").addEventListener("change", (event) => {
    state.heatSort = event.target.value;
    renderHeatmap(currentTable());
  });
  document.getElementById("podiumTop").addEventListener("change", (event) => {
    state.podiumTop = event.target.value;
    renderPodium(currentTable());
  });
  for (const id of ["h2hA", "h2hB"]) {
    document.getElementById(id).addEventListener("change", () => {
      state.h2h = { a: document.getElementById("h2hA").value, b: document.getElementById("h2hB").value, user: true };
      renderH2H(currentTable());
    });
  }
  // Legend buttons toggle a driver's line in that chart only.
  for (const key of Object.keys(LINE_CHARTS)) {
    document.getElementById(`${key}Legend`).addEventListener("click", (event) => {
      const button = event.target.closest("[data-series]");
      if (!button) return;
      const hidden = hiddenSet(key);
      const id = button.dataset.series;
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      LINE_CHARTS[key](currentTable());
    });
  }
}

// ---------- Line charts ----------

function renderPoints(table) {
  const top = table.rows.slice(0, 3);
  renderLineChart("points", table, {
    values: (row) => fromFirstStart(row, row.cumulative),
    yMin: 0,
    valueText: (v) => `${v} pts`,
    cellText: (v) => String(v),
    summary: `Line chart of cumulative championship points ${throughPhrase()}. ${top.map((r) => `${r.name} ${r.points}`).join(", ")} points.`,
  });
}

function renderGap(table) {
  const leaderAt = state.rounds.slice(0, state.through).map((_, i) => Math.max(0, ...table.rows.map((row) => row.cumulative[i])));
  const chasers = table.rows.slice(1, 3);
  renderLineChart("gap", table, {
    values: (row) => fromFirstStart(row, row.cumulative.map((points, i) => points - leaderAt[i])),
    yMax: 0,
    yTick: (v) => (v === 0 ? "0" : minus(v)),
    valueText: (v) => (v === 0 ? "Leader" : `${minus(v)} pts`),
    cellText: (v) => (v === 0 ? "Leader" : minus(v)),
    summary: `Line chart of points behind the championship leader after each round, ${throughPhrase()}. ${table.rows[0].name} leads${chasers.length ? `; ${chasers.map((r) => `${r.name} is ${Math.abs(r.gap)} behind`).join(", ")}` : ""}.`,
  });
}

function renderPosition(table) {
  const race = state.positionMode === "race";
  document.getElementById("positionSub").textContent = race
    ? "Race finishing position each round (P1 at the top) · top 8"
    : "Championship position after each round (P1 at the top) · top 8";
  const rankAfter = (row) => state.ranks.slice(0, state.through).map((ranks) => ranks.get(row.id) ?? null);
  const shown = table.rows.slice(0, TOP_N);
  const maxRace = Math.max(10, ...shown.flatMap((row) => row.positions.filter((p) => p !== null)));
  const many = table.rows.length > 12;
  renderLineChart("position", table, {
    values: race ? (row) => row.positions : rankAfter,
    reverse: true,
    yMin: 1,
    yMax: race ? maxRace : Math.max(2, table.rows.length),
    yStep: race || many ? undefined : 1,
    yTick: (v) => (Number.isInteger(v) ? `P${v}` : ""),
    valueText: (v) => `P${v}`,
    cellText: (v) => `P${v}`,
    ascending: true,
    summary: race
      ? `Line chart of race finishing positions ${throughPhrase()}, with P1 at the top. Races not started are gaps.`
      : `Line chart of championship position after each round ${throughPhrase()}, with P1 at the top. Current order: ${shown.map((r) => `${r.rank} ${r.name}`).join(", ")}.`,
  });
}

function renderForm(table) {
  const rolling = (row) =>
    row.positions.map((_, i) => {
      const recent = row.positions.slice(Math.max(0, i - 2), i + 1).filter((p) => p !== null);
      return recent.length ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 10) / 10 : null;
    });
  const shown = table.rows.slice(0, TOP_N);
  const latest = shown
    .map((row) => ({ row, value: lastValue(rolling(row)) }))
    .filter((entry) => entry.value !== null)
    .sort((a, b) => a.value - b.value);
  const maxValue = Math.max(10, ...latest.map((entry) => Math.ceil(Math.max(...rolling(entry.row).filter((v) => v !== null)))));
  renderLineChart("form", table, {
    values: rolling,
    reverse: true,
    yMin: 1,
    yMax: maxValue,
    yTick: (v) => (Number.isInteger(v) ? `P${v}` : ""),
    valueText: (v) => `avg P${fmt1(v)}`,
    cellText: (v) => `P${fmt1(v)}`,
    ascending: true,
    summary: `Line chart of three-race rolling average finishing position ${throughPhrase()}, P1 at the top. In form: ${latest.slice(0, 3).map((e) => `${e.row.name} averaging P${fmt1(e.value)}`).join(", ")}.`,
  });
}

// Every season driver keeps a fixed dataset slot so colours and animations stay
// attached to the same driver as the timeline moves; drivers outside the top N
// (or toggled off in the legend) are hidden rather than removed.
function renderLineChart(key, table, opts) {
  const byId = new Map(table.rows.map((row) => [row.id, row]));
  const shown = table.rows.slice(0, TOP_N);
  const shownIds = new Set(shown.map((row) => row.id));
  const hidden = hiddenSet(key);
  const blank = new Array(state.through).fill(null);
  const datasets = state.drivers.map((driver) => {
    const row = byId.get(driver.id);
    return {
      ...seriesStyle(driver.id),
      data: row ? opts.values(row) : blank,
      hidden: !shownIds.has(driver.id) || hidden.has(driver.id),
    };
  });

  setChartLabel(key, opts.summary);
  renderSeriesLegend(key, shown, hidden);
  renderSeriesTable(key, shown, opts.values, opts.cellText);

  upsertChart(key, {
    type: "line",
    data: { labels: roundLabels(), datasets },
    options: lineOptions(opts),
    plugins: [crosshairPlugin, endLabelsPlugin],
  });
}

function lineOptions({ reverse = false, yMin, yMax, yStep, yTick, valueText, ascending = false }) {
  const phone = PHONE.matches;
  const y = {
    reverse,
    grid: { color: GRID, drawTicks: false },
    border: { display: false },
    ticks: { color: INK_3, padding: 8, precision: 0, font: { size: phone ? 11 : 12, weight: 600 }, maxTicksLimit: phone ? 6 : 8 },
  };
  if (yMin !== undefined) y.min = yMin;
  if (yMax !== undefined) y.max = yMax;
  if (yStep) y.ticks.stepSize = yStep;
  if (yTick) y.ticks.callback = yTick;
  return {
    ...baseOptions(),
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 8, right: phone ? 8 : 44, left: 0 } },
    scales: {
      x: {
        // A lone round would sit on the y axis; centre it instead.
        offset: state.through === 1,
        grid: { display: false },
        border: { color: AXIS },
        ticks: { color: INK_3, font: { size: phone ? 11 : 12, weight: 600 }, maxRotation: 0, autoSkipPadding: 8 },
      },
      y,
    },
    plugins: {
      legend: { display: false },
      tooltip: tooltipOptions({
        title: (items) => roundName(items[0].dataIndex),
        label: (item) => `${valueText(item.parsed.y)}  ${item.dataset.label}`,
        itemSort: ascending ? (a, b) => a.parsed.y - b.parsed.y : (a, b) => b.parsed.y - a.parsed.y,
      }),
      endLabels: { display: !phone },
    },
  };
}

function seriesStyle(id, { dashed = false } = {}) {
  const info = state.info.get(id);
  const { color, pointStyle, order } = state.series.get(id);
  const stroke = STROKE_ONLY.has(pointStyle);
  return {
    label: info.name,
    code: info.code,
    driverId: id,
    order,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    borderDash: dashed ? [6, 4] : [],
    borderCapStyle: "round",
    borderJoinStyle: "round",
    tension: 0,
    spanGaps: false,
    clip: 8, // keep markers on the axis edges (P1, max points) whole
    pointStyle,
    pointRadius: stroke ? 5 : 4,
    pointHoverRadius: stroke ? 7 : 6,
    pointHitRadius: 12,
    pointBackgroundColor: color,
    pointBorderColor: stroke ? color : "#ffffff",
    pointBorderWidth: stroke ? 2 : 1.5,
    pointHoverBorderWidth: 2,
  };
}

function renderSeriesLegend(key, rows, hidden) {
  if (!window.Chart) return;
  document.getElementById(`${key}Legend`).innerHTML = `<ul class="series-legend" role="list" aria-label="Drivers shown. Press a driver to hide or show their line.">${rows
    .map((row) => `<li><button type="button" class="series-legend__item" data-series="${esc(row.id)}" aria-pressed="${!hidden.has(row.id)}" title="${esc(row.name)}">${swatch(row.id)}<span class="series-legend__name">${esc(row.name)}</span><span class="series-legend__code" aria-hidden="true">${esc(row.code)}</span></button></li>`)
    .join("")}</ul>`;
}

function renderSeriesTable(key, rows, values, cellText) {
  const rounds = state.rounds.slice(0, state.through);
  document.getElementById(`${key}Table`).innerHTML = `<table class="f1-table data-table">
    <thead><tr><th scope="col">Driver</th>${rounds.map((r) => `<th scope="col" class="num" title="${esc(r.name)}">R${esc(r.round)}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map((row) => `<tr><th scope="row">${esc(row.name)}</th>${values(row)
        .map((v) => `<td class="num">${v === null ? '<span class="muted">—</span>' : esc(cellText(v))}</td>`)
        .join("")}</tr>`)
      .join("")}</tbody>
  </table>`;
}

// ---------- Podium distribution ----------

function renderPodium(table) {
  const limit = state.podiumTop === "all" ? Infinity : Number(state.podiumTop);
  const rows = table.rows.slice(0, limit);
  const phone = PHONE.matches;
  const counts = rows.map((row) => FINISH_BANDS.map((band) => row.positions.filter((p) => p !== null && band.test(p)).length));

  if (window.Chart) document.getElementById("podiumLegend").innerHTML = `<ul class="series-legend series-legend--static" role="list">${FINISH_BANDS
    .map((band) => `<li><span class="series-legend__item"><span class="swatch-box" style="background:${band.color}"></span>${band.label}</span></li>`)
    .join("")}</ul>`;
  document.getElementById("podiumTable").innerHTML = `<table class="f1-table data-table">
    <thead><tr><th scope="col">Driver</th>${FINISH_BANDS.map((b) => `<th scope="col" class="num">${b.label}</th>`).join("")}<th scope="col" class="num">Starts</th></tr></thead>
    <tbody>${rows.map((row, i) => `<tr><th scope="row">${esc(row.name)}</th>${counts[i].map((c) => `<td class="num">${c}</td>`).join("")}<td class="num">${row.starts}</td></tr>`).join("")}</tbody>
  </table>`;
  const leader = rows[0];
  setChartLabel("podium", `Stacked bar chart of how each driver's starts finished ${throughPhrase()}: wins, P2, P3, P4 to P10 and P11 or lower.${leader ? ` ${leader.name}: ${counts[0].map((c, i) => `${c} ${FINISH_BANDS[i].label}`).join(", ")}.` : ""}`);
  setBoxHeight("podium", Math.max(160, rows.length * (phone ? 36 : 40) + 64));

  upsertChart("podium", {
    type: "bar",
    data: {
      labels: rows.map((row) => (phone ? row.code : row.name)),
      datasets: FINISH_BANDS.map((band, b) => ({
        label: band.label,
        data: counts.map((c) => c[b]),
        backgroundColor: band.color,
        borderColor: "#ffffff",
        borderWidth: 1,
        borderSkipped: false,
        maxBarThickness: 22,
        categoryPercentage: 0.8,
        barPercentage: 1,
      })),
    },
    options: {
      ...baseOptions(),
      indexAxis: "y",
      interaction: { mode: "index", axis: "y", intersect: false },
      layout: { padding: { right: 8 } },
      scales: {
        x: {
          stacked: true,
          min: 0,
          grid: { color: GRID, drawTicks: false },
          border: { display: false },
          ticks: { color: INK_3, padding: 6, precision: 0, stepSize: 1, font: { size: phone ? 11 : 12, weight: 600 } },
          title: { display: true, text: "Starts", color: INK_3, font: { size: 12, weight: 700 } },
        },
        y: {
          stacked: true,
          grid: { display: false },
          border: { color: AXIS },
          ticks: { color: INK_2, font: { size: phone ? 11 : 13, weight: 700 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: tooltipOptions({
          title: (items) => rows[items[0].dataIndex].name,
          label: (item) => `${item.raw} × ${item.dataset.label}`,
          footer: (items) => `${rows[items[0].dataIndex].starts} ${plural(rows[items[0].dataIndex].starts, "start")}`,
          filter: (item) => item.raw > 0,
          usePointStyle: false,
        }),
      },
    },
  });
}

// ---------- Fastest laps ----------

function fastestStats() {
  const stats = new Map();
  state.rounds.slice(0, state.through).forEach((round, i) => {
    for (const id of state.fastest[i]) {
      const result = round.results.find((res) => state.league.resolveDriver(res.driver) === id);
      if (!result) continue;
      const entry = stats.get(id) || { id, count: 0, positions: [], rounds: [] };
      entry.count += 1;
      entry.positions.push(result.position);
      entry.rounds.push(round.round);
      stats.set(id, entry);
    }
  });
  return Array.from(stats.values())
    .map((entry) => ({ ...entry, info: state.info.get(entry.id), avg: entry.positions.reduce((a, b) => a + b, 0) / entry.positions.length }))
    .sort((a, b) => b.count - a.count || a.avg - b.avg);
}

function renderFastest() {
  const list = fastestStats();
  const box = document.getElementById("fastestBox");
  const empty = document.getElementById("fastestEmpty");
  const cards = document.getElementById("fastestCards");
  const phone = PHONE.matches;

  document.getElementById("fastestTable").innerHTML = list.length
    ? `<table class="f1-table data-table">
      <thead><tr><th scope="col">Driver</th><th scope="col" class="num">Fastest laps</th><th scope="col" class="num">Avg finish</th><th scope="col">Rounds</th></tr></thead>
      <tbody>${list.map((s) => `<tr><th scope="row">${esc(s.info.name)}</th><td class="num">${s.count}</td><td class="num">P${fmt1(s.avg)}</td><td>${s.rounds.map((r) => `R${esc(r)}`).join(", ")}</td></tr>`).join("")}</tbody>
    </table>`
    : `<p class="chart-data__empty">No fastest laps ${esc(throughPhrase())}.</p>`;

  if (!list.length) {
    destroyChart("fastest");
    box.hidden = true;
    empty.hidden = false;
    empty.textContent = `No league driver has set a fastest lap ${throughPhrase()}.`;
    cards.innerHTML = "";
    document.getElementById("fastestLegend").innerHTML = "";
    return;
  }
  box.hidden = false;
  empty.hidden = true;

  const most = list[0];
  const standout = list.slice().sort((a, b) => a.avg - b.avg || b.count - a.count)[0];
  cards.innerHTML = [
    flCard("Most fastest laps", most, `${most.count} ${plural(most.count, "fastest lap")} · ${most.rounds.map((r) => `R${esc(r)}`).join(", ")}`),
    flCard("Fastest lap standout", standout, `Avg finish P${fmt1(standout.avg)} in races with the fastest lap`),
  ].join("");
  document.getElementById("fastestLegend").innerHTML = "";

  setChartLabel("fastest", `Bar chart of fastest laps per driver ${throughPhrase()}. ${list.map((s) => `${s.info.name}: ${s.count}, average finish P${fmt1(s.avg)}`).join("; ")}.`);
  setBoxHeight("fastest", Math.max(132, list.length * 44 + 64));
  const maxCount = Math.max(...list.map((s) => s.count));

  upsertChart("fastest", {
    type: "bar",
    data: {
      labels: list.map((s) => (phone ? s.info.code : s.info.name)),
      datasets: [{
        label: "Fastest laps",
        data: list.map((s) => s.count),
        tips: list.map((s) => `${s.count} · avg P${fmt1(s.avg)}`),
        backgroundColor: list.map((s) => seriesColor(s.id)),
        borderRadius: 4,
        borderSkipped: "start",
        maxBarThickness: 22,
        categoryPercentage: 0.8,
        barPercentage: 1,
      }],
    },
    options: {
      ...baseOptions(),
      indexAxis: "y",
      layout: { padding: { right: 96 } },
      scales: {
        x: {
          min: 0,
          suggestedMax: maxCount,
          grid: { color: GRID, drawTicks: false },
          border: { display: false },
          ticks: { color: INK_3, padding: 6, precision: 0, stepSize: 1, font: { size: phone ? 11 : 12, weight: 600 } },
          title: { display: true, text: "Fastest laps", color: INK_3, font: { size: 12, weight: 700 } },
        },
        y: {
          grid: { display: false },
          border: { color: AXIS },
          ticks: { color: INK_2, font: { size: phone ? 11 : 13, weight: 700 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: tooltipOptions({
          title: (items) => list[items[0].dataIndex].info.name,
          label: (item) => {
            const s = list[item.dataIndex];
            return `${s.count} ${plural(s.count, "fastest lap")} · avg finish P${fmt1(s.avg)}`;
          },
          footer: (items) => list[items[0].dataIndex].rounds.map((r) => `R${r}`).join(", "),
          usePointStyle: false,
        }),
      },
    },
    plugins: [barTipsPlugin],
  });
}

function flCard(label, entry, meta) {
  const row = { ...entry.info, teamColor: seriesColor(entry.id) };
  return `<div class="fl-card">
    <p class="fl-card__label"><span class="fl-dot" aria-hidden="true"></span>${label}</p>
    <div class="fl-card__driver">${driverId(row)}</div>
    <p class="fl-card__meta">${meta}</p>
  </div>`;
}

// ---------- Head-to-head ----------

function renderH2H(table) {
  const ids = table.rows.map((row) => row.id);
  let { a, b } = state.h2h;
  if (!state.h2h.user || !ids.includes(a)) a = ids[0] ?? null;
  if (!state.h2h.user || !ids.includes(b) || b === a) b = ids.find((id) => id !== a) ?? null;

  const options = (selected, other) => table.rows
    .map((row) => `<option value="${esc(row.id)}"${row.id === selected ? " selected" : ""}${row.id === other ? " disabled" : ""}>${esc(row.name)}</option>`)
    .join("");
  document.getElementById("h2hA").innerHTML = options(a, b);
  document.getElementById("h2hB").innerHTML = options(b, a);

  const summary = document.getElementById("h2hSummary");
  const box = document.getElementById("h2hBox");
  if (!a || !b) {
    destroyChart("h2h");
    box.hidden = true;
    summary.innerHTML = '<p class="muted">Head-to-head needs at least two drivers with a start.</p>';
    document.getElementById("h2hLegend").innerHTML = "";
    document.getElementById("h2hTable").innerHTML = "";
    return;
  }
  box.hidden = false;

  const h = headToHead(table, a, b);
  const rows = [h.a, h.b];
  const maxPos = Math.max(10, ...rows.flatMap((row) => row.positions.filter((p) => p !== null)));

  if (window.Chart) document.getElementById("h2hLegend").innerHTML = `<ul class="series-legend series-legend--static" role="list">${rows
    .map((row, i) => `<li><span class="series-legend__item">${swatch(row.id, { dashed: i === 1 })}<span>${esc(row.name)}${i === 1 ? " (dashed)" : ""}</span></span></li>`)
    .join("")}</ul>`;
  document.getElementById("h2hTable").innerHTML = `<table class="f1-table data-table">
    <thead><tr><th scope="col">Round</th><th scope="col" class="num">${esc(h.a.name)}</th><th scope="col" class="num">${esc(h.b.name)}</th></tr></thead>
    <tbody>${state.rounds.slice(0, state.through).map((round, i) => `<tr><th scope="row">R${esc(round.round)} · ${esc(round.name)}</th><td class="num">${posText(h.a.positions[i])}</td><td class="num">${posText(h.b.positions[i])}</td></tr>`).join("")}</tbody>
  </table>`;
  summary.innerHTML = h2hSummary(h);
  setChartLabel("h2h", `Line chart comparing race finishes of ${h.a.name} (solid) and ${h.b.name} (dashed) ${throughPhrase()}, P1 at the top. ${h.a.name} finished ahead ${h.aAhead} times, ${h.b.name} ${h.bAhead} times, in ${h.shared} rounds both started.`);

  upsertChart("h2h", {
    type: "line",
    data: {
      labels: roundLabels(),
      datasets: [
        { ...seriesStyle(a), data: h.a.positions, order: 0 },
        { ...seriesStyle(b, { dashed: true }), data: h.b.positions, order: 1 },
      ],
    },
    options: lineOptions({
      reverse: true,
      yMin: 1,
      yMax: maxPos,
      yTick: (v) => (Number.isInteger(v) ? `P${v}` : ""),
      valueText: (v) => `P${v}`,
      ascending: true,
    }),
    plugins: [crosshairPlugin, endLabelsPlugin],
  });
}

function h2hSummary(h) {
  const tagA = driverTag(h.a);
  const tagB = driverTag(h.b);
  let gap = "No shared rounds yet";
  if (h.avgGap !== null) {
    if (Math.abs(h.avgGap) < 0.05) gap = "Dead level on average";
    else gap = `${esc((h.avgGap > 0 ? h.a : h.b).name)} by ${fmt1(Math.abs(h.avgGap))} ${Math.abs(h.avgGap) === 1 ? "place" : "places"}`;
  }
  return `<div class="h2h-score">
      <div class="h2h-score__side">${tagA}</div>
      <p class="h2h-score__num" aria-label="${esc(`${h.a.name} ${h.aAhead}, ${h.b.name} ${h.bAhead}`)}">${h.aAhead}<span aria-hidden="true">–</span>${h.bAhead}</p>
      <div class="h2h-score__side h2h-score__side--b">${tagB}</div>
    </div>
    <p class="h2h-score__caption">Finished ahead, in the ${h.shared} ${plural(h.shared, "round")} both started</p>
    <dl class="h2h-facts">
      <div><dt>Best finish</dt><dd>${esc(h.a.name)} <strong>P${h.a.bestFinish}</strong> · ${esc(h.b.name)} <strong>P${h.b.bestFinish}</strong></dd></div>
      <div><dt>Avg finishing gap</dt><dd><strong>${gap}</strong></dd></div>
    </dl>`;
}

// ---------- Chart.js plumbing ----------

function setupChartDefaults() {
  const Chart = window.Chart;
  if (!Chart) return;
  Chart.defaults.font.family = FONT;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = INK_3;
  Chart.defaults.plugins.legend.display = false;
}

function baseOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: REDUCED_MOTION.matches ? false : { duration: 400 },
  };
}

function tooltipOptions({ title, label, footer, itemSort, filter, usePointStyle = true }) {
  return {
    backgroundColor: INK,
    titleColor: "#ffffff",
    bodyColor: "#ffffff",
    footerColor: "#c4c4cf",
    titleFont: { family: FONT, size: 13, weight: 700 },
    bodyFont: { family: FONT, size: 13, weight: 600 },
    footerFont: { family: FONT, size: 12, weight: 600 },
    padding: 10,
    cornerRadius: 6,
    caretSize: 5,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 6,
    usePointStyle,
    multiKeyBackground: "transparent",
    filter: filter || ((item) => item.parsed && Number.isFinite(item.parsed.y)),
    itemSort,
    callbacks: { title, label, ...(footer ? { footer } : {}) },
  };
}

// Updates in place when the chart exists (smooth timeline playback); creates
// it otherwise. One Chart instance per canvas, always.
function upsertChart(key, config) {
  const Chart = window.Chart;
  const canvas = document.getElementById(`${key}Chart`);
  if (!Chart || !canvas) return;
  let chart = state.charts.get(key);
  if (chart && (chart.canvas !== canvas || chart.config.type !== config.type)) {
    chart.destroy();
    chart = null;
  }
  if (chart) {
    chart.data = config.data;
    chart.options = config.options;
    chart.update();
    return;
  }
  const stale = Chart.getChart(canvas);
  if (stale) stale.destroy();
  state.charts.set(key, new Chart(canvas, config));
}

function destroyChart(key) {
  const chart = state.charts.get(key);
  if (chart) chart.destroy();
  state.charts.delete(key);
}

function setChartLabel(key, text) {
  const canvas = document.getElementById(`${key}Chart`);
  if (canvas) canvas.setAttribute("aria-label", text);
}

function setBoxHeight(key, px) {
  if (window.Chart) document.getElementById(`${key}Box`).style.height = `${px}px`;
}

// Vertical hairline at the hovered round.
const crosshairPlugin = {
  id: "crosshair",
  beforeDatasetsDraw(chart) {
    const active = chart.tooltip && chart.tooltip.getActiveElements();
    if (!active || !active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, chartArea.top);
    ctx.lineTo(Math.round(x) + 0.5, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Driver code at the end of each visible line. Labels that would collide with
// one already drawn are skipped (the legend and tooltip still identify them).
const endLabelsPlugin = {
  id: "endLabels",
  afterDatasetsDraw(chart, args, options) {
    if (!options || !options.display) return;
    const { ctx } = chart;
    const labels = [];
    chart.data.datasets.forEach((dataset, i) => {
      if (!chart.isDatasetVisible(i)) return;
      const points = chart.getDatasetMeta(i).data;
      for (let j = points.length - 1; j >= 0; j -= 1) {
        const point = points[j];
        if (point && !point.skip && Number.isFinite(point.y)) {
          labels.push({ x: point.x, y: point.y, text: dataset.code || dataset.label, order: dataset.order ?? i });
          break;
        }
      }
    });
    labels.sort((a, b) => a.order - b.order);
    const placed = [];
    ctx.save();
    ctx.font = `700 11px ${FONT}`;
    ctx.fillStyle = INK_2;
    ctx.textBaseline = "middle";
    for (const label of labels) {
      if (placed.some((p) => Math.abs(p.y - label.y) < 12 && Math.abs(p.x - label.x) < 40)) continue;
      ctx.fillText(label.text, label.x + 9, label.y);
      placed.push(label);
    }
    ctx.restore();
  },
};

// Value label at the tip of each bar (fastest laps chart).
const barTipsPlugin = {
  id: "barTips",
  afterDatasetsDraw(chart) {
    const dataset = chart.data.datasets[0];
    if (!dataset || !dataset.tips) return;
    const { ctx } = chart;
    ctx.save();
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = INK_2;
    ctx.textBaseline = "middle";
    chart.getDatasetMeta(0).data.forEach((bar, i) => {
      if (dataset.tips[i]) ctx.fillText(dataset.tips[i], bar.x + 8, bar.y);
    });
    ctx.restore();
  },
};

function fontsReady() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  const load = Promise.all([document.fonts.load(`600 12px ${FONT}`), document.fonts.load(`700 12px ${FONT}`)]).catch(() => {});
  return Promise.race([load, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

// ---------- Series colours ----------

// One colour + point style per driver for the whole season (ordered by final
// standings so the top driver keeps their team colour). A driver whose team
// colour is already taken gets the first palette colour that stays distinct.
function assignSeries(rows) {
  const series = new Map();
  const used = [];
  rows.forEach((row, index) => {
    let color = chartSafe(row.teamColor);
    if (used.some((c) => deltaE(c, color) < SAME_COLOR_DE)) {
      const free = FALLBACK_COLORS.filter((c) => !used.includes(c));
      const minDistance = (c) => Math.min(...used.map((u) => deltaE(u, c)));
      color = free.find((c) => minDistance(c) >= 15) || free.sort((x, y) => minDistance(y) - minDistance(x))[0] || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
    }
    used.push(color);
    series.set(row.id, { color, pointStyle: POINT_STYLES[index % POINT_STYLES.length], order: index });
  });
  return series;
}

function seriesColor(id) {
  const entry = state.series.get(id);
  return entry ? entry.color : "#8a8f98";
}

function swatch(id, { dashed = false } = {}) {
  const { color, pointStyle } = state.series.get(id);
  return `<svg class="swatch" viewBox="0 0 28 14" width="28" height="14" aria-hidden="true" focusable="false"><path d="M1 7H27" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="4 3"' : ""}/>${marker(pointStyle, color)}</svg>`;
}

function marker(style, color) {
  const ring = `stroke="#fff" stroke-width="1.5"`;
  const line = `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"`;
  switch (style) {
    case "rect": return `<rect x="10" y="3" width="8" height="8" fill="${color}" ${ring}/>`;
    case "rectRounded": return `<rect x="10" y="3" width="8" height="8" rx="2.5" fill="${color}" ${ring}/>`;
    case "triangle": return `<path d="M14 2.2L18.8 11H9.2Z" fill="${color}" ${ring}/>`;
    case "rectRot": return `<path d="M14 1.8L19.2 7L14 12.2L8.8 7Z" fill="${color}" ${ring}/>`;
    case "star": return `<path d="M14 2V12M9 7H19M10.5 3.5L17.5 10.5M17.5 3.5L10.5 10.5" ${line}/>`;
    case "crossRot": return `<path d="M10.5 3.5L17.5 10.5M17.5 3.5L10.5 10.5" ${line}/>`;
    case "cross": return `<path d="M14 2V12M9 7H19" ${line}/>`;
    default: return `<circle cx="14" cy="7" r="4.5" fill="${color}" ${ring}/>`;
  }
}

// --- colour maths (OKLab) ---

function normalizeHex(value) {
  const hex = String(value || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${hex.split("").map((c) => c + c).join("")}`.toLowerCase();
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}`.toLowerCase() : "#8a8f98";
}

function toLinear(hex) {
  const h = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

function oklab(hex) {
  const [r, g, b] = toLinear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb
    .map((c) => {
      const v = Math.max(0, Math.min(1, c));
      const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      return Math.round(srgb * 255).toString(16).padStart(2, "0");
    })
    .join("")}`;
}

function chartSafe(hex) {
  const [L, a, b] = oklab(hex);
  return L <= MAX_SERIES_L ? normalizeHex(hex) : fromOklab(MAX_SERIES_L, a, b);
}

function deltaE(x, y) {
  const p = oklab(x);
  const q = oklab(y);
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function contrast(x, y) {
  const lum = (hex) => {
    const [r, g, b] = toLinear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

// Sequential one-hue ramp: t = 1 is the best finish (deep red), 0 the worst (near white).
function heatColor(t) {
  const L = 0.96 - t * 0.56;
  const C = 0.02 + t * 0.17;
  return fromOklab(L, C * Math.cos(HEAT_HUE), C * Math.sin(HEAT_HUE));
}

// ---------- Small helpers ----------

function hiddenSet(key) {
  if (!state.hidden.has(key)) state.hidden.set(key, new Set());
  return state.hidden.get(key);
}

function roundLabels() {
  return state.rounds.slice(0, state.through).map((round) => `R${round.round}`);
}

function roundName(index) {
  const round = state.rounds[index];
  return round ? `Round ${round.round} · ${round.name}` : "";
}

// Null before a driver's first start, so lines begin when they joined.
function fromFirstStart(row, values) {
  const first = row.positions.findIndex((p) => p !== null);
  return values.map((v, i) => (first === -1 || i < first ? null : v));
}

function lastValue(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null) return values[i];
  return null;
}

function avg(row) {
  return row.avgFinish ?? Infinity;
}

function best(row) {
  return row.bestFinish ?? Infinity;
}

function fmt1(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "—";
}

function minus(value) {
  return value < 0 ? `−${Math.abs(value)}` : String(value);
}

function posText(position) {
  return position === null ? '<span class="muted">DNS</span>' : `P${position}`;
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

// Boot last: the plugin objects above must be initialised before render runs.
const ctx = await initPage("analytics");
if (ctx) await render(ctx);
