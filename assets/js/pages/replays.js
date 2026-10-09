import {
  parseVideo, parseStart, roundStatus, roundWinner, latestCompletedRound, nextRound, teamColor, pointsFor,
} from "../league.js";
import { initPage, esc, link, flag, countryName, driverId, roundTitle, isTbd, fmt } from "../ui.js";

// Spaced so it reads right inline; flex rows drop the spaces and use their gap.
const SEP = ' <span class="rp-sep" aria-hidden="true">·</span> ';

// Same glyph as the shared "Replay" pill in ui.js.
const PLAY_ICON = `<svg class="btn-replay__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>`;
const PLAY_GLYPH = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>`;
const PLAY_MARK = `<svg class="rp-mark" viewBox="0 0 120 120" aria-hidden="true">
  <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="2"/>
  <circle cx="60" cy="60" r="50" fill="none" stroke="#e10600" stroke-opacity=".45" stroke-width="2" stroke-dasharray="4 7"/>
  <circle cx="60" cy="60" r="42" fill="#e10600"/>
  <path d="M51 41v38l31-19z" fill="#fff"/>
</svg>`;
const EXTERNAL = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 2h5v5M14 2 7.5 8.5M12 10v4H2V4h4"/></svg>`;
const CHEVRON = {
  prev: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>',
  next: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>',
};

// Friendlier names for hosts that can't be embedded.
const HOSTS = {
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "twitch.tv": "Twitch",
  "kick.com": "Kick",
  "vimeo.com": "Vimeo",
  "streamable.com": "Streamable",
  "drive.google.com": "Google Drive",
};

const ctx = await initPage("replays");
if (ctx) render(ctx);

function render({ league, season, params }) {
  const main = document.getElementById("main");
  if (!season) {
    main.innerHTML = `<div class="container"><div class="card empty-state"><h2>No seasons yet</h2><p>Add a season to data/league.json.</p></div></div>`;
    return;
  }

  const roundParam = params.get("round");
  if (roundParam === null || roundParam === "") {
    const rounds = replayRounds(season);
    document.title = `${season.label} replays — Slayter League`;
    main.innerHTML = rounds.length ? galleryView(league, season, rounds) : comingSoonView(league, season);
  } else {
    const n = /^\d+$/.test(roundParam) ? Number(roundParam) : NaN;
    const round = season.rounds.find((r) => r.round === n);
    const video = videoOf(round);
    if (!round) {
      document.title = "Race not found — Slayter League";
      main.innerHTML = notFoundView(season, roundParam);
    } else if (!video) {
      document.title = `${roundTitle(round)} replay coming soon — Slayter League`;
      main.innerHTML = noReplayView(league, season, round);
    } else {
      document.title = `${roundTitle(round)} replay — Slayter League`;
      main.innerHTML = playerView(league, season, round, video);
    }
  }
  wireThumbs(main);
}

// ---------- Helpers ----------

function videoOf(round) {
  return round && round.replay ? parseVideo(round.replay) : null;
}

function replayRounds(season) {
  return season.rounds.filter((r) => videoOf(r));
}

function hostName(video) {
  if (video.kind === "youtube") return "YouTube";
  if (video.kind === "twitch") return "Twitch";
  return HOSTS[video.host] || video.host;
}

// Season value for a link into another season; the default season needs none.
function seasonParam(league, season) {
  return league.currentSeason && season.id === league.currentSeason.id ? null : season.id;
}

function isRaced(round) {
  const status = roundStatus(round);
  return status === "complete" || status === "awaiting-results";
}

function dateTag(round, format = fmt.short) {
  const start = parseStart(round);
  return start ? `<time datetime="${esc(start.toISOString())}">${esc(format(start))}</time>` : "Date TBC";
}

function externalLink(video, text, cls = "") {
  return `<a${cls ? ` class="${cls}"` : ""} href="${esc(video.url)}" target="_blank" rel="noopener">${esc(text)} ${EXTERNAL}<span class="sr-only"> (opens in a new tab)</span></a>`;
}

