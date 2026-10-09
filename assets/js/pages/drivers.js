import {
  standings, driverCareer, completedRounds, latestCompletedRound, teamColor, pointsFor,
} from "../league.js";
import { initPage, esc, link, flag, teamChip, finishChip, finishLegend, ordinal, roundTitle } from "../ui.js";

const NEUTRAL = "#8A8F98";
const INK = "#15151e";

const ctx = await initPage("drivers");
if (ctx) render(ctx);

function render({ league, season, params }) {
  const main = document.getElementById("main");
  if (!season) {
    main.innerHTML = `<div class="container"><div class="card empty-state"><h2>No seasons yet</h2><p>Add a season to data/league.json.</p></div></div>`;
    return;
  }
  const ref = params.get("id");
  if (ref === null) {
    renderGrid(main, league, season);
    return;
  }
  const id = league.resolveDriver(ref);
  if (id && league.drivers.has(id)) renderProfile(main, league, season, id);
  else renderNotFound(main, ref);
}

// ---------- Team colour helpers ----------

function luminance(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!match) return null;
  let h = match[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Text colour for a team-colour background that clears WCAG AA (4.5:1).
function textOn(color) {
  const bg = luminance(color);
  if (bg === null) return INK;
  const white = contrast(1, bg);
  const ink = contrast(luminance(INK), bg);
  if (Math.max(white, ink) >= 4.5) return white >= ink ? "#ffffff" : INK;
  // Mid-luminance colours: pure black or pure white always reaches 4.5:1.
  return white >= contrast(0, bg) ? "#ffffff" : "#000000";
}

function teamStyle(color) {
  const on = textOn(color);
  return `--team:${esc(color)};--on-team:${on};--stripe:${on === "#ffffff" ? "#000" : "#fff"}`;
}

function resultFor(league, round, id) {
  return (round.results || []).find((r) => league.resolveDriver(r.driver) === id) || null;
}

function latestTeam(league, id, seasons) {
  for (const season of seasons) {
    const rounds = completedRounds(season);
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      const result = resultFor(league, rounds[i], id);
      if (result && result.team) return result.team;
    }
  }
  return null;
}

function entryTeam(league, season, id) {
  const entry = (season.entries || []).find((e) => league.resolveDriver(e.driver) === id);
  return entry && entry.team ? entry.team : null;
}

// Team shown for a driver: latest in the selected season, then their entry,
// then the latest team they raced for anywhere (seasons are newest first).
function currentTeam(league, season, id) {
  return latestTeam(league, id, [season]) || entryTeam(league, season, id) || latestTeam(league, id, league.seasons);
}

function teamsInSeason(league, season, id) {
  const teams = [];
  for (const round of completedRounds(season)) {
    const result = resultFor(league, round, id);
    if (result && result.team && !teams.includes(result.team)) teams.push(result.team);
  }
  return teams;
}

function suffix(n) {
  return ordinal(n).replace(/^\d+/, "");
}

// ---------- Grid ----------

