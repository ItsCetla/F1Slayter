// Page shell shared by every page: header + nav, season picker, race-day
// banner, footer, formatting and small HTML helpers.

import { loadLeague, parseStart, roundStatus } from "./league.js";

export const ROOT = new URL("../../", import.meta.url);

const NAV = [
  { key: "home", label: "Home", path: "" },
  { key: "schedule", label: "Schedule", path: "schedule/" },
  { key: "results", label: "Results", path: "results/" },
  { key: "standings", label: "Standings", path: "standings/" },
  { key: "drivers", label: "Drivers", path: "drivers/" },
  { key: "analytics", label: "Analytics", path: "analytics/" },
];

const FLAG_CDN = "https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/";

let timeZone = "America/New_York";
let activeSeasonId = null;
let defaultSeasonId = null;

// ---------- HTML helpers ----------

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Site-relative link. Keeps the selected season in the URL unless it is the default one.
export function link(path = "", params = {}) {
  const url = new URL(path, ROOT);
  const merged = { season: activeSeasonId !== defaultSeasonId ? activeSeasonId : null, ...params };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.pathname + url.search + url.hash;
}

// Site files resolve against the site root; full URLs (e.g. a hosted track map) pass through.
export function asset(path) {
  const url = new URL(path, ROOT);
  return url.origin === ROOT.origin ? url.pathname : url.href;
}

export function flag(countryCode, label = "") {
  if (!countryCode) return "";
  const code = String(countryCode).toLowerCase().replace(/[^a-z]/g, "");
  if (code.length !== 2) return "";
  const alt = label ? ` alt="${esc(label)}"` : ' alt=""';
  return `<img class="flag" src="${FLAG_CDN}${code}.svg"${alt} width="22" height="16" loading="lazy">`;
}

export function countryName(countryCode) {
  if (!countryCode) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(String(countryCode).toUpperCase()) || "";
  } catch {
    return "";
  }
}

export function driverId(row, { link: withLink = true, code = true } = {}) {
  const name = esc(row.name);
  const nameHtml = withLink
    ? `<a class="driver-id__name" href="${link("drivers/", { id: row.id })}">${name}</a>`
    : `<span class="driver-id__name">${name}</span>`;
  const codeHtml = code && row.code ? `<span class="driver-id__code">${esc(row.code)}</span>` : "";
  return `<span class="driver-id" style="--team:${esc(row.teamColor || "#8a8f98")}"><span class="team-bar"></span>${nameHtml}${codeHtml}</span>`;
}

export function teamChip(team, color) {
  if (!team) return '<span class="muted">—</span>';
  return `<span class="team-chip" style="--team:${esc(color)}">${esc(team)}</span>`;
}

export function finishChip(position, { fastestLap = false, title = "" } = {}) {
  if (position === null || position === undefined) {
    return `<span class="fin fin--dns" title="${esc(title || "Did not start")}">—</span>`;
  }
  let cls = "fin";
  if (position === 1) cls += " fin--win";
  else if (position <= 3) cls += " fin--podium";
  else if (position <= 10) cls += " fin--points";
  if (fastestLap) cls += " fin--fl";
  const label = title || `P${position}${fastestLap ? ", fastest lap" : ""}`;
  return `<span class="${cls}" title="${esc(label)}">${position}</span>`;
}

export function finishLegend() {
  return `<div class="legend" aria-hidden="true">
    <span><span class="fin fin--win">1</span> Win</span>
    <span><span class="fin fin--podium">3</span> Podium</span>
    <span><span class="fin fin--points">7</span> Points</span>
    <span><span class="fin">14</span> No points</span>
    <span><span class="fin fin--dns">—</span> Did not start</span>
    <span><span class="fin fin--points fin--fl">5</span> Fastest lap</span>
  </div>`;
}

export function signed(value) {
  if (!value) return "—";
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function trackImage(round) {
  return round && round.trackImage ? asset(round.trackImage) : null;
}

export function trackMap(round) {
  const src = trackImage(round);
  if (src) {
    return `<div class="track-map"><img src="${src}" alt="${esc(round.circuit || round.name)} circuit map" loading="lazy"></div>`;
  }
  return `<div class="track-map track-map--empty"><span>${esc(round && round.circuit && round.circuit !== "TBD" ? round.circuit : "Track to be announced")}</span></div>`;
}

export function isTbd(round) {
  return !round || !round.name || round.name === "TBD";
}

export function roundTitle(round) {
  if (isTbd(round)) return "To be announced";
  return round.grandPrix || `${round.name} Grand Prix`;
}

// ---------- Dates (always shown in the league's time zone) ----------

export function fmtDate(date, options = {}) {
  if (!date) return "TBC";
  return new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(date);
}

export const fmt = {
  long: (d) => fmtDate(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
  short: (d) => fmtDate(d, { month: "short", day: "numeric" }),
  day: (d) => fmtDate(d, { day: "2-digit" }),
  month: (d) => fmtDate(d, { month: "short" }).toUpperCase(),
  time: (d) => fmtDate(d, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
  isoDay: (d) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone }).format(d) : null),
};