// YouTube thumbnails sit over a carbon placeholder; if one fails to load the placeholder shows.
function wireThumbs(root) {
  root.querySelectorAll("img[data-thumb]").forEach((img) => {
    img.addEventListener("error", () => img.remove(), { once: true });
  });
}

function thumb(round, video) {
  const host = hostName(video);
  const img = video.kind === "youtube"
    ? `<img data-thumb src="https://i.ytimg.com/vi/${esc(video.id)}/hqdefault.jpg" alt="Thumbnail for the ${esc(roundTitle(round))} replay" width="480" height="360" loading="lazy">`
    : "";
  return `<span class="rp-thumb rp-thumb--${esc(video.kind)}">
    <span class="rp-thumb__ph" aria-hidden="true"><span class="rp-thumb__round">R${esc(round.round)}</span></span>
    ${img}
    <span class="rp-thumb__play" aria-hidden="true">${PLAY_GLYPH}</span>
    <span class="rp-thumb__tag">${esc(host)}</span>
  </span>`;
}

function winnerLine(league, round) {
  if (roundStatus(round) !== "complete") return '<span class="rp-winner muted">Results pending</span>';
  const winner = roundWinner(league, round);
  if (!winner) return '<span class="rp-winner muted" title="No league driver won this race">AI winner</span>';
  const result = round.results.find((r) => r.position === 1);
  const row = { id: winner.id, name: winner.name, code: winner.code, teamColor: teamColor(league, result.team) };
  return `<span class="rp-winner"><span class="rp-winner__label">Winner</span>${driverId(row, { link: false, code: false })}</span>`;
}

function statusChip(round) {
  const status = roundStatus(round);
  if (videoOf(round)) return '<span class="rp-chip rp-chip--live">Replay available</span>';
  if (status === "cancelled") return '<span class="rp-chip rp-chip--off">Cancelled</span>';
  if (status === "scheduled") return '<span class="rp-chip">Upcoming race</span>';
  return '<span class="rp-chip rp-chip--soon">Replay coming soon</span>';
}

// Small round card: raced rounds open their results, the rest the schedule.
function roundCard(round) {
  const status = roundStatus(round);
  const href = isRaced(round) ? link("results/", { round: round.round }) : `${link("schedule/")}#round-${round.round}`;
  return `<li><a class="rp-round card rp-round--${esc(status)}" href="${href}">
    <span class="rp-round__top"><span class="rp-round__num">Round ${esc(round.round)}</span><span class="rp-round__date">${dateTag(round)}</span></span>
    <span class="rp-round__name">${flag(round.country)}<span>${esc(roundTitle(round))}</span></span>
    ${statusChip(round)}
  </a></li>`;
}

function replayCard(league, round) {
  return `<li><a class="rp-card card" href="${link("replays/", { round: round.round })}">
    ${thumb(round, videoOf(round))}
    <span class="rp-card__body">
      <span class="rp-card__meta">Round ${esc(round.round)}${SEP}${dateTag(round)}</span>
      <h3 class="rp-card__title">${flag(round.country)}<span>${esc(roundTitle(round))}</span></h3>
      <span class="rp-card__foot">${winnerLine(league, round)}<span class="btn-replay btn-replay--compact" aria-hidden="true">${PLAY_ICON}<span>Watch</span></span></span>
    </span>
  </a></li>`;
}

// Decorative "player" used while no replay exists.
function screenMock(caption) {
  return `<div class="rp-screen rp-screen--mock" aria-hidden="true">
    <span class="rp-screen__tag">Replay</span>
    <span class="rp-screen__soon">Coming soon</span>
    ${PLAY_MARK}
    <span class="rp-screen__caption">${esc(caption)}</span>
    <span class="rp-screen__bar"></span>
    <span class="rp-screen__time">00:00 / --:--</span>
  </div>`;
}