function renderGrid(main, league, season) {
  document.title = "Drivers — Slayter League";
  const table = standings(league, season);
  const byId = new Map(table.rows.map((row) => [row.id, row]));
  const entryOrder = (season.entries || []).map((e) => league.resolveDriver(e.driver)).filter(Boolean);
  const card = (driver) => {
    const team = currentTeam(league, season, driver.id);
    return { driver, team, row: byId.get(driver.id) || null, color: team ? teamColor(league, team) : NEUTRAL };
  };

  // This season's field: everyone entered or with a result. Ordered by the
  // championship once racing starts, by the entry list before that.
  const inSeason = (id) => byId.has(id) || entryOrder.includes(id);
  const all = Array.from(league.drivers.values());
  const field = all.filter((d) => inSeason(d.id)).map(card);
  field.sort((a, b) => {
    if (a.row && b.row) return a.row.rank - b.row.rank;
    if (a.row || b.row) return a.row ? -1 : 1;
    return entryOrder.indexOf(a.driver.id) - entryOrder.indexOf(b.driver.id);
  });
  const others = all
    .filter((d) => !inSeason(d.id))
    .map(card)
    .sort((a, b) => a.driver.name.localeCompare(b.driver.name, "en", { sensitivity: "base" }));
  // A season with no roster yet: show everyone in the main grid. Past seasons
  // only show their own field, not drivers who joined later.
  const main_ = field.length ? field : others;
  const rest = field.length && season.status !== "complete" ? others : [];

  const fallback = table.rounds.length ? null : league.seasons.find((s) => s.id !== season.id && latestCompletedRound(s));
  const lede = field.length
    ? `${field.length} drivers ${table.rounds.length ? `in the ${esc(season.label)} championship` : `entered for ${esc(season.label)}`}`
    : `${league.drivers.size} league drivers`;

  main.innerHTML = `<header class="page-head">
      <div class="container">
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
        <h1 class="title">${esc(season.label)} <em>Drivers</em></h1>
        <p class="lede">${lede}. Pick a driver for their season and career record.</p>
      </div>
    </header>
    <div class="container">
      ${table.rounds.length ? "" : `<div class="card drivers-notice">
        <p><strong>No ${esc(season.label)} races yet.</strong> ${field.length ? "Cards show each driver's team for this season;" : "Cards show each driver's most recent team;"} positions appear after Round 1.</p>
        ${fallback ? `<a class="more-link" href="${link("drivers/", { season: fallback.id })}">${esc(fallback.label)} drivers</a>` : ""}
      </div>`}
      <ul class="driver-grid" role="list">${main_.map((c) => driverCard(season, c, field.length > 0)).join("")}</ul>
      ${rest.length ? `<section class="section" aria-labelledby="otherDrivers">
        <div class="section-head"><h2 class="section-title" id="otherDrivers">Other league drivers</h2></div>
        <ul class="driver-grid" role="list">${rest.map((c) => driverCard(season, c, false)).join("")}</ul>
      </section>` : ""}
    </div>`;
}

function driverCard(season, { driver, team, row, color }, entered) {
  const code = driver.code || driver.name.slice(0, 3).toUpperCase();
  const standing = row
    ? `<span class="dcard__rank">${row.rank}<sup>${suffix(row.rank)}</sup></span><span class="dcard__pts">${row.points} <small>pts</small></span>`
    : `<span class="dcard__none">${entered ? `${esc(season.label)} entrant` : `Not racing in ${esc(season.label)}`}</span>`;
  return `<li>
    <a class="dcard" href="${link("drivers/", { id: driver.id })}" style="${teamStyle(color)}">
      <span class="dcard__code" aria-hidden="true">${esc(code)}</span>
      <span class="dcard__name">${esc(driver.name)}</span>
      <span class="dcard__team">${esc(team || "No team yet")}</span>
      <span class="dcard__standing">${standing}</span>
    </a>
  </li>`;
}

// ---------- Profile ----------

function renderProfile(main, league, season, id) {
  const driver = league.drivers.get(id);
  const table = standings(league, season);
  const row = table.rows.find((r) => r.id === id) || null;
  const career = driverCareer(league, id);
  const team = currentTeam(league, season, id);
  const color = team ? teamColor(league, team) : NEUTRAL;
  document.title = `${driver.name} — Slayter League`;

  const body = row
    ? [
        seasonOverview(season, table, row),
        raceByRace(league, season, table, id),
        careerSection(league, season, career, id),
      ]
    : [noStarts(season, driver, career, table), careerSection(league, season, career, id)];

  main.innerHTML = `${profileHero(season, driver, row, team, color, career)}<div class="container">${body.join("")}</div>`;

  if (row) mountChart(document.getElementById("pointsChart"), chartPoints(table, row), season);
}

