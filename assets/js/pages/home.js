import {
  standings, teamStandings, seasonSummary, nextRound, latestCompletedRound, parseStart, roundStatus,
  roundWinner, teamColor, pointsFor,
} from "../league.js";
import {
  initPage, esc, link, flag, countryName, driverId, teamChip, finishChip, signed, trackMap, roundTitle,
  isTbd, fmt, startCountdown, ordinal,
} from "../ui.js";

const ctx = await initPage("home");
if (ctx) render(ctx);

function render({ league, season }) {
  const main = document.getElementById("main");
  if (!season) {
    main.innerHTML = `<div class="container"><div class="card empty-state"><h3>No seasons yet</h3><p>Add a season to data/league.json.</p></div></div>`;
    return;
  }

  // When the selected season has no results yet, fall back to the most
  // recent season that does, and label it clearly.
  const seasonWithResults = latestCompletedRound(season)
    ? season
    : league.seasons.find((s) => s.year <= season.year && latestCompletedRound(s)) || null;
  const lastChampionSeason = league.seasons.find((s) => s.status === "complete" && s.year <= season.year && latestCompletedRound(s));

  main.innerHTML = [
    heroSection(league, season, lastChampionSeason),
    seasonWithResults ? latestResultSection(league, seasonWithResults, season) : "",
    seasonWithResults ? standingsSection(league, seasonWithResults, season, lastChampionSeason) : "",
    scheduleSection(league, season),
    seasonWithResults ? statsSection(league, seasonWithResults) : "",
  ].join("");

  const next = nextRound(season);
  if (next) startCountdown(document.getElementById("heroCountdown"), parseStart(next));
}

function heroSection(league, season, championSeason) {
  const next = nextRound(season);
  if (!next) {
    // Season finished: celebrate the champion instead of a countdown.
    const table = standings(league, season);
    const champ = table.rows[0];
    const summary = seasonSummary(league, season);
    return `<section class="hero band-dark">
      <div class="speed-stripes" aria-hidden="true"></div>
      <div class="container hero__inner">
        <div class="hero__copy">
          <p class="kicker">${esc(season.label)} · ${esc(season.year)} · ${season.status === "complete" ? "Final" : "Latest"}</p>
          <h1 class="hero__title">${champ ? `${esc(champ.name)}<span class="hero__title-sub">${season.status === "complete" ? "Champion" : "Leads the championship"}</span>` : esc(season.label)}</h1>
          ${champ ? `<p class="hero__meta">${champ.points} points · ${champ.wins} wins from ${summary.racesCompleted} races · ${champ.podiums} podiums</p>` : ""}
          <div class="btn-row hero__actions">
            <a class="btn" href="${link("standings/")}">Final standings</a>
            <a class="btn btn--ghost" href="${link("results/")}">All results</a>
          </div>
        </div>
      </div>
    </section>`;
  }

  const start = parseStart(next);
  const status = roundStatus(next);
  const tbd = isTbd(next);
  const champ = championSeason ? standings(league, championSeason).rows[0] : null;
  return `<section class="hero band-dark">
    <div class="speed-stripes" aria-hidden="true"></div>
    <div class="container hero__inner">
      <div class="hero__copy">
        <p class="kicker">${esc(season.label)} · Round ${esc(next.round)}${status === "awaiting-results" ? ' · <span class="badge badge--red">Results pending</span>' : ""}</p>
        <h1 class="hero__title">${tbd ? `${esc(season.label)}<span class="hero__title-sub">Next race to be announced</span>` : esc(roundTitle(next))}</h1>
        ${tbd ? `<p class="hero__meta">The ${esc(season.label)} calendar is being finalised. Check back for the first round.</p>` : `<p class="hero__meta">${flag(next.country, countryName(next.country))}<span>${esc(next.circuit)}</span><span aria-hidden="true">·</span><span>${start ? `${esc(fmt.long(start))} · ${esc(fmt.time(start))}` : "Date TBC"}</span></p>`}
        <div class="hero__countdown">
          <p class="hero__countdown-label">${start ? "Lights out in" : "Countdown starts once the date is set"}</p>
          <div id="heroCountdown"></div>
        </div>
        <div class="btn-row hero__actions">
          <a class="btn" href="${link("schedule/")}">Full schedule</a>
          ${champ ? `<a class="btn btn--ghost" href="${link("results/", { season: championSeason.id })}">${esc(championSeason.label)} results</a>` : ""}
        </div>
      </div>
      <div class="hero__visual">${trackMap(next)}</div>
    </div>
  </section>`;
}

