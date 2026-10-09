// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createLeague, standings, seasonSummary, nextRound, roundStatus, headToHead,
  teamStandings, driverCareer, seasonEntries, pendingRounds, parseVideo,
} from "../assets/js/league.js";

const raw = JSON.parse(await readFile(new URL("../data/league.json", import.meta.url), "utf8"));
const league = createLeague(raw);
const s1 = league.season("season-1");

test("league.json has no data issues", () => {
  assert.deepEqual(league.issues, []);
});

test("Season 1 standings derive from results", () => {
  const table = standings(league, s1);
  const got = table.rows.map((r) => [r.name, r.points, r.wins, r.podiums, r.fastestLaps]);
  assert.deepEqual(got, [
    ["Rambo", 190, 7, 8, 0],
    ["Cbreezyll", 99, 0, 5, 2],
    ["ComanderHP", 88, 1, 4, 0],
    ["TheSlayterr-ttv", 70, 0, 2, 0],
    ["ItsCetla", 33, 0, 0, 0],
    ["Raptor33M", 12, 0, 0, 1],
    ["Woo0pig", 8, 0, 0, 0],
  ]);
  assert.deepEqual(table.rows[0].cumulative, [25, 50, 75, 100, 125, 140, 165, 190]);
  assert.equal(table.rows[1].gap, -91);
});

test("timeline: standings through round 4", () => {
  const table = standings(league, s1, { throughRound: 4 });
  assert.equal(table.rounds.length, 4);
  assert.equal(table.rows[0].points, 100);
  assert.equal(table.rows.find((r) => r.name === "ComanderHP").points, 46);
});

test("season summary", () => {
  const summary = seasonSummary(league, s1);
  assert.equal(summary.racesCompleted, 8);
  assert.equal(summary.distinctWinners, 2);
  assert.equal(summary.mostFastestLaps.name, "Cbreezyll");
  assert.equal(summary.longestWinStreak.driver.name, "Rambo");
  assert.equal(summary.longestWinStreak.length, 5);
});

test("points tie is broken by countback, not name", () => {
  const tied = createLeague({
    league: { points: [3, 2, 1] },
    drivers: [{ id: "a", name: "Zed" }, { id: "b", name: "Amy" }],
    seasons: [{ id: "x", year: 1, rounds: [
      { round: 1, results: [{ driver: "a", position: 1 }, { driver: "b", position: 2 }] },
      { round: 2, results: [{ driver: "b", position: 3 }] },
    ] }],
  });
  const rows = standings(tied, tied.seasons[0]).rows;
  assert.equal(rows[0].points, rows[1].points);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
});

test("round status and next round", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const season = { rounds: [
    { round: 1, start: "2026-10-01T20:00:00-04:00", results: [{ driver: "a", position: 1 }] },
    { round: 2, start: "2026-10-06T20:00:00-04:00", results: [] },
    { round: 3, start: "2026-10-13T20:00:00-04:00", results: [] },
    { round: 4, status: "cancelled", results: [] },
  ] };
  assert.equal(roundStatus(season.rounds[0], now), "complete");
  assert.equal(roundStatus(season.rounds[1], now), "awaiting-results");
  assert.equal(roundStatus(season.rounds[2], now), "scheduled");
  assert.equal(roundStatus(season.rounds[3], now), "cancelled");
  // A past round without results is pending, not "next".
  assert.equal(nextRound(season, now).round, 3);
  assert.deepEqual(pendingRounds(season, now).map((r) => r.round), [2]);
});

test("validation catches bad results", () => {
  const bad = createLeague({
    drivers: [{ id: "a", name: "A" }],
    seasons: [{ id: "x", label: "X", year: 1, rounds: [
      { round: 1, results: [{ driver: "a", position: 1 }, { driver: "ghost", position: 1 }] },
    ] }],
  });
  assert.equal(bad.issues.length, 2);
});

test("head to head", () => {
  const table = standings(league, s1);
  const h2h = headToHead(table, "cbreezyll", "comanderhp");
  assert.equal(h2h.shared, 7);
  assert.equal(h2h.aAhead + h2h.bAhead, 7);
});

test("team standings credit the team raced for in each round", () => {
  const table = teamStandings(league, s1);
  const total = table.rows.reduce((sum, r) => sum + r.points, 0);
  assert.equal(total, 190 + 99 + 88 + 70 + 33 + 12 + 8);
  const ferrari = table.rows.find((r) => r.team === "Ferrari");
  // Rambo R1-R4 (100) + Cbreezyll R5-R8 (0+18+18+18) + ComanderHP R7 (15) + Woo0pig R1-R4 (0)
  assert.equal(ferrari.points, 100 + 54 + 15);
  assert.equal(table.rows[0].rank, 1);
});