// ---------- No replays in the season: coming soon ----------

function comingSoonView(league, season) {
  const other = league.seasons.find((s) => s.id !== season.id && replayRounds(s).length);
  const otherCount = other ? replayRounds(other).length : 0;
  const resultsSeason = latestCompletedRound(season) ? season : league.seasons.find((s) => latestCompletedRound(s));
  const resultsHref = resultsSeason
    ? link("results/", { season: seasonParam(league, resultsSeason), round: latestCompletedRound(resultsSeason).round })
    : link("results/");
  const finished = season.status === "complete";
  const next = finished ? null : nextRound(season);
  const count = season.rounds.filter((r) => r.status !== "cancelled").length;
  const caption = next && !isTbd(next)
    ? `Next race · ${roundTitle(next)} · ${parseStart(next) ? fmt.short(parseStart(next)) : "Date TBC"}`
    : `${season.label} · ${count} ${count === 1 ? "round" : "rounds"}`;

  const hero = `<section class="rp-hero band-dark">
    <div class="speed-stripes" aria-hidden="true"></div>
    <div class="container rp-hero__inner">
      <div class="rp-hero__copy">
        <p class="kicker">${esc(season.label)} · Race replays</p>
        <h1 class="rp-hero__title">Race replays <em>Coming soon</em></h1>
        <p class="lede">${finished
          ? `Full-race videos of the ${esc(season.label)} rounds will be posted here as they're uploaded.`
          : "Full-race videos of every Slayter League round will be posted here after each race."} A <strong>Replay</strong> button will appear next to races that have one.</p>
        <div class="btn-row rp-hero__actions">
          <a class="btn" href="${link("schedule/")}">Season schedule</a>
          <a class="btn btn--ghost" href="${resultsHref}">Latest results</a>
        </div>
        ${other
          ? `<p class="rp-hero__other"><a class="btn-replay" href="${link("replays/", { season: seasonParam(league, other) })}">${PLAY_ICON}<span>${esc(other.label)} replays</span></a><span>${otherCount} ${otherCount === 1 ? "race" : "races"} ready to watch</span></p>`
          : ""}
      </div>
      <div class="rp-hero__visual">${screenMock(caption)}</div>
    </div>
  </section>`;

  return `${hero}
    <section class="section container" aria-labelledby="rpScheduleTitle">
      <div class="section-head">
        <div>
          <p class="kicker">${esc(season.label)} · ${esc(season.year)}</p>
          <h2 class="section-title" id="rpScheduleTitle">Replay schedule</h2>
        </div>
        <a class="more-link" href="${link("schedule/")}">Full schedule</a>
      </div>
      ${season.rounds.length
        ? `<ol class="rp-rounds" role="list">${season.rounds.map((r) => roundCard(r)).join("")}</ol>
          <p class="note">Each race's replay goes up after the race. Until then, completed races link to their results.</p>`
        : `<div class="card empty-state"><h3>Calendar coming soon</h3><p>The ${esc(season.label)} rounds haven't been announced yet.</p></div>`}
    </section>`;
}

// ---------- Some replays: gallery ----------

function galleryView(league, season, rounds) {
  const [latest, ...earlier] = rounds.slice().reverse();
  // Raced rounds still waiting for a video, then (mid-season) the races still to run.
  const waiting = season.rounds.filter((r) => !videoOf(r) && r.status !== "cancelled");
  const upcoming = waiting.some((r) => !isRaced(r));
  const raced = season.rounds.filter(isRaced).length;

  return `<section class="rp-hero rp-hero--gallery band-dark">
      <div class="speed-stripes" aria-hidden="true"></div>
      <div class="container rp-hero__inner">
        <div class="rp-hero__copy">
          <p class="kicker">${esc(season.label)} · Race replays</p>
          <h1 class="rp-hero__title">Race <em>replays</em></h1>
          <p class="lede">Every race in full, from lights out to the chequered flag. ${rounds.length} of ${raced} ${raced === 1 ? "race" : "races"} ${rounds.length === 1 ? "is" : "are"} ready to watch.</p>
          <div class="btn-row rp-hero__actions">
            <a class="btn" href="${link("replays/", { round: latest.round })}">${PLAY_GLYPH}<span>Watch latest</span></a>
            <a class="btn btn--ghost" href="${link("results/")}">${esc(season.label)} results</a>
          </div>
        </div>
        <div class="rp-hero__visual">
          <a class="rp-feature" href="${link("replays/", { round: latest.round })}">
            ${thumb(latest, videoOf(latest))}
            <span class="rp-feature__body">
              <span class="rp-feature__label">Latest replay · Round ${esc(latest.round)}</span>
              <span class="rp-feature__title">${flag(latest.country)}<span>${esc(roundTitle(latest))}</span></span>
              <span class="rp-feature__meta">${dateTag(latest, fmt.long)}${latest.circuit ? `${SEP}${esc(latest.circuit)}` : ""}</span>
              ${winnerLine(league, latest)}
            </span>
          </a>
        </div>
      </div>
    </section>
    ${earlier.length
      ? `<section class="section container" aria-labelledby="rpAllTitle">
          <div class="section-head">
            <div>
              <p class="kicker">${esc(season.label)} · Newest first</p>
              <h2 class="section-title" id="rpAllTitle">Earlier replays</h2>
            </div>
          </div>
          <ul class="rp-grid" role="list">${earlier.map((r) => replayCard(league, r)).join("")}</ul>
        </section>`
      : ""}
    ${waiting.length
      ? `<section class="section container" aria-labelledby="rpWaitingTitle">
          <div class="section-head">
            <div>
              <p class="kicker">${esc(season.label)} · On the way</p>
              <h2 class="section-title" id="rpWaitingTitle">${upcoming ? "Coming soon" : "Replay coming soon"}</h2>
            </div>
            ${upcoming
              ? `<a class="more-link" href="${link("schedule/")}">Full schedule</a>`
              : `<a class="more-link" href="${link("results/")}">All results</a>`}
          </div>
          <ol class="rp-rounds rp-rounds--compact" role="list">${waiting.map((r) => roundCard(r)).join("")}</ol>
        </section>`
      : ""}`;
}

// ---------- One round ----------

function stageHead(season, round, label = "") {
  const country = round.country ? countryName(round.country) : "";
  return `<div class="rp-stage__head">
    <a class="rp-back" href="${link("replays/")}">${CHEVRON.prev}<span>All replays</span></a>
    <p class="kicker">${esc(season.label)} · Round ${esc(round.round)} of ${season.rounds.length}${label ? ` · ${esc(label)}` : ""}</p>
    <h1 class="rp-stage__title">${esc(roundTitle(round))}</h1>
    ${isTbd(round)
      ? '<p class="rp-stage__meta">Venue and date to be announced.</p>'
      : `<p class="rp-stage__meta">${country ? `<span class="rp-stage__place">${flag(round.country, country)}<span>${esc(country)}</span></span>${SEP}` : ""}${round.circuit ? `<span>${esc(round.circuit)}</span>${SEP}` : ""}<span>${dateTag(round, fmt.long)}</span></p>`}
  </div>`;
}

function player(round, video) {
  const title = `${roundTitle(round)} replay`;
  if (video.kind === "youtube") {
    const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?rel=0&start=${Math.max(0, video.start)}`;
    return `<div class="rp-player"><iframe src="${esc(src)}" title="${esc(title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  }
  if (video.kind === "twitch") {
    // Twitch only plays when `parent` names the page's own host.
    const src = `https://player.twitch.tv/?video=v${encodeURIComponent(video.id)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=false`;
    return `<div class="rp-player"><iframe src="${esc(src)}" title="${esc(title)}" allowfullscreen loading="lazy"></iframe></div>`;
  }
  const host = hostName(video);
  return `<div class="rp-player rp-player--link">
    <div class="rp-screen">
      <div class="rp-screen__body">
        <a class="rp-screen__mark" href="${esc(video.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${PLAY_MARK}</a>
        <p class="rp-screen__text">This replay is hosted on ${esc(host)}.</p>
        ${externalLink(video, `Watch on ${host}`, "btn")}
      </div>
    </div>
  </div>`;
}

