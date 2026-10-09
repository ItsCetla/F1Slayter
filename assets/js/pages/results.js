import {
  completedRounds, latestCompletedRound, parseStart, roundStatus, roundWinner, roundFastestLap, standings,
  teamColor, pointsFor,
} from "../league.js";
import {
  initPage, esc, link, flag, countryName, driverId, teamChip, trackMap, roundTitle, isTbd, fmt, ordinal,
} from "../ui.js";

const SEP = '<span class="race-hero__sep" aria-hidden="true">·</span>';

const ctx = await initPage("results");
if (ctx) render(ctx);

function render({ league, season, params }) {
  const main = document.getElementById("main");
  if (!season) {
    main.innerHTML = `<div class="container"><div class="card empty-state"><h2>No seasons yet</h2><p>Add a season to data/league.json.</p></div></div>`;
    return;
  }

  const roundParam = params.get("round");
  if (roundParam === null || roundParam === "") {
    document.title = `${season.label} results — Slayter League`;
    main.innerHTML = summaryView(league, season);
    return;
  }

  const n = /^\d+$/.test(roundParam) ? Number(roundParam) : NaN;
  const round = season.rounds.find((r) => r.round === n);
  if (!round) {
    document.title = `Race not found — Slayter League`;
    main.innerHTML = notFoundView(season, roundParam);
    return;
  }

  document.title = `${isTbd(round) ? `Round ${round.round}` : roundTitle(round)} results · ${season.label} — Slayter League`;
  main.innerHTML = raceView(league, season, round);
  wireRoundSelect();
}

// ---------- Shared bits ----------

// Tab-like switch between the season summary and the per-race view.
function viewTabs(season, current = null) {
  const latest = latestCompletedRound(season);
  const raceRound = current || latest;
  if (!raceRound) return "";
  return `<nav class="tabs res-tabs" aria-label="Results view">
    <a href="${link("results/")}"${current ? "" : ' aria-current="page"'}>All races</a>
    <a href="${link("results/", { round: raceRound.round })}"${current ? ' aria-current="page"' : ""}>Race by race</a>
  </nav>`;
}

function statusBadge(status, round) {
  if (status === "cancelled") return '<span class="badge">Cancelled</span>';
  if (status === "awaiting-results") return '<span class="badge badge--red">Results pending</span>';
  if (isTbd(round)) return '<span class="badge">To be announced</span>';
  if (!parseStart(round)) return '<span class="badge">Date TBC</span>';
  return '<span class="badge">Upcoming</span>';
}

// Most recent season (other than this one) that has at least one result.
function fallbackSeason(league, season) {
  return league.seasons.find((s) => s.id !== season.id && completedRounds(s).length) || null;
}

// ---------- Season summary ----------

function summaryView(league, season) {
  const done = completedRounds(season);
  const total = season.rounds.filter((r) => r.status !== "cancelled").length;

  const head = `<section class="page-head">
    <div class="container page-head__inner">
      <div>
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
        <h1 class="title">${esc(season.label)} <em>Race results</em></h1>
        <p class="lede">${done.length
          ? `${done.length} of ${total} ${total === 1 ? "round" : "rounds"} complete. Pick a Grand Prix for the full classification.`
          : `No ${esc(season.label)} races have been run yet.`}</p>
      </div>
      ${viewTabs(season)}
    </div>
  </section>`;

  if (!done.length) {
    const fallback = fallbackSeason(league, season);
    return `${head}
      <div class="container">
        <div class="card empty-state res-empty">
          <h2>No results yet</h2>
          <p>Results for ${esc(season.label)} appear here after each race, with the winner, fastest lap and full classification.${fallback ? ` Until then, catch up on ${esc(fallback.label)}.` : ""}</p>
          <div class="btn-row">
            ${fallback ? `<a class="btn" href="${link("results/", { season: fallback.id })}">${esc(fallback.label)} results</a>` : ""}
            <a class="btn btn--ghost" href="${link("schedule/")}">${esc(season.label)} schedule</a>
          </div>
        </div>
      </div>`;
  }

  return `${head}
    <section class="container" aria-labelledby="summaryTitle">
      <h2 class="sr-only" id="summaryTitle">${esc(season.label)} Grands Prix</h2>
      <div class="table-wrap">
        <table class="f1-table res-summary">
          <thead><tr>
            <th scope="col">Grand Prix</th>
            <th scope="col">Date</th>
            <th scope="col">Winner</th>
            <th scope="col" class="hide-sm">Team</th>
            <th scope="col" class="hide-sm">Fastest lap</th>
            <th scope="col" class="num hide-sm">Laps</th>
          </tr></thead>
          <tbody>${season.rounds.map((round) => summaryRow(league, round)).join("")}</tbody>
        </table>
      </div>
      <p class="note">Winner and fastest lap among league drivers. Select a Grand Prix for the full classification.</p>
    </section>`;
}