function latestResultSection(league, resultSeason, selectedSeason) {
  const round = latestCompletedRound(resultSeason);
  const table = standings(league, resultSeason);
  const byId = new Map(table.rows.map((r) => [r.id, r]));
  const results = round.results
    .map((res) => ({ ...res, id: league.resolveDriver(res.driver) }))
    .filter((res) => res.id)
    .sort((a, b) => a.position - b.position);
  const podium = results.slice(0, 3);
  // Display order P2, P1, P3 like a real podium.
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  const start = parseStart(round);
  const other = resultSeason.id !== selectedSeason.id;

  return `<section class="section container" aria-labelledby="latestTitle">
    <div class="section-head">
      <div>
        <p class="kicker">${other ? `${esc(resultSeason.label)} · ` : ""}Latest result · Round ${esc(round.round)}</p>
        <h2 class="section-title" id="latestTitle">${flag(round.country)} ${esc(roundTitle(round))}</h2>
      </div>
      <a class="more-link" href="${link("results/", { season: resultSeason.id, round: round.round })}">Full classification</a>
    </div>
    <div class="podium">
      ${order
        .map((res) => {
          const row = byId.get(res.id);
          const driver = league.drivers.get(res.id);
          return `<article class="podium__card podium__card--p${res.position} card" style="--team:${esc(teamColor(league, res.team))}">
            <p class="podium__pos">${res.position}<span>${res.position === 1 ? "st" : res.position === 2 ? "nd" : "rd"}</span></p>
            <h3 class="podium__name"><a href="${link("drivers/", { id: res.id })}">${esc(driver.name)}</a></h3>
            <p class="podium__team">${esc(res.team || "")}</p>
            <p class="podium__pts"><strong>+${pointsFor(league, res)}</strong> pts${res.fastestLap ? ' · <span class="fl-badge">Fastest lap</span>' : ""}</p>
            <p class="podium__season muted">${row ? `${esc(ordinal(row.rank))} in championship · ${row.points} pts` : ""}</p>
          </article>`;
        })
        .join("")}
    </div>
    <p class="note">${start ? esc(fmt.long(start)) + " · " : ""}${esc(round.circuit || "")}${results.length > 3 ? ` · Also scoring: ${results.slice(3).filter((r) => pointsFor(league, r) > 0).map((r) => `${esc(league.drivers.get(r.id).name)} P${r.position}`).join(", ") || "none"}` : ""}</p>
  </section>`;
}

function standingsSection(league, standingsSeason, selectedSeason, championSeason) {
  const table = standings(league, standingsSeason);
  const teams = teamStandings(league, standingsSeason);
  const other = standingsSeason.id !== selectedSeason.id;
  const final = standingsSeason.status === "complete";
  const champ = championSeason ? standings(league, championSeason).rows[0] : null;
  const champSummary = championSeason ? seasonSummary(league, championSeason) : null;

  return `<section class="section container" aria-labelledby="standingsTitle">
    <div class="section-head">
      <div>
        <p class="kicker">${esc(standingsSeason.label)} · ${final ? "Final" : `After round ${table.rounds.length}`}</p>
        <h2 class="section-title" id="standingsTitle">Driver standings</h2>
      </div>
      <a class="more-link" href="${link("standings/", { season: standingsSeason.id })}">Full standings</a>
    </div>
    ${other ? `<p class="home-note">${esc(selectedSeason.label)} standings appear after its first race. Showing ${esc(standingsSeason.label)}.</p>` : ""}
    <div class="home-standings">
      <div class="table-wrap">
        <table class="f1-table">
          <thead><tr><th scope="col" class="pos">Pos</th><th scope="col">Driver</th><th scope="col" class="hide-sm">Team</th><th scope="col" class="num hide-sm">Wins</th><th scope="col" class="num">Pts</th></tr></thead>
          <tbody>
            ${table.rows
              .slice(0, 5)
              .map((row) => `<tr>
                <td class="pos">${row.rank}</td>
                <td>${driverId(row)}</td>
                <td class="hide-sm">${teamChip(row.team, row.teamColor)}</td>
                <td class="num hide-sm">${row.wins}</td>
                <td class="num pts">${row.points}</td>
              </tr>`)
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="home-side">
        ${champ && nextRound(selectedSeason) ? `<article class="champ card band-dark">
          <p class="kicker">${esc(championSeason.label)} champion</p>
          <h3 class="champ__name"><a href="${link("drivers/", { id: champ.id })}">${esc(champ.name)}</a></h3>
          <div class="champ__stats">
            <div class="stat"><span class="stat__value">${champ.points}</span><span class="stat__label">Points</span></div>
            <div class="stat"><span class="stat__value">${champ.wins}/${champSummary.racesCompleted}</span><span class="stat__label">Wins</span></div>
            <div class="stat"><span class="stat__value">${signed(champ.points - (standings(league, championSeason).rows[1]?.points ?? champ.points))}</span><span class="stat__label">Margin</span></div>
          </div>
          <div class="fins champ__form" aria-label="Race by race finishes">${champ.positions.map((p) => finishChip(p)).join("")}</div>
        </article>` : ""}
        <article class="card team-mini">
          <h3 class="team-mini__title">Teams</h3>
          <ol class="team-mini__list">
            ${teams.rows
              .slice(0, 3)
              .map((t) => `<li style="--team:${esc(t.color)}"><span class="team-mini__pos">${t.rank}</span><span class="team-bar"></span><span class="team-mini__name">${esc(t.team)}</span><span class="team-mini__pts">${t.points}</span></li>`)
              .join("")}
          </ol>
          <a class="more-link" href="${link("standings/", { season: standingsSeason.id, view: "teams" })}">Team standings</a>
        </article>
      </div>
    </div>
  </section>`;
}