// Timing-tower style top 10 of the league drivers in this race.
function tower(league, round) {
  const results = (round.results || []).slice().sort((a, b) => a.position - b.position).slice(0, 10);
  const head = `<div class="rp-tower__head">
    <p class="rp-tower__kicker">Race result</p>
    <h2 class="rp-tower__title" id="rpTowerTitle">${(round.results || []).length > 10 ? "Top 10 league finishers" : "League finishers"}</h2>
  </div>`;
  if (!results.length) {
    return `<section class="rp-tower" aria-labelledby="rpTowerTitle">${head}
      <p class="rp-tower__empty">Results for this race haven't been entered yet. The classification appears here once they're in.</p>
      <a class="more-link" href="${link("results/", { round: round.round })}">Race page</a>
    </section>`;
  }
  const rows = results.map((res) => {
    const id = league.resolveDriver(res.driver);
    const driver = league.drivers.get(id);
    const color = teamColor(league, res.team);
    const who = driver
      ? driverId({ id, name: driver.name, code: driver.code, teamColor: color }, { code: false })
      : driverId({ name: res.driver, teamColor: color }, { link: false, code: false });
    const posClass = res.position === 1 ? " rp-tower__pos--win" : res.position <= 3 ? " rp-tower__pos--podium" : "";
    return `<tr>
      <td class="rp-tower__pos${posClass}"><span>${esc(res.position)}</span></td>
      <td>
        <span class="rp-tower__line">${who}${res.fastestLap ? '<span class="rp-tower__fl" title="Fastest lap"><span class="sr-only">Fastest lap</span></span>' : ""}</span>
        <span class="rp-tower__team">${esc(res.team || "—")}</span>
      </td>
      <td class="rp-tower__pts">${pointsFor(league, res)}</td>
    </tr>`;
  });
  return `<section class="rp-tower" aria-labelledby="rpTowerTitle">${head}
    <table class="rp-tower__table">
      <thead><tr><th scope="col" class="rp-tower__pos">Pos</th><th scope="col">Driver</th><th scope="col" class="rp-tower__pts">Pts</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <p class="rp-tower__note">League drivers only. Gaps in positions are AI cars.</p>
    <a class="more-link" href="${link("results/", { round: round.round })}">Full classification</a>
  </section>`;
}

