import { standings, teamStandings, seasonEntries, latestCompletedRound, pointsFor } from "../league.js";
import { initPage, esc, link, driverId, teamChip, finishChip, finishLegend, signed, ordinal } from "../ui.js";

const SORTS = [
  { key: "points", label: "Points" },
  { key: "wins", label: "Wins" },
  { key: "podiums", label: "Podiums" },
  { key: "fastestLaps", label: "Fastest laps" },
];

const ctx = await initPage("standings");
if (ctx) render(ctx);

function render({ league, season, params }) {
  const main = document.getElementById("main");
  if (!season) {
    main.innerHTML = `<div class="container"><div class="card empty-state"><h2>No seasons yet</h2><p>Add a season to data/league.json.</p></div></div>`;
    return;
  }

  const view = params.get("view") === "teams" ? "teams" : "drivers";
  const table = standings(league, season);
  document.title = `${view === "teams" ? "Team" : "Driver"} standings — Slayter League`;

  let body;
  if (!table.rounds.length) body = emptyState(league, season, view);
  else if (view === "teams") body = teamsView(league, season);
  else body = driversView(league, table);

  main.innerHTML = `${pageHead(season, table, view)}<div class="container">${body}</div>`;

  if (table.rounds.length && view === "drivers") wireSort(league, table, params.get("sort"));
}

function pageHead(season, table, view) {
  const last = latestCompletedRound(season);
  const totalRounds = season.rounds.length ? season.rounds[season.rounds.length - 1].round : 0;
  let progress = "Pre-season";
  if (season.status === "complete" && last) progress = "Final";
  else if (last) progress = `After round ${last.round} of ${totalRounds}`;

  const tab = (key, label) =>
    `<a href="${link("standings/", { view: key })}"${key === view ? ' aria-current="page"' : ""}>${label}</a>`;

  return `<header class="page-head">
    <div class="container page-head__inner">
      <div>
        <p class="kicker">${esc(season.label)} · ${esc(season.year)} · ${esc(progress)}</p>
        <h1 class="title">${view === "teams" ? "Team" : "Driver"} standings</h1>
      </div>
      <nav class="tabs" aria-label="Standings view">${tab("drivers", "Drivers")}${tab("teams", "Teams")}</nav>
    </div>
  </header>`;
}

// ---------- Drivers ----------

function driversView(league, table) {
  return `${spotlight(table.rows.slice(0, 3), table.rounds.length)}
    <section class="section standings-block" aria-labelledby="driverTableTitle">
      <div class="standings-toolbar">
        <div>
          <h2 class="standings-toolbar__title" id="driverTableTitle">Championship</h2>
          <p class="muted">${table.rows.length} drivers · ${table.rounds.length} ${table.rounds.length === 1 ? "race" : "races"}</p>
        </div>
        <label class="field">Sort by
          <select class="select" id="sortSelect">
            ${SORTS.map((s) => `<option value="${s.key}">${s.label}</option>`).join("")}
          </select>
        </label>
      </div>
      <p class="sort-note" id="sortNote" role="status" aria-live="polite"></p>
      <div class="table-wrap" id="driverTable"></div>
      <div class="standings-legend">${finishLegend()}</div>
    </section>`;
}

function spotlight(top, races) {
  if (!top.length) return "";
  return `<section class="spotlight" aria-label="Championship top three">
    ${top
      .map((row) => `<article class="spot card spot--p${row.rank}" style="--team:${esc(row.teamColor)}">
        <p class="spot__pos">${row.rank}<span>${esc(ordinal(row.rank).replace(/^\d+/, ""))}</span></p>
        <div class="spot__id">
          <h2 class="spot__name"><a href="${link("drivers/", { id: row.id })}">${esc(row.name)}</a></h2>
          <p class="spot__team">${esc(row.team || "—")}</p>
        </div>
        <dl class="spot__stats">
          <div><dt>Points</dt><dd>${row.points}</dd></div>
          <div><dt>Wins</dt><dd>${row.wins}<span class="spot__of">/${races}</span></dd></div>
        </dl>
      </article>`)
      .join("")}
  </section>`;
}

