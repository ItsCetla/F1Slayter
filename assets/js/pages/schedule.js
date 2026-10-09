import {
  completedRounds, parseStart, roundStatus, roundFastestLap, standings, teamColor,
} from "../league.js";
import {
  initPage, esc, link, flag, countryName, trackMap, roundTitle, isTbd, fmt, fmtDate, startCountdown,
} from "../ui.js";

// Filter tabs. Rounds that have been raced but await results count as
// "completed" (they are no longer upcoming); cancelled rounds only show under All.
const FILTERS = [
  { key: "all", label: "All", match: () => true },
  { key: "upcoming", label: "Upcoming", match: (kind) => ["next", "scheduled", "tbd"].includes(kind) },
  { key: "completed", label: "Completed", match: (kind) => ["complete", "awaiting-results"].includes(kind) },
];

const RACE_HOURS = 2; // calendar event length

const ctx = await initPage("schedule");
if (ctx) render(ctx);

function render({ league, season }) {
  const main = document.getElementById("main");
  if (!season) {
    main.innerHTML = `<div class="container"><div class="card empty-state"><h3>No seasons yet</h3><p>Add a season to data/league.json.</p></div></div>`;
    return;
  }

  const rounds = season.rounds;
  const next = rounds.find((r) => roundStatus(r) === "scheduled" && parseStart(r)) || null;
  const items = rounds.map((round) => ({ round, kind: kindOf(round, next) }));
  const dated = rounds.filter((r) => parseStart(r) && r.status !== "cancelled");
  const announced = rounds.some((r) => !isTbd(r) && parseStart(r));
  const fallback = announced ? null : league.seasons.find((s) => s.id !== season.id && completedRounds(s).length) || null;

  document.title = `${season.label} schedule — Slayter League`;
  main.innerHTML = `
    ${pageHead(league, season, next, dated.length)}
    <section class="container" aria-labelledby="roundsTitle">
      <h2 class="sr-only" id="roundsTitle">Rounds</h2>
      ${items.length > 1 ? filterBar(items) : ""}
      <div class="sched-grid${fallback ? " sched-grid--pending" : ""}" id="roundGrid">
        ${items.map(({ round, kind }) => roundCard(league, round, kind)).join("")}
        ${announced ? "" : pendingNotice(season, fallback)}
      </div>
      <div class="card empty-state sched-filter-empty" id="filterEmpty" hidden></div>
      <p class="sr-only" id="filterStatus" aria-live="polite"></p>
      ${dated.length ? `<p class="note">All times are shown in the league time zone (${esc((league.info.timezone || "America/New_York").replace(/_/g, " "))}).</p>` : ""}
    </section>`;

  if (next) startCountdown(document.getElementById("nextCountdown"), parseStart(next));
  wireFilters(items, season);
  wireCalendarButton(league, season, dated);
  focusHash();
  window.addEventListener("hashchange", focusHash);
}

// ---------- Page head ----------

function pageHead(league, season, next, datedCount) {
  const total = season.rounds.filter((r) => r.status !== "cancelled").length;
  const done = completedRounds(season).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const champ = season.status === "complete" ? standings(league, season).rows[0] : null;
  const nextStart = next ? parseStart(next) : null;

  let status = "";
  if (champ) {
    status = ` Season finished — champion <a href="${link("drivers/", { id: champ.id })}">${esc(champ.name)}</a>.`;
  } else if (next) {
    status = ` Next up: Round ${esc(next.round)}, ${esc(roundTitle(next))} on ${esc(fmt.long(nextStart))}.`;
  } else if (!total || season.rounds.every((r) => isTbd(r) || !parseStart(r))) {
    status = " The calendar is being finalised.";
  }

  return `<section class="page-head">
    <div class="container page-head__inner">
      <div class="sched-head__copy">
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
        <h1 class="title">${esc(season.label)} <em>Schedule</em></h1>
        <p class="lede"><strong>${done} of ${total} ${total === 1 ? "round" : "rounds"} complete.</strong>${status}</p>
        <div class="sched-progress" role="progressbar" aria-label="Season progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-valuetext="${done} of ${total} rounds complete">
          <span style="width: ${pct}%"></span>
        </div>
      </div>
      <div class="sched-head__actions">
        <button class="btn btn--ghost" type="button" id="icsButton"${datedCount ? ` title="Download every dated ${esc(season.label)} round as an .ics calendar file"` : ' disabled title="Race dates have not been announced yet, so there is nothing to add to a calendar"'}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/></svg>
          Add to calendar
        </button>
        <p class="sched-head__hint">${datedCount ? `${datedCount} ${datedCount === 1 ? "race" : "races"} · .ics for Google, Apple &amp; Outlook` : "Available once race dates are set"}</p>
      </div>
    </div>
  </section>`;
}