export function startCountdown(container, target, { onDone } = {}) {
  if (!container) return () => {};
  if (!target) {
    container.innerHTML = countdownMarkup(null);
    return () => {};
  }
  const tick = () => {
    const ms = target.getTime() - Date.now();
    if (ms <= 0) {
      container.innerHTML = '<span class="badge badge--red badge--live">Lights out</span>';
      clearInterval(timer);
      if (onDone) onDone();
      return;
    }
    container.innerHTML = countdownMarkup(ms);
  };
  const timer = setInterval(tick, 15000);
  tick();
  return () => clearInterval(timer);
}

function countdownMarkup(ms) {
  const units = ms === null
    ? [["\u2013", "Days"], ["\u2013", "Hrs"], ["\u2013", "Mins"]]
    : [
        [Math.floor(ms / 86400000), "Days"],
        [Math.floor((ms % 86400000) / 3600000), "Hrs"],
        [Math.floor((ms % 3600000) / 60000), "Mins"],
      ];
  return `<div class="countdown" role="timer" aria-label="${ms === null ? "Start time to be confirmed" : esc(units.map(([n, l]) => `${n} ${l}`).join(", "))}">${units
    .map(([n, l]) => `<div class="countdown__unit"><span class="countdown__num">${typeof n === "number" ? String(n).padStart(2, "0") : n}</span><span class="countdown__label">${l}</span></div>`)
    .join("")}</div>`;
}

// ---------- Shell ----------

const MARK = `<svg class="brand__mark" viewBox="0 0 44 22" aria-hidden="true" fill="#e10600"><path d="M10 0h14L14 22H0z"/><path d="M27 0h8L25 22h-8z"/><path d="M38 0h6L34 22h-6z" opacity=".6"/></svg>`;

function renderHeader(pageKey) {
  const header = document.getElementById("site-header");
  if (!header) return;
  header.className = "site-header";
  header.innerHTML = `
    <div class="topbar">
      <div class="container">
        <p class="topbar__tag">F1 game league · a <a href="https://cetla.dev">CETLA</a> league</p>
        <div class="season-picker">
          <label for="seasonSelect">Season</label>
          <select id="seasonSelect" disabled><option>Loading…</option></select>
        </div>
      </div>
    </div>
    <nav class="navbar" aria-label="Main">
      <div class="container">
        <a class="brand" href="${new URL("", ROOT).pathname}" aria-label="Slayter League home">${MARK}<span class="brand__name">Slayter <span>League</span></span></a>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="navLinks" aria-label="Menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </button>
        <ul class="nav-links" id="navLinks">
          ${NAV.map((item) => `<li><a data-nav="${item.key}" href="${new URL(item.path, ROOT).pathname}"${item.key === pageKey ? ' aria-current="page"' : ""}>${item.label}</a></li>`).join("")}
        </ul>
      </div>
    </nav>`;

  const toggle = header.querySelector(".nav-toggle");
  const nav = header.querySelector(".navbar");
  const close = () => {
    header.classList.remove("nav-open");
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", () => {
    const open = header.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header.classList.contains("nav-open")) {
      close();
      toggle.focus();
    }
  });
  // The open menu covers the page, so close it once focus or a click goes elsewhere.
  nav.addEventListener("focusout", (event) => {
    if (header.classList.contains("nav-open") && !nav.contains(event.relatedTarget)) close();
  });
  document.addEventListener("click", (event) => {
    if (header.classList.contains("nav-open") && !nav.contains(event.target)) close();
  });
}