function summaryRow(league, round) {
  const status = roundStatus(round);
  const start = parseStart(round);
  const complete = status === "complete";
  const href = complete ? link("results/", { round: round.round }) : `${link("schedule/")}#round-${round.round}`;
  const gp = `<a class="res-gp" href="${href}"><span class="res-gp__round">R${esc(round.round)}</span>${flag(round.country, "")}<span class="res-gp__name">${esc(roundTitle(round))}</span></a>`;
  const date = `<td class="res-date">${start ? `<time datetime="${esc(start.toISOString())}">${esc(fmt.short(start))}</time>` : '<span class="muted">TBC</span>'}</td>`;

  if (!complete) {
    return `<tr class="res-summary__pending${status === "cancelled" ? " res-summary__cancelled" : ""}">
      <td>${gp}</td>
      ${date}
      <td>${statusBadge(status, round)}</td>
      <td class="hide-sm"><span class="muted">—</span></td>
      <td class="hide-sm"><span class="muted">—</span></td>
      <td class="num hide-sm">${round.laps ? esc(round.laps) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }

  const winResult = round.results.find((r) => r.position === 1);
  const winner = roundWinner(league, round);
  const fastest = roundFastestLap(league, round);
  const winnerCell = winner
    ? driverId({ id: winner.id, name: winner.name, code: winner.code, teamColor: teamColor(league, winResult.team) })
    : '<span class="muted" title="No league driver won this race">AI winner</span>';
  return `<tr>
    <td>${gp}</td>
    ${date}
    <td>${winnerCell}</td>
    <td class="hide-sm">${winResult ? teamChip(winResult.team, teamColor(league, winResult.team)) : '<span class="muted">—</span>'}</td>
    <td class="hide-sm">${fastest ? `<span class="res-fl"><span class="res-fl__dot" aria-hidden="true"></span>${esc(fastest.name)}</span>` : '<span class="muted">—</span>'}</td>
    <td class="num hide-sm">${round.laps ? esc(round.laps) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

// ---------- Not found ----------

function notFoundView(season, value) {
  const rounds = season.rounds.length;
  return `<section class="page-head">
      <div class="container">
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
        <h1 class="title">Race not found</h1>
      </div>
    </section>
    <div class="container">
      <div class="card empty-state">
        <h2>No round “${esc(value)}”</h2>
        <p>${esc(season.label)} has ${rounds} ${rounds === 1 ? "round" : "rounds"}. The link may be out of date, or the race belongs to another season.</p>
        <div class="btn-row">
          <a class="btn" href="${link("results/")}">${esc(season.label)} results</a>
          <a class="btn btn--ghost" href="${link("schedule/")}">Schedule</a>
        </div>
      </div>
    </div>`;
}

// ---------- Race classification ----------

function raceView(league, season, round) {
  const status = roundStatus(round);
  return `${raceHeader(season, round, status)}
    <div class="container">
      ${roundNav(season, round)}
      ${status === "complete" ? classification(league, season, round) : noResults(league, season, round, status)}
    </div>`;
}

function raceHeader(season, round, status) {
  const start = parseStart(round);
  const tbd = isTbd(round);
  const country = round.country ? countryName(round.country) : "";
  const distance = round.laps ? `${esc(round.laps)} laps${round.lengthKm ? ` × ${esc(round.lengthKm)} km` : ""}` : "";
  const highlights = Array.isArray(round.highlights) ? round.highlights.filter(Boolean) : [];

  return `<section class="race-hero band-dark">
    <div class="speed-stripes" aria-hidden="true"></div>
    <div class="container race-hero__inner">
      <div class="race-hero__copy">
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}${status !== "complete" ? ` · ${statusBadge(status, round)}` : ""}</p>
        <p class="race-hero__round">Round ${esc(round.round)}<span> of ${season.rounds.length}</span></p>
        <h1 class="race-hero__title">${esc(roundTitle(round))}</h1>
        ${tbd
          ? '<p class="race-hero__meta">Venue and date to be announced.</p>'
          : `<p class="race-hero__meta">${country ? `<span class="race-hero__place">${flag(round.country, country)}<span>${esc(country)}</span></span>${SEP}` : ""}<span>${esc(round.circuit || "")}</span></p>
            <p class="race-hero__meta race-hero__meta--sub">${start ? `<time datetime="${esc(start.toISOString())}">${esc(fmt.long(start))} · ${esc(fmt.time(start))}</time>` : "<span>Date TBC</span>"}${distance ? `${SEP}<span>${distance}</span>` : ""}</p>`}
        ${highlights.length
          ? `<ul class="race-hero__highlights" aria-label="Race highlights">${highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>`
          : ""}
      </div>
      <div class="race-hero__visual">${trackMap(round)}</div>
    </div>
  </section>`;
}

function roundNav(season, round) {
  const done = completedRounds(season);
  const index = done.findIndex((r) => r.round === round.round);
  // For a round without results, step to the nearest completed rounds either side.
  const prev = index >= 0 ? done[index - 1] : done.filter((r) => r.round < round.round).pop();
  const next = index >= 0 ? done[index + 1] : done.find((r) => r.round > round.round);

  const step = (target, dir) => {
    const label = dir === "prev" ? "Previous" : "Next";
    const icon = dir === "prev"
      ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
    const text = `<span class="res-step__text">${label}</span>`;
    if (!target) {
      return `<span class="btn btn--ghost res-step res-step--${dir}" aria-disabled="true">${dir === "prev" ? icon + text : text + icon}<span class="sr-only"> race: none</span></span>`;
    }
    return `<a class="btn btn--ghost res-step res-step--${dir}" href="${link("results/", { round: target.round })}" rel="${dir}">${dir === "prev" ? icon + text : text + icon}<span class="sr-only"> race: Round ${esc(target.round)}, ${esc(roundTitle(target))}</span></a>`;
  };

  return `<div class="toolbar res-toolbar">
    ${viewTabs(season, round)}
    ${done.length
      ? `<div class="res-roundnav">
          ${step(prev, "prev")}
          <label class="field res-roundnav__field">
            <span class="sr-only">Choose a race</span>
            <select class="select" id="roundSelect">
              ${index < 0 ? `<option value="" selected disabled>Round ${esc(round.round)} · no results</option>` : ""}
              ${done.map((r) => `<option value="${link("results/", { round: r.round })}"${r.round === round.round ? " selected" : ""}>R${esc(r.round)} · ${esc(roundTitle(r))}</option>`).join("")}
            </select>
          </label>
          ${step(next, "next")}
        </div>`
      : ""}
  </div>`;
}

function wireRoundSelect() {
  const select = document.getElementById("roundSelect");
  if (!select) return;
  select.addEventListener("change", () => {
    if (select.value) window.location.href = select.value;
  });
}

function classification(league, season, round) {
  const after = standings(league, season, { throughRound: round.round });
  const afterById = new Map(after.rows.map((r) => [r.id, r]));
  // Championship before this round; null when this is the season's first race.
  const hadEarlier = completedRounds(season, round.round - 1).length > 0;
  const beforeRank = hadEarlier
    ? new Map(standings(league, season, { throughRound: round.round - 1 }).rows.map((r) => [r.id, r.rank]))
    : null;

  const results = round.results.slice().sort((a, b) => a.position - b.position);
  const rows = results.map((res) => {
    const id = league.resolveDriver(res.driver);
    const driver = id ? league.drivers.get(id) : null;
    const color = teamColor(league, res.team);
    const who = driver
      ? driverId({ id, name: driver.name, code: driver.code, teamColor: color })
      : driverId({ name: res.driver, teamColor: color }, { link: false });
    const champ = id ? afterById.get(id) : null;
    const points = pointsFor(league, res);
    return `<tr${res.position === 1 ? ' class="res-class__win"' : ""}>
      <td class="pos">${esc(res.position)}</td>
      <td><div class="res-driver">${who}${res.fastestLap ? '<span class="fl-badge" title="Fastest lap"><span aria-hidden="true">FL</span><span class="sr-only">Fastest lap</span></span>' : ""}</div></td>
      <td class="hide-sm">${teamChip(res.team, color)}</td>
      <td class="num pts">${points ? `+${points}` : '<span class="muted">0</span>'}</td>
      <td class="res-champ">${champ ? champCell(champ, beforeRank) : '<span class="muted">—</span>'}</td>
    </tr>`;
  });

  const fastest = roundFastestLap(league, round);
  const leader = after.rows[0];
  return `<section class="res-class" aria-labelledby="classTitle">
    <div class="section-head">
      <div>
        <p class="kicker">Round ${esc(round.round)} · Race</p>
        <h2 class="section-title" id="classTitle">Classification</h2>
      </div>
      <a class="more-link" href="${link("standings/")}">Standings</a>
    </div>
    <div class="table-wrap">
      <table class="f1-table res-class__table">
        <thead><tr>
          <th scope="col" class="pos">Pos</th>
          <th scope="col">Driver</th>
          <th scope="col" class="hide-sm">Team</th>
          <th scope="col" class="num">Pts</th>
          <th scope="col">Championship</th>
        </tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
    <p class="note">League drivers only — gaps in positions are AI cars.${fastest ? "" : " No fastest lap recorded for a league driver."} Championship shows each driver’s position after this round${hadEarlier ? " and the change since the previous round" : ""}.</p>
    ${leader ? `<p class="res-leader">After round ${esc(round.round)}: <a href="${link("drivers/", { id: leader.id })}">${esc(leader.name)}</a> leads on ${leader.points} pts${after.rows[1] ? `, ${leader.points - after.rows[1].points} ahead of ${esc(after.rows[1].name)}` : ""}.</p>` : ""}
  </section>`;
}

function champCell(row, beforeRank) {
  const pos = `<span class="res-champ__pos">${esc(ordinal(row.rank))}</span><span class="res-champ__pts">${row.points} pts</span>`;
  if (!beforeRank) return `<span class="res-champ__inner">${pos}</span>`;
  const before = beforeRank.get(row.id);
  let move;
  if (before === undefined) {
    move = '<span class="move move--new"><span aria-hidden="true">New</span><span class="sr-only">first race of the season</span></span>';
  } else {
    const diff = before - row.rank;
    if (diff > 0) move = `<span class="move move--up"><span class="move__icon" aria-hidden="true"></span><span aria-hidden="true">${diff}</span><span class="sr-only">up ${diff}</span></span>`;
    else if (diff < 0) move = `<span class="move move--down"><span class="move__icon" aria-hidden="true"></span><span aria-hidden="true">${-diff}</span><span class="sr-only">down ${-diff}</span></span>`;
    else move = '<span class="move move--same"><span class="move__icon" aria-hidden="true"></span><span class="sr-only">no change</span></span>';
  }
  return `<span class="res-champ__inner">${pos}${move}</span>`;
}

function noResults(league, season, round, status) {
  const fallback = completedRounds(season).length ? null : fallbackSeason(league, season);
  const copy = {
    cancelled: ["Round cancelled", "This round was cancelled and does not count towards the championship."],
    "awaiting-results": ["Results pending", "This race has been run. The classification will appear here once the results are in."],
    scheduled: [
      "Not raced yet",
      isTbd(round) ? "This round hasn't been announced yet. Results appear here after the race." : "Results appear here after the race. Check the schedule for the start time.",
    ],
  }[status] || ["No results", ""];
  return `<div class="card empty-state res-empty">
    <h2>${esc(copy[0])}</h2>
    <p>${esc(copy[1])}</p>
    <div class="btn-row">
      <a class="btn" href="${link("schedule/")}#round-${esc(round.round)}">View on schedule</a>
      ${fallback ? `<a class="btn btn--ghost" href="${link("results/", { season: fallback.id })}">${esc(fallback.label)} results</a>` : `<a class="btn btn--ghost" href="${link("results/")}">All ${esc(season.label)} results</a>`}
    </div>
  </div>`;
}