// ---------- Filters ----------

function filterBar(items) {
  return `<div class="toolbar sched-toolbar">
    <div class="tabs sched-tabs" role="group" aria-label="Show rounds">
      ${FILTERS.map((f, i) => `<button type="button" data-filter="${f.key}" aria-pressed="${i === 0}">${f.label}<span class="sched-tabs__count">${items.filter((it) => f.match(it.kind)).length}</span></button>`).join("")}
    </div>
  </div>`;
}

function wireFilters(items, season) {
  const buttons = document.querySelectorAll("[data-filter]");
  const empty = document.getElementById("filterEmpty");
  const status = document.getElementById("filterStatus");
  const notice = document.querySelector(".sched-pending");

  const apply = (key) => {
    const filter = FILTERS.find((f) => f.key === key) || FILTERS[0];
    let shown = 0;
    for (const { round, kind } of items) {
      const card = document.getElementById(`round-${round.round}`);
      const visible = filter.match(kind);
      card.hidden = !visible;
      if (visible) shown += 1;
    }
    if (notice) notice.hidden = filter.key !== "all";
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter.key)));

    empty.hidden = shown > 0;
    if (!shown) {
      const allDone = filter.key === "upcoming" && season.status === "complete";
      empty.innerHTML = `<h3>No ${filter.label.toLowerCase()} rounds</h3>
        <p>${allDone ? `${esc(season.label)} is complete — every round has been run.` : filter.key === "upcoming" ? "Every announced round has been raced." : `No ${esc(season.label)} rounds have been raced yet.`}</p>
        <div class="btn-row"><button class="btn btn--ghost" type="button" data-show-all>Show all rounds</button></div>`;
      empty.querySelector("[data-show-all]").addEventListener("click", () => {
        apply("all");
        document.querySelector('[data-filter="all"]')?.focus();
      });
    }
    status.textContent = `Showing ${shown} ${shown === 1 ? "round" : "rounds"}`;
  };

  buttons.forEach((b) => b.addEventListener("click", () => apply(b.dataset.filter)));
}

// ---------- Round cards ----------

function kindOf(round, next) {
  const status = roundStatus(round);
  if (status === "cancelled") return "cancelled";
  if (status === "complete") return "complete";
  if (status === "awaiting-results") return "awaiting-results";
  if (isTbd(round)) return "tbd";
  if (next && round.round === next.round) return "next";
  return "scheduled";
}