function renderFooter() {
  const footer = document.getElementById("site-footer");
  if (!footer) return;
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="container">
      <a class="brand" href="${new URL("", ROOT).pathname}" aria-label="Slayter League home">${MARK}<span class="brand__name">Slayter <span>League</span></span></a>
      <nav aria-label="Footer"><ul>${NAV.map((item) => `<li><a data-nav="${item.key}" href="${new URL(item.path, ROOT).pathname}">${item.label}</a></li>`).join("")}</ul></nav>
      <p class="site-footer__legal">Slayter League · f1.cetla.dev · a <a href="https://cetla.dev">CETLA</a> league. A private league racing the official F1 video game. Not affiliated with Formula 1, the FIA or any team.</p>
    </div>`;
}

function wireSeasonPicker(league, season) {
  const select = document.getElementById("seasonSelect");
  if (!select) return;
  select.innerHTML = league.seasons
    .map((s) => `<option value="${esc(s.id)}"${s.id === season.id ? " selected" : ""}>${esc(s.label)} · ${esc(s.year)}${s.status === "active" ? " (current)" : ""}</option>`)
    .join("");
  select.disabled = false;
  select.addEventListener("change", () => {
    const url = new URL(window.location.href);
    // Round/driver selections belong to the old season, so drop them.
    url.searchParams.delete("round");
    if (select.value === defaultSeasonId) url.searchParams.delete("season");
    else url.searchParams.set("season", select.value);
    window.location.href = url.pathname + url.search;
  });

  // Keep nav and logo links on the selected season.
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const item = NAV.find((n) => n.key === a.dataset.nav);
    if (item) a.href = link(item.path);
  });
  document.querySelectorAll(".brand").forEach((a) => (a.href = link("")));
}

const BANNER_KEY = "slayter-raceday-dismissed";

function renderRaceDayBanner(league) {
  const season = league.currentSeason;
  if (!season) return;
  const today = fmt.isoDay(new Date());
  const round = season.rounds.find((r) => {
    const start = parseStart(r);
    return start && fmt.isoDay(start) === today && roundStatus(r) !== "complete" && r.status !== "cancelled";
  });
  if (!round) return;

  const dismissKey = `${season.id}-${round.round}`;
  try {
    if (localStorage.getItem(BANNER_KEY) === dismissKey) return;
  } catch {
    /* storage blocked: always show */
  }

  const start = parseStart(round);
  const banner = document.createElement("div");
  banner.className = "raceday";
  banner.setAttribute("role", "status");
  banner.innerHTML = `<div class="container">
      <strong>Race day</strong>
      <span>Round ${esc(round.round)} · ${esc(roundTitle(round))} · lights out ${esc(fmt.time(start))}</span>
      <a href="${link("schedule/")}">Schedule</a>
      <button class="raceday__close" type="button" aria-label="Dismiss race day banner">×</button>
    </div>`;
  banner.querySelector(".raceday__close").addEventListener("click", () => {
    try {
      localStorage.setItem(BANNER_KEY, dismissKey);
    } catch {
      /* ignore */
    }
    banner.remove();
  });
  document.getElementById("site-header")?.after(banner);
}

// Data problems are only shown to whoever is checking an edit: on a local
// server, or on the live site with ?debug in the URL.
function renderDataIssues(issues) {
  if (!issues.length) return;
  const local = ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
  if (!local && !new URLSearchParams(window.location.search).has("debug")) return;
  const box = document.createElement("div");
  box.className = "data-issues";
  box.setAttribute("role", "alert");
  box.innerHTML = `<div class="container"><strong>league.json has ${issues.length} problem${issues.length === 1 ? "" : "s"}</strong>
    <ul>${issues.map((issue) => `<li>${esc(issue)}</li>`).join("")}</ul></div>`;
  document.getElementById("site-header")?.after(box);
}

export function renderError(error, retry) {
  const main = document.getElementById("main");
  if (!main) return;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  main.innerHTML = `<div class="container"><section class="card error-state" role="alert">
      <h2>Couldn't load league data</h2>
      <p>${offline ? "You appear to be offline. Reconnect and try again." : esc(error && error.message ? error.message : "Something went wrong.")}</p>
      <button class="btn" type="button">Try again</button>
    </section></div>`;
  main.querySelector("button").addEventListener("click", () => (retry ? retry() : window.location.reload()));
}

// Boots a page: renders the shell, loads data, resolves the selected season.
// Returns null (after showing an error) if the data could not be loaded.
export async function initPage(pageKey) {
  renderHeader(pageKey);
  renderFooter();

  let league;
  try {
    league = await loadLeague();
  } catch (error) {
    console.error(error);
    renderError(error);
    return null;
  }
  for (const issue of league.issues) console.warn(`[league.json] ${issue}`);
  renderDataIssues(league.issues);

  timeZone = league.info.timezone || timeZone;
  const params = new URLSearchParams(window.location.search);
  const current = league.currentSeason;
  defaultSeasonId = current ? current.id : null;
  const season = league.season(params.get("season")) || current;
  activeSeasonId = season ? season.id : null;

  if (season) wireSeasonPicker(league, season);
  renderRaceDayBanner(league);
  return { league, season, params };
}