function steps(season, round) {
  const all = replayRounds(season);
  const index = all.findIndex((r) => r.round === round.round);
  const prev = all[index - 1];
  const next = all[index + 1];
  if (!prev && !next) return "";
  const step = (target, dir) => {
    const label = dir === "prev" ? "Previous replay" : "Next replay";
    if (!target) {
      return `<span class="rp-step rp-step--${dir}" aria-disabled="true"><span class="rp-step__dir">${label}</span><span class="rp-step__name">${dir === "prev" ? "None earlier" : "None later"}</span></span>`;
    }
    return `<a class="rp-step rp-step--${dir}" href="${link("replays/", { round: target.round })}" rel="${dir}">
      <span class="rp-step__dir">${dir === "prev" ? CHEVRON.prev : ""}<span>${label}</span>${dir === "next" ? CHEVRON.next : ""}</span>
      <span class="rp-step__name">R${esc(target.round)} · ${esc(roundTitle(target))}</span>
    </a>`;
  };
  return `<nav class="rp-steps" aria-label="Other replays">${step(prev, "prev")}${step(next, "next")}</nav>`;
}

// Up to three other replays from the season, newest first.
function moreReplays(league, season, round) {
  const others = replayRounds(season).filter((r) => r.round !== round.round).reverse().slice(0, 3);
  if (!others.length) return "";
  return `<section class="section container" aria-labelledby="rpMoreTitle">
    <div class="section-head">
      <div>
        <p class="kicker">${esc(season.label)}</p>
        <h2 class="section-title" id="rpMoreTitle">More replays</h2>
      </div>
      <a class="more-link" href="${link("replays/")}">All replays</a>
    </div>
    <ul class="rp-grid" role="list">${others.map((r) => replayCard(league, r)).join("")}</ul>
  </section>`;
}