function profileHero(season, driver, row, team, color, career) {
  const code = driver.code || driver.name.slice(0, 3).toUpperCase();
  const titles = career.seasons.filter((s) => s.champion);
  const final = season.status === "complete";
  return `<section class="dhero band-dark" style="${teamStyle(color)}">
    <div class="dhero__stripes" aria-hidden="true"></div>
    <div class="container dhero__inner">
      <a class="dhero__back" href="${link("drivers/")}">All drivers</a>
      <div class="dhero__main">
        <span class="dhero__plate" aria-hidden="true">${esc(code)}</span>
        <div class="dhero__id">
          <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
          <h1 class="dhero__name">${esc(driver.name)}</h1>
          <p class="dhero__team"><span class="team-bar"></span>${esc(team || "No team yet")}<span class="dhero__code">${esc(code)}</span></p>
          ${titles.length ? `<div class="dhero__badges">${titles.map((s) => `<span class="badge badge--red">${esc(s.season.label)} champion</span>`).join("")}</div>` : ""}
        </div>
        <div class="dhero__standing">
          ${row
            ? `<p class="dhero__pos">${row.rank}<sup>${suffix(row.rank)}</sup></p>
               <p class="dhero__pos-label">${esc(season.label)} ${final ? "final position" : "championship"} · ${row.points} pts</p>`
            : `<p class="dhero__pos-label dhero__pos-label--none">No starts in ${esc(season.label)}</p>
               ${career.seasons[0] ? `<p class="dhero__pos-label">Last raced ${esc(career.seasons[0].season.label)} · ${esc(ordinal(career.seasons[0].row.rank))}</p>` : ""}`}
        </div>
      </div>
    </div>
  </section>`;
}

function statTile(label, value, meta = "") {
  return `<div class="card stat-tile f1-corner"><div class="stat"><span class="stat__value">${esc(value)}</span><span class="stat__label">${esc(label)}</span></div>${meta ? `<p class="stat__meta">${esc(meta)}</p>` : ""}</div>`;
}

function seasonOverview(season, table, row) {
  const second = table.rows[1];
  const pointsMeta = row.rank === 1
    ? second ? `${row.points - second.points} clear of ${ordinal(2)}` : ""
    : `${Math.abs(row.gap)} behind the leader`;
  const bestCount = row.finishCounts[row.bestFinish] || 0;
  const tiles = [
    statTile("Position", ordinal(row.rank), `of ${table.rows.length} drivers`),
    statTile("Points", row.points, pointsMeta),
    statTile("Wins", row.wins),
    statTile("Podiums", row.podiums),
    statTile("Fastest laps", row.fastestLaps),
    statTile("Starts", row.starts, `of ${table.rounds.length} ${table.rounds.length === 1 ? "race" : "races"}`),
    statTile("Best finish", `P${row.bestFinish}`, bestCount > 1 ? `${bestCount} times` : "once"),
    statTile("Avg finish", row.avgFinish.toFixed(1)),
  ];
  return `<section class="section" aria-labelledby="seasonTitle">
    <div class="section-head">
      <div>
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
        <h2 class="section-title" id="seasonTitle">Season stats</h2>
      </div>
    </div>
    <div class="overview">
      <div class="dstats">${tiles.join("")}</div>
      <figure class="card chart-card">
        <figcaption class="chart-card__head">
          <span class="chart-card__title">Points progression</span>
          <span class="chart-card__sub">Cumulative points after each round</span>
        </figcaption>
        <div class="chart" id="pointsChart"></div>
      </figure>
    </div>
  </section>`;
}

function chartPoints(table, row) {
  return table.rounds.map((round, i) => ({
    round: round.round,
    name: round.name,
    total: row.cumulative[i],
    gained: row.roundPoints[i],
    position: row.positions[i],
  }));
}