function roundCard(league, round, kind) {
  if (kind === "tbd") return tbdCard(round);
  const start = parseStart(round);
  const corner = kind === "next" ? " f1-corner--red" : kind === "complete" ? "" : " sched-card--quiet";
  const country = round.country ? countryName(round.country) : "";
  const title = esc(roundTitle(round));
  const distance = round.laps
    ? `${esc(round.laps)} laps${round.lengthKm ? ` × ${esc(round.lengthKm)} km` : ""}`
    : round.lengthKm ? `${esc(round.lengthKm)} km lap` : "";

  return `<article class="sched-card card f1-corner${corner} sched-card--${kind}" id="round-${esc(round.round)}" aria-labelledby="round-${esc(round.round)}-title">
    <div class="sched-card__head">
      <span class="sched-card__round">Round ${esc(round.round)}</span>
      ${badgeFor(kind, start)}
    </div>
    ${dateBlock(start)}
    <div class="sched-card__place">
      ${country ? `<p class="sched-card__country">${flag(round.country)}<span>${esc(country)}</span></p>` : ""}
      <h3 class="sched-card__title" id="round-${esc(round.round)}-title">${kind === "complete" ? `<a href="${link("results/", { round: round.round })}">${title}</a>` : title}</h3>
      ${round.circuit ? `<p class="sched-card__circuit">${esc(round.circuit)}</p>` : ""}
      ${distance ? `<p class="sched-card__distance">${distance}</p>` : ""}
    </div>
    <div class="sched-card__map">${trackMap(round)}</div>
    <div class="sched-card__foot">${footFor(league, round, kind)}</div>
  </article>`;
}

function dateBlock(start) {
  if (!start) {
    return `<div class="sched-card__when"><p class="sched-card__date"><span class="sched-card__day">TBC</span></p><p class="sched-card__time">Date to be confirmed</p></div>`;
  }
  return `<div class="sched-card__when">
    <p class="sched-card__date"><time datetime="${esc(start.toISOString())}"><span class="sched-card__day">${esc(fmt.day(start))}</span> <span class="sched-card__month">${esc(fmt.month(start))}</span></time></p>
    <p class="sched-card__time">${esc(fmtDate(start, { weekday: "short" }))} · ${esc(fmt.time(start))}</p>
  </div>`;
}

function badgeFor(kind, start) {
  switch (kind) {
    case "next":
      return '<span class="badge badge--red">Next race</span>';
    case "complete":
      return "";
    case "awaiting-results":
      return '<span class="badge badge--red">Results pending</span>';
    case "cancelled":
      return '<span class="badge">Cancelled</span>';
    default:
      return start ? '<span class="badge">Upcoming</span>' : '<span class="badge">Date TBC</span>';
  }
}

function footFor(league, round, kind) {
  if (kind === "complete") return podium(league, round);
  if (kind === "next") {
    return `<div class="sched-card__countdown">
      <p class="sched-card__label">Lights out in</p>
      <div id="nextCountdown"></div>
    </div>`;
  }
  if (kind === "awaiting-results") {
    return `<p class="sched-card__status">This race has been run. The classification will appear here once results are in.</p>`;
  }
  if (kind === "cancelled") {
    return `<p class="sched-card__status">This round was cancelled and does not count towards the championship.</p>`;
  }
  return `<p class="sched-card__status">${parseStart(round) ? "Countdown starts when this becomes the next race." : "Start time to be confirmed."}</p>`;
}