function playerView(league, season, round, video) {
  const embedded = video.kind !== "link";
  return `<section class="rp-stage band-dark">
      <div class="container">
        ${stageHead(season, round, "Full race replay")}
        <div class="rp-watch">
          <div class="rp-watch__main">
            ${player(round, video)}
            <p class="rp-open">${embedded ? "<span>Player not loading?</span>" : ""}${externalLink(video, `Open on ${hostName(video)}`)}</p>
            ${steps(season, round)}
          </div>
          <div class="rp-watch__side">${tower(league, round)}</div>
        </div>
      </div>
    </section>
    ${moreReplays(league, season, round)}`;
}

// A real round whose video isn't up (or that hasn't been raced).
function noReplayView(league, season, round) {
  const status = roundStatus(round);
  const start = parseStart(round);
  const raced = isRaced(round);
  const [heading, copy] = status === "cancelled"
    ? ["Round cancelled", "This round was cancelled, so there's no replay to watch."]
    : raced
      ? ["Replay coming soon", "The full-race video for this round hasn't been posted yet. It will appear here as soon as it's uploaded."]
      : ["Replay coming soon", `This race hasn't been run yet. The full-race video will be posted here after the race${start ? ` on ${fmt.long(start)}` : ""}.`];
  const primary = raced
    ? `<a class="btn" href="${link("results/", { round: round.round })}">Race results</a>`
    : `<a class="btn" href="${link("schedule/")}#round-${esc(round.round)}">View on schedule</a>`;
  const withTower = status === "complete";

  return `<section class="rp-stage band-dark">
    <div class="container">
      ${stageHead(season, round)}
      <div class="rp-watch${withTower ? "" : " rp-watch--solo"}">
        <div class="rp-watch__main">
          <div class="rp-screen rp-screen--soon">
            <div class="rp-screen__body">
              ${PLAY_MARK}
              <h2 class="rp-screen__heading">${esc(heading)}</h2>
              <p class="rp-screen__text">${esc(copy)}</p>
              <div class="btn-row">
                ${primary}
                <a class="btn btn--ghost" href="${link("replays/")}">All replays</a>
              </div>
            </div>
          </div>
        </div>
        ${withTower ? `<div class="rp-watch__side">${tower(league, round)}</div>` : ""}
      </div>
    </div>
  </section>
  ${moreReplays(league, season, round)}`;
}

function notFoundView(season, value) {
  const count = season.rounds.length;
  return `<section class="page-head">
      <div class="container">
        <p class="kicker">${esc(season.label)} · Race replays</p>
        <h1 class="title">Race not found</h1>
      </div>
    </section>
    <div class="container">
      <div class="card empty-state">
        <h2>No round “${esc(value)}”</h2>
        <p>${esc(season.label)} has ${count} ${count === 1 ? "round" : "rounds"}. The link may be out of date, or the race belongs to another season.</p>
        <div class="btn-row">
          <a class="btn" href="${link("replays/")}">${esc(season.label)} replays</a>
          <a class="btn btn--ghost" href="${link("schedule/")}">Schedule</a>
        </div>
      </div>
    </div>`;
}