function wireSort(league, table, initial) {
  const select = document.getElementById("sortSelect");
  const flags = fastestLapFlags(league, table.rounds);
  const apply = (key) => {
    const sort = SORTS.find((s) => s.key === key) || SORTS[0];
    select.value = sort.key;
    document.getElementById("driverTable").innerHTML = driverTable(table, flags, sort);
    document.getElementById("sortNote").textContent = sort.key === "points"
      ? ""
      : `Sorted by ${sort.label.toLowerCase()}. POS is still the championship position.`;
    // Keep the choice in the URL so it survives reloads and can be shared.
    const url = new URL(window.location.href);
    if (sort.key === "points") url.searchParams.delete("sort");
    else url.searchParams.set("sort", sort.key);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  };
  select.addEventListener("change", () => apply(select.value));
  apply(initial);
}

// Per-driver array (aligned with table.rounds) of rounds where they set fastest lap.
function fastestLapFlags(league, rounds) {
  const flags = new Map();
  rounds.forEach((round, index) => {
    for (const result of round.results) {
      if (!result.fastestLap) continue;
      const id = league.resolveDriver(result.driver);
      if (!id) continue;
      if (!flags.has(id)) flags.set(id, new Array(rounds.length).fill(false));
      flags.get(id)[index] = true;
    }
  });
  return flags;
}

function driverTable(table, flags, sort) {
  const rows = table.rows.slice().sort((a, b) => b[sort.key] - a[sort.key] || a.rank - b.rank);
  // The sorted column stays visible on phones even if it is normally hidden there.
  const cls = (key, extra) => (key === sort.key ? `num${extra.replace(" hide-sm", "")} is-sorted` : `num${extra}`);
  const th = (key, label, extra = "") =>
    `<th scope="col" class="${cls(key, extra)}"${key === sort.key ? ' aria-sort="descending"' : ""}>${label}</th>`;
  const td = (key, value, extra = "") => `<td class="${cls(key, extra)}">${value}</td>`;

  return `<table class="f1-table standings-table">
    <caption class="sr-only">Driver standings${sort.key === "points" ? "" : `, sorted by ${esc(sort.label.toLowerCase())}`}</caption>
    <thead><tr>
      <th scope="col" class="pos">Pos</th>
      <th scope="col">Driver</th>
      <th scope="col" class="hide-sm">Team</th>
      ${th("wins", "Wins")}
      ${th("podiums", "Podiums", " hide-sm")}
      ${th("fastestLaps", '<abbr title="Fastest laps">FL</abbr>', " hide-sm")}
      <th scope="col" class="hide-sm">Last 5</th>
      <th scope="col" class="num">Gap</th>
      ${th("points", "Pts")}
    </tr></thead>
    <tbody>
      ${rows
        .map((row) => `<tr>
          <td class="pos">${row.rank}</td>
          <td>${driverId(row)}</td>
          <td class="hide-sm">${teamChip(row.team, row.teamColor)}</td>
          ${td("wins", row.wins)}
          ${td("podiums", row.podiums, " hide-sm")}
          ${td("fastestLaps", row.fastestLaps, " hide-sm")}
          <td class="hide-sm">${lastFive(row, table.rounds, flags.get(row.id) || [])}</td>
          <td class="num gap">${gap(row)}</td>
          ${td("points", row.points, " pts")}
        </tr>`)
        .join("")}
    </tbody>
  </table>`;
}

function lastFive(row, rounds, flFlags) {
  const offset = row.positions.length - row.form.length;
  const chips = row.form.map((position, i) => {
    const round = rounds[offset + i];
    const fastestLap = Boolean(flFlags[offset + i]);
    const where = `Round ${round.round} · ${round.name}`;
    const title = position === null ? `${where}: did not start` : `${where}: P${position}${fastestLap ? ", fastest lap" : ""}`;
    return finishChip(position, { fastestLap, title });
  });
  const spoken = row.form.map((p) => (p === null ? "did not start" : `P${p}`)).join(", ");
  return `<span class="fins" aria-hidden="true">${chips.join("")}</span><span class="sr-only">Last ${row.form.length}: ${esc(spoken)}</span>`;
}