function raceByRace(league, season, table, id) {
  const row = table.rows.find((r) => r.id === id);
  let previousRank = null;
  const rows = table.rounds.map((round, i) => {
    const result = resultFor(league, round, id);
    const after = standings(league, season, { throughRound: round.round }).rows.find((r) => r.id === id);
    const rank = after ? after.rank : null;
    const move = rank !== null && previousRank !== null ? previousRank - rank : 0;
    previousRank = rank ?? previousRank;
    const finish = result
      ? `${finishChip(result.position, { fastestLap: Boolean(result.fastestLap) })}${result.fastestLap ? '<span class="sr-only">, fastest lap</span>' : ""}`
      : '<span class="fin fin--dns dns" title="Did not start">DNS</span>';
    return `<tr${result ? "" : ' class="is-dns"'}>
      <td class="pos">${esc(round.round)}</td>
      <td><a class="gp" href="${link("results/", { round: round.round })}">${flag(round.country)}<span class="gp__long">${esc(roundTitle(round))}</span><span class="gp__short">${esc(round.name)}</span></a></td>
      <td class="hide-sm">${result ? teamChip(result.team, teamColor(league, result.team)) : '<span class="muted">—</span>'}</td>
      <td>${finish}</td>
      <td class="num">${result ? pointsFor(league, result) : '<span class="muted">—</span>'}</td>
      <td class="num pts">${row.cumulative[i]}</td>
      <td class="num">${rank === null ? '<span class="muted">—</span>' : `${rank}${moveMarkup(move)}`}</td>
    </tr>`;
  });

  return `<section class="section" aria-labelledby="racesTitle">
    <div class="section-head">
      <div>
        <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
        <h2 class="section-title" id="racesTitle">Race by race</h2>
      </div>
      <a class="more-link" href="${link("standings/")}">Standings</a>
    </div>
    <div class="table-wrap">
      <table class="f1-table race-table">
        <thead><tr>
          <th scope="col" class="pos"><abbr title="Round">Rd</abbr></th>
          <th scope="col">Grand Prix</th>
          <th scope="col" class="hide-sm">Team</th>
          <th scope="col">Finish</th>
          <th scope="col" class="num">Pts</th>
          <th scope="col" class="num">Total</th>
          <th scope="col" class="num"><abbr title="Championship position after the round">Champ</abbr></th>
        </tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
    ${finishLegend()}
  </section>`;
}

function moveMarkup(move) {
  if (!move) return "";
  const up = move > 0;
  const places = Math.abs(move);
  return ` <span class="move move--${up ? "up" : "down"}" title="${up ? "Up" : "Down"} ${places}"><span class="sr-only">${up ? "up" : "down"} </span>${places}</span>`;
}