function podium(league, round) {
  const top = (round.results || [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .slice(0, 3);
  const fastest = roundFastestLap(league, round);
  return `<ol class="sched-podium" aria-label="Top three league finishers">
      ${top
        .map((res) => {
          const driver = league.driver(res.driver);
          const name = driver ? driver.name : res.driver;
          const code = driver ? driver.code : String(res.driver).slice(0, 3).toUpperCase();
          return `<li style="--team:${esc(teamColor(league, res.team))}">
            <span class="sched-podium__pos">${esc(res.position)}</span>
            <span class="team-bar"></span>
            <span class="sched-podium__code">${esc(code)}</span>
            ${driver ? `<a class="sched-podium__name" href="${link("drivers/", { id: driver.id })}">${esc(name)}</a>` : `<span class="sched-podium__name">${esc(name)}</span>`}
          </li>`;
        })
        .join("")}
    </ol>
    <div class="sched-card__links">
      ${fastest ? `<p class="sched-card__fl"><span class="sched-card__fl-dot" aria-hidden="true"></span>Fastest lap <strong>${esc(fastest.name)}</strong></p>` : '<span></span>'}
      <a class="more-link" href="${link("results/", { round: round.round })}" aria-label="Round ${esc(round.round)} results">Results</a>
    </div>`;
}

function tbdCard(round) {
  return `<article class="sched-card card f1-corner sched-card--tbd" id="round-${esc(round.round)}" aria-labelledby="round-${esc(round.round)}-title">
    <div class="sched-card__head">
      <span class="sched-card__round">Round ${esc(round.round)}</span>
    </div>
    ${dateBlock(parseStart(round))}
    <div class="sched-card__place">
      <h3 class="sched-card__title" id="round-${esc(round.round)}-title">To be announced</h3>
      <p class="sched-card__circuit">Venue and start time coming soon</p>
    </div>
    <div class="sched-card__map">${trackMap(round)}</div>
    <div class="sched-card__foot"><p class="sched-card__status">The countdown starts here once the date is set.</p></div>
  </article>`;
}

function pendingNotice(season, fallback) {
  return `<aside class="sched-pending card band-dark" aria-labelledby="pendingTitle">
    <div class="speed-stripes" aria-hidden="true"></div>
    <div class="sched-pending__body">
      <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
      <h3 class="sched-pending__title" id="pendingTitle">Calendar being finalised</h3>
      <p>Rounds, circuits and start times will appear here as they are announced, each with a live countdown. The calendar download unlocks once dates are set.</p>
      ${fallback
        ? `<div class="btn-row">
            <a class="btn" href="${link("schedule/", { season: fallback.id })}">${esc(fallback.label)} schedule</a>
            <a class="btn btn--ghost" href="${link("results/", { season: fallback.id })}">${esc(fallback.label)} results</a>
          </div>`
        : ""}
    </div>
  </aside>`;
}

// ---------- Deep links (#round-N from the home page) ----------

function focusHash() {
  const match = /^#round-(\d+)$/.exec(window.location.hash);
  if (!match) return;
  const card = document.getElementById(`round-${match[1]}`);
  if (!card) return;
  if (card.hidden) document.querySelector('[data-filter="all"]')?.click();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  card.classList.remove("is-target");
  // Restart the highlight animation if the same hash is followed twice.
  void card.offsetWidth;
  card.classList.add("is-target");
  card.addEventListener("animationend", () => card.classList.remove("is-target"), { once: true });
}

// ---------- Calendar (.ics) download ----------

function wireCalendarButton(league, season, dated) {
  const button = document.getElementById("icsButton");
  if (!button || !dated.length) return;
  button.addEventListener("click", () => {
    const blob = new Blob([buildIcs(league, season, dated)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `slayter-league-${String(season.id).replace(/[^a-z0-9-]/gi, "")}.ics`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function buildIcs(league, season, rounds) {
  const leagueName = league.info.name || "Slayter League";
  const host = league.info.site || window.location.host || "slayter-league";
  const stamp = icsDate(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${icsText(leagueName)}//Schedule//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`${leagueName} ${season.label}`)}`,
  ];
  for (const round of rounds) {
    const start = parseStart(round);
    const end = new Date(start.getTime() + RACE_HOURS * 3600000);
    const page = new URL(link("schedule/", { season: season.id }), window.location.origin);
    page.hash = `round-${round.round}`;
    const where = [round.circuit && round.circuit !== "TBD" ? round.circuit : "", countryName(round.country)].filter(Boolean).join(", ");
    const details = [
      `${season.label} · Round ${round.round}`,
      round.laps ? `${round.laps} laps${round.lengthKm ? ` × ${round.lengthKm} km` : ""}` : "",
      page.href,
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsText(`${season.id}-round-${round.round}@${host}`)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsText(`${leagueName} R${round.round}: ${roundTitle(round)}`)}`,
      ...(where ? [`LOCATION:${icsText(where)}`] : []),
      `DESCRIPTION:${icsText(details)}`,
      `URL:${page.href}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// RFC 5545 TEXT escaping.
function icsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 line folding: at most 75 octets per line, continuation lines start with a space.
function foldLine(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = parts.length ? 74 : 75;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