function gap(row) {
  if (row.rank === 1) return '<span class="gap-leader">Leader</span>';
  return row.gap ? signed(row.gap) : "0";
}

// ---------- Teams ----------

function teamsView(league, season) {
  const table = teamStandings(league, season);
  const scorers = teamScorers(league, table.rounds);
  return `<section class="standings-block" aria-labelledby="teamTableTitle">
    <h2 class="sr-only" id="teamTableTitle">Team championship</h2>
    <div class="table-wrap">
      <table class="f1-table standings-table teams-table">
        <thead><tr>
          <th scope="col" class="pos">Pos</th>
          <th scope="col">Team</th>
          <th scope="col" class="hide-sm">Drivers</th>
          <th scope="col" class="num">Wins</th>
          <th scope="col" class="num hide-sm">Podiums</th>
          <th scope="col" class="num">Pts</th>
        </tr></thead>
        <tbody>
          ${table.rows
            .map((row) => {
              const drivers = teamDrivers(league, row, scorers.get(row.team));
              return `<tr>
                <td class="pos">${row.rank}</td>
                <td>
                  <span class="team-id" style="--team:${esc(row.color)}"><span class="team-bar"></span><span class="team-id__name">${esc(row.team)}</span></span>
                  <span class="team-drivers team-drivers--sm">${drivers}</span>
                </td>
                <td class="hide-sm"><span class="team-drivers">${drivers}</span></td>
                <td class="num">${row.wins}</td>
                <td class="num hide-sm">${row.podiums}</td>
                <td class="num pts">${row.points}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
    <p class="note">Points count for the team a driver raced for in each round, so mid-season switches split between teams.</p>
  </section>`;
}

// team -> Map(driverId -> points scored for that team)
function teamScorers(league, rounds) {
  const teams = new Map();
  for (const round of rounds) {
    for (const result of round.results) {
      const id = league.resolveDriver(result.driver);
      if (!id) continue;
      const team = result.team || "Unassigned";
      if (!teams.has(team)) teams.set(team, new Map());
      const drivers = teams.get(team);
      drivers.set(id, (drivers.get(id) || 0) + pointsFor(league, result));
    }
  }
  return teams;
}

function teamDrivers(league, row, contributions = new Map()) {
  const scored = Array.from(contributions).filter(([, points]) => points > 0).sort((a, b) => b[1] - a[1]);
  // A team nobody scored for still lists who raced for it.
  const list = scored.length ? scored : Array.from(contributions);
  if (!list.length) return '<span class="muted">—</span>';
  return list
    .map(([id, points]) => {
      const driver = league.drivers.get(id);
      return `<span class="team-driver"><a href="${link("drivers/", { id })}">${esc(driver ? driver.name : id)}</a> <span class="muted">${points} pts</span></span>`;
    })
    .join("");
}

// ---------- Empty season ----------

function emptyState(league, season, view) {
  const entries = seasonEntries(league, season);
  const fallback = league.seasons.find((s) => s.id !== season.id && latestCompletedRound(s));
  return `<section class="card empty-state standings-empty">
    <h2>No races yet</h2>
    <p>${esc(season.label)} standings appear after Round 1.${fallback ? ` Until then, look back at how ${esc(fallback.label)} ${fallback.status === "complete" ? "finished" : "stands"}.` : ""}</p>
    ${entries.length ? `<div class="entry-list">
      <h3 class="entry-list__title">${esc(season.label)} entry list</h3>
      <ul>${entries.map((d) => `<li>${driverId(d)}${d.team ? teamChip(d.team, d.teamColor) : ""}</li>`).join("")}</ul>
    </div>` : ""}
    ${fallback ? `<div class="btn-row">
      <a class="btn" href="${link("standings/", { season: fallback.id, view: view === "teams" ? "teams" : null })}">${esc(fallback.label)} ${fallback.status === "complete" ? "final " : ""}standings</a>
      <a class="btn btn--ghost" href="${link("schedule/")}">${esc(season.label)} schedule</a>
    </div>` : ""}
  </section>`;
}