function noStarts(season, driver, career, table) {
  const last = career.seasons[0];
  return `<section class="section">
    <div class="card drivers-notice drivers-notice--profile">
      <div>
        <h2 class="drivers-notice__title">No starts in ${esc(season.label)}</h2>
        <p>${table.rounds.length
          ? `${esc(driver.name)} hasn't raced in ${esc(season.label)}.`
          : `No ${esc(season.label)} races have been run yet.`} ${career.seasons.length ? "Showing their career record instead." : ""}</p>
      </div>
      ${last ? `<a class="btn" href="${link("drivers/", { id: driver.id, season: last.season.id })}">${esc(last.season.label)} record</a>` : ""}
    </div>
  </section>`;
}

function careerSection(league, selectedSeason, career, id) {
  const t = career.totals;
  if (!career.seasons.length) {
    return `<section class="section" aria-labelledby="careerTitle">
      <div class="section-head"><div><p class="kicker">All seasons</p><h2 class="section-title" id="careerTitle">Career</h2></div></div>
      <div class="card empty-state"><h3>No starts yet</h3><p>Career stats appear after this driver's first race.</p></div>
    </section>`;
  }
  const tiles = [
    statTile("Titles", t.titles),
    statTile("Starts", t.starts),
    statTile("Wins", t.wins),
    statTile("Podiums", t.podiums),
    statTile("Fastest laps", t.fastestLaps),
    statTile("Points", t.points),
    statTile("Best finish", t.bestFinish === null ? "—" : `P${t.bestFinish}`),
  ];
  return `<section class="section" aria-labelledby="careerTitle">
    <div class="section-head">
      <div>
        <p class="kicker">All seasons</p>
        <h2 class="section-title" id="careerTitle">Career</h2>
      </div>
    </div>
    <div class="dstats dstats--career">${tiles.join("")}</div>
    <div class="table-wrap career-table">
      <table class="f1-table">
        <thead><tr>
          <th scope="col">Season</th>
          <th scope="col">Team</th>
          <th scope="col" class="num">Pos</th>
          <th scope="col" class="num">Pts</th>
          <th scope="col" class="num">Wins</th>
          <th scope="col" class="num hide-sm">Podiums</th>
        </tr></thead>
        <tbody>
          ${career.seasons
            .map(({ season, row, champion }) => `<tr${season.id === selectedSeason.id ? ' class="is-current"' : ""}>
              <th scope="row"><span class="career-season">
                <a href="${link("drivers/", { id, season: season.id })}">${esc(season.label)}</a>
                <span class="career-season__meta"><span class="muted">${esc(season.year)}</span>${champion ? '<span class="badge badge--red">Champion</span>' : season.status === "complete" ? "" : '<span class="badge">In progress</span>'}</span>
              </span></th>
              <td><span class="career-teams">${teamsInSeason(league, season, id).map((team) => teamChip(team, teamColor(league, team))).join("")}</span></td>
              <td class="num">${esc(ordinal(row.rank))}</td>
              <td class="num pts">${row.points}</td>
              <td class="num">${row.wins}</td>
              <td class="num hide-sm">${row.podiums}</td>
            </tr>`)
            .join("")}
        </tbody>
      </table>
    </div>
  </section>`;
}

function renderNotFound(main, ref) {
  document.title = "Driver not found — Slayter League";
  main.innerHTML = `<header class="page-head">
      <div class="container">
        <p class="kicker">Drivers</p>
        <h1 class="title">Driver not found</h1>
      </div>
    </header>
    <div class="container">
      <section class="card empty-state drivers-missing">
        <h2>No driver matches “${esc(ref)}”</h2>
        <p>The link may be out of date, or the driver may have changed their name. Every league driver is on the drivers page.</p>
        <div class="btn-row"><a class="btn" href="${link("drivers/")}">All drivers</a></div>
      </section>
    </div>`;
}

// ---------- Points progression chart (inline SVG, no library) ----------

function niceScale(maxValue, target = 4) {
  const raw = Math.max(maxValue, 1) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => raw <= s));
  const max = Math.ceil(maxValue / step) * step || step;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return { max, ticks };
}

function mountChart(el, points, season) {
  if (!el || !points.length) return;
  el.tabIndex = 0;
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Points progression chart. Use the left and right arrow keys to read each round.");
  let active = null;
  let geometry = null;

  const tooltip = document.createElement("div");
  tooltip.className = "chart__tip";
  tooltip.setAttribute("role", "status");
  tooltip.hidden = true;

  const draw = () => {
    const width = Math.max(260, Math.round(el.clientWidth));
    const height = width < 480 ? 220 : 236;
    const m = { top: 28, right: 18, bottom: 46, left: 50 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;
    const { max, ticks } = niceScale(Math.max(...points.map((p) => p.total)));
    const n = points.length;
    const x = (i) => m.left + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = (v) => m.top + ih - (v / max) * ih;
    geometry = { x, y, m, iw, ih, width, height, n };

    // Thin out round labels so they stay at least ~30px apart.
    const every = Math.max(1, Math.ceil(30 / (n > 1 ? iw / (n - 1) : iw)));
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join("");
    const area = `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
    const last = points[n - 1];
    const desc = points.map((p) => `R${p.round} ${p.name}: ${p.total}`).join("; ");

    el.innerHTML = `<svg class="chart__svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chartTitle chartDesc">
      <title id="chartTitle">${esc(season.label)} points progression</title>
      <desc id="chartDesc">Cumulative points after each round. ${esc(desc)}.</desc>
      <g class="chart__grid">
        ${ticks.map((t) => `<line x1="${m.left}" x2="${width - m.right}" y1="${y(t)}" y2="${y(t)}"></line>`).join("")}
      </g>
      <g class="chart__axis chart__axis--y">
        ${ticks.map((t) => `<text x="${m.left - 10}" y="${y(t)}" dy="0.32em" text-anchor="end">${t}</text>`).join("")}
        <text class="chart__axis-title" transform="translate(14 ${m.top + ih / 2}) rotate(-90)" text-anchor="middle">Points</text>
      </g>
      <g class="chart__axis chart__axis--x">
        ${points.map((p, i) => (i % every === 0 || i === n - 1 ? `<text x="${x(i)}" y="${m.top + ih + 20}" text-anchor="middle">R${esc(p.round)}</text>` : "")).join("")}
        <text class="chart__axis-title" x="${m.left + iw / 2}" y="${height - 4}" text-anchor="middle">Round</text>
      </g>
      ${n > 1 ? `<path class="chart__area" d="${area}"></path><path class="chart__line" d="${line}"></path>` : ""}
      <line class="chart__cross" x1="0" x2="0" y1="${m.top}" y2="${m.top + ih}" visibility="hidden"></line>
      <g class="chart__dots">
        ${points.map((p, i) => `<circle class="chart__dot${p.position === null ? " chart__dot--dns" : ""}" cx="${x(i)}" cy="${y(p.total)}" r="4"></circle>`).join("")}
      </g>
      <text class="chart__end" x="${x(n - 1) - 10}" y="${y(last.total) - 12}" text-anchor="end">${last.total} pts</text>
    </svg>`;
    el.append(tooltip);
    if (active !== null) show(active);
  };

  const show = (index) => {
    active = Math.max(0, Math.min(points.length - 1, index));
    const p = points[active];
    const { x, y, width } = geometry;
    const cross = el.querySelector(".chart__cross");
    cross.setAttribute("x1", x(active));
    cross.setAttribute("x2", x(active));
    cross.setAttribute("visibility", "visible");
    el.querySelectorAll(".chart__dot").forEach((dot, i) => dot.classList.toggle("is-active", i === active));

    tooltip.replaceChildren();
    const value = document.createElement("strong");
    value.textContent = `${p.total} pts`;
    const where = document.createElement("span");
    where.textContent = `R${p.round} · ${p.name}`;
    const detail = document.createElement("span");
    detail.textContent = p.position === null ? "Did not start" : `P${p.position} · +${p.gained} pts`;
    tooltip.append(value, where, detail);
    tooltip.hidden = false;

    // Keep the tooltip inside the chart: flip to the left of the point near the right edge.
    const left = x(active);
    const flip = left > width - 150;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(0, y(p.total) - 12)}px`;
    tooltip.classList.toggle("chart__tip--left", flip);
  };

  const hide = () => {
    active = null;
    tooltip.hidden = true;
    const cross = el.querySelector(".chart__cross");
    if (cross) cross.setAttribute("visibility", "hidden");
    el.querySelectorAll(".chart__dot.is-active").forEach((dot) => dot.classList.remove("is-active"));
  };

  el.addEventListener("pointermove", (event) => {
    if (!geometry) return;
    const { m, iw, n } = geometry;
    const px = event.clientX - el.getBoundingClientRect().left;
    const index = n === 1 ? 0 : Math.round(((px - m.left) / iw) * (n - 1));
    show(index);
  });
  el.addEventListener("pointerleave", () => {
    if (document.activeElement !== el) hide();
  });
  el.addEventListener("focus", () => show(active ?? points.length - 1));
  el.addEventListener("blur", hide);
  el.addEventListener("keydown", (event) => {
    const keys = { ArrowLeft: -1, ArrowRight: 1 };
    if (event.key in keys) show((active ?? points.length - 1) + keys[event.key]);
    else if (event.key === "Home") show(0);
    else if (event.key === "End") show(points.length - 1);
    else return;
    event.preventDefault();
  });

  let lastWidth = 0;
  new ResizeObserver(() => {
    const width = Math.round(el.clientWidth);
    if (width !== lastWidth) {
      lastWidth = width;
      draw();
    }
  }).observe(el);
}