function scheduleSection(league, season) {
  const rounds = season.rounds.filter((r) => r.status !== "cancelled");
  const announced = rounds.filter((r) => !isTbd(r));
  return `<section class="section container" aria-labelledby="scheduleTitle">
    <div class="section-head">
      <div>
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
        <h2 class="section-title" id="scheduleTitle">Schedule</h2>
      </div>
      <a class="more-link" href="${link("schedule/")}">Full schedule</a>
    </div>
    ${announced.length
      ? `<div class="round-strip" role="list">${announced.map((r) => roundCard(league, r)).join("")}</div>`
      : `<div class="card empty-state"><h3>Calendar coming soon</h3><p>The ${esc(season.label)} rounds haven't been announced yet.</p></div>`}
  </section>`;
}

function roundCard(league, round) {
  const start = parseStart(round);
  const status = roundStatus(round);
  const winner = status === "complete" ? roundWinner(league, round) : null;
  const href = status === "complete" ? link("results/", { round: round.round }) : link("schedule/", {}) + `#round-${round.round}`;
  return `<a class="round-card card f1-corner${status === "complete" ? "" : " f1-corner--red"}" role="listitem" href="${href}">
    <span class="round-card__round">Round ${esc(round.round)}</span>
    <span class="round-card__date">${start ? `<strong>${esc(fmt.day(start))}</strong> ${esc(fmt.month(start))}` : "TBC"}</span>
    <span class="round-card__name">${flag(round.country)} ${esc(round.name)}</span>
    <span class="round-card__status">${
      winner
        ? `<span class="muted">Winner</span> <strong>${esc(winner.name)}</strong>`
        : status === "awaiting-results"
          ? '<span class="badge badge--red">Results pending</span>'
          : '<span class="badge">Upcoming</span>'
    }</span>
  </a>`;
}

function statsSection(league, statsSeason) {
  const s = seasonSummary(league, statsSeason);
  const tiles = [
    [s.racesCompleted, "Races", statsSeason.label],
    [s.drivers, "Drivers", "League entrants"],
    [s.distinctWinners, "Different winners", ""],
    s.mostWins ? [s.mostWins.wins, "Most wins", s.mostWins.name] : null,
    s.mostFastestLaps && s.mostFastestLaps.fastestLaps ? [s.mostFastestLaps.fastestLaps, "Most fastest laps", s.mostFastestLaps.name] : null,
    s.longestWinStreak ? [s.longestWinStreak.length, "Longest win streak", `${s.longestWinStreak.driver.name} · R${s.longestWinStreak.from}–R${s.longestWinStreak.to}`] : null,
  ].filter(Boolean);
  return `<section class="section container" aria-labelledby="statsTitle">
    <div class="section-head">
      <div><p class="kicker">${esc(statsSeason.label)}</p><h2 class="section-title" id="statsTitle">By the numbers</h2></div>
      <a class="more-link" href="${link("analytics/", { season: statsSeason.id })}">Analytics</a>
    </div>
    <div class="grid grid--3 stats-grid">
      ${tiles.map(([value, label, meta]) => `<div class="card stat-tile f1-corner"><div class="stat"><span class="stat__value">${esc(value)}</span><span class="stat__label">${esc(label)}</span></div>${meta ? `<p class="stat__meta">${esc(meta)}</p>` : ""}</div>`).join("")}
    </div>
  </section>`;
}