test("driver career and season entries", () => {
  // TasteThebo (Season 1) and Rambo (Season 2) are one driver.
  assert.equal(league.resolveDriver("TasteThebo"), "rambo");
  assert.equal(league.resolveDriver("tastethebo"), "rambo");
  const career = driverCareer(league, "rambo");
  assert.equal(career.totals.titles, 1);
  assert.equal(career.totals.wins, 7);
  assert.equal(career.seasons.length, 1);
  assert.equal(seasonEntries(league, s1).length, 7);
  const s2 = seasonEntries(league, league.season("season-2"));
  assert.equal(s2.length, 10);
  assert.equal(s2.find((d) => d.id === "itscetla").team, "Red Bull");
});

test("bad data is reported and kept out of every total", () => {
  const messy = createLeague({
    league: { points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], timezone: "America/NewYork" },
    drivers: [{ id: "a", name: "A" }],
    seasons: [{ id: "x", label: "X", year: 1, rounds: [
      { round: 1, start: "2026-11-03T20:00:00", results: [
        { driver: "a", team: "Haas", position: 1 },
        { driver: "typo", team: "Haas", position: 9 },
        { driver: "a", team: "Haas", position: "<b>" },
      ] },
    ] }],
  });
  assert.equal(messy.info.timezone, "America/New_York");
  assert.ok(messy.issues.some((i) => i.includes("not a valid time zone")));
  assert.ok(messy.issues.some((i) => i.includes("needs a time and UTC offset")));
  assert.ok(messy.issues.some((i) => i.includes('unknown driver "typo"')));
  const season = messy.seasons[0];
  assert.equal(season.rounds[0].results.length, 1);
  assert.equal(standings(messy, season).rows[0].points, 25);
  assert.equal(teamStandings(messy, season).rows[0].points, 25);
});

test("Season 2 calendar: 9 Thursday rounds at 8:45 PM Eastern", () => {
  const s2 = league.season("season-2");
  assert.equal(league.currentSeason.id, "season-2");
  assert.equal(s2.rounds.length, 9);
  for (const round of s2.rounds) {
    const start = new Date(round.start);
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit",
    }).format(start);
    assert.equal(local, "Thu 8:45 PM", `R${round.round} ${round.name}`);
  }
  assert.equal(nextRound(s2, new Date("2026-10-09T12:00:00Z")).name, "Qatar");
});

test("replay links: only http(s) survive, known hosts parse for embedding", () => {
  const l = createLeague({
    drivers: [],
    seasons: [{ id: "x", label: "X", year: 1, rounds: [
      { round: 1, replay: "https://youtu.be/dQw4w9WgXcQ?t=90", results: [] },
      { round: 2, replay: "javascript:alert(1)", results: [] },
      { round: 3, replay: "https://www.twitch.tv/videos/123456789", results: [] },
    ] }],
  });
  const [r1, r2, r3] = l.seasons[0].rounds;
  assert.equal(r2.replay, undefined);
  assert.ok(l.issues.some((i) => i.includes("must be a full http(s) link")));
  assert.deepEqual(parseVideo(r1.replay), { kind: "youtube", id: "dQw4w9WgXcQ", start: 90, url: "https://youtu.be/dQw4w9WgXcQ?t=90" });
  assert.equal(parseVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(parseVideo("https://youtube.com/live/dQw4w9WgXcQ").kind, "youtube");
  assert.deepEqual(parseVideo(r3.replay), { kind: "twitch", id: "123456789", url: "https://www.twitch.tv/videos/123456789" });
  assert.equal(parseVideo("https://drive.google.com/file/d/abc/view").kind, "link");
  assert.equal(parseVideo("https://youtu.be/dQw4w9WgXcQ?t=1m30s").start, 90);
  assert.equal(parseVideo("https://youtu.be/dQw4w9WgXcQ?t=1h2m3s").start, 3723);
  assert.equal(parseVideo("https://youtu.be/dQw4w9WgXcQ?t=junk").start, 0);
  // Anything that isn't a clean video id falls back to a plain link.
  assert.equal(parseVideo("https://youtube.com/watch?v=<script>").kind, "link");
  assert.equal(parseVideo("not a url"), null);
});
