// League data model: loads data/league.json and derives everything else
// (standings, form, gaps, next race) from race results, so no totals are
// ever entered by hand. Pure functions only — no DOM access in this file.

const DATA_URL = new URL("../../data/league.json", import.meta.url);

export async function loadLeague(url = DATA_URL) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load league data (HTTP ${response.status})`);
  return createLeague(await response.json());
}

export function createLeague(raw) {
  const drivers = new Map();
  const lookup = new Map();
  for (const driver of raw.drivers || []) {
    drivers.set(driver.id, driver);
    for (const key of [driver.id, driver.name, ...(driver.aliases || [])]) {
      lookup.set(String(key).toLowerCase(), driver.id);
    }
  }

  const seasons = (raw.seasons || [])
    .map((season) => ({
      ...season,
      rounds: (season.rounds || []).slice().sort((a, b) => a.round - b.round),
    }))
    .sort((a, b) => b.year - a.year);

  const league = {
    info: raw.league || {},
    teams: raw.teams || {},
    drivers,
    seasons,
    resolveDriver(ref) {
      return lookup.get(String(ref || "").toLowerCase()) || null;
    },
    driver(ref) {
      return drivers.get(this.resolveDriver(ref)) || null;
    },
    season(id) {
      return seasons.find((s) => s.id === id) || null;
    },
    get currentSeason() {
      return seasons.find((s) => s.status === "active") || seasons[0] || null;
    },
  };
  league.issues = validate(league);
  return league;
}

export function roundStatus(round, now = new Date()) {
  if (round.status === "cancelled") return "cancelled";
  if (round.results && round.results.length) return "complete";
  const start = parseStart(round);
  if (start && start <= now) return "awaiting-results";
  return "scheduled";
}

export function parseStart(round) {
  if (!round.start) return null;
  const date = new Date(round.start);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function completedRounds(season, throughRound = Infinity) {
  return season.rounds.filter((r) => roundStatus(r) === "complete" && r.round <= throughRound);
}

export function latestCompletedRound(season) {
  const done = completedRounds(season);
  return done[done.length - 1] || null;
}

export function nextRound(season, now = new Date()) {
  return season.rounds.find((r) => {
    const status = roundStatus(r, now);
    return status === "scheduled" || status === "awaiting-results";
  }) || null;
}

export function pointsFor(league, result) {
  if (typeof result.points === "number") return result.points;
  const table = league.info.points || [];
  let points = table[result.position - 1] || 0;
  if (league.info.fastestLapPoint && result.fastestLap && result.position <= 10) points += 1;
  return points;
}

// Builds the championship table. `throughRound` limits it to rounds <= N,
// which powers the analytics timeline.
export function standings(league, season, { throughRound = Infinity } = {}) {
  const rounds = completedRounds(season, throughRound);
  const rows = new Map();

  const rowFor = (driverId) => {
    if (!rows.has(driverId)) {
      const driver = league.drivers.get(driverId);
      rows.set(driverId, {
        id: driverId,
        name: driver ? driver.name : driverId,
        code: driver ? driver.code : driverId.slice(0, 3).toUpperCase(),
        team: null,
        points: 0,
        wins: 0,
        podiums: 0,
        fastestLaps: 0,
        starts: 0,
        bestFinish: null,
        positions: new Array(rounds.length).fill(null),
        roundPoints: new Array(rounds.length).fill(0),
        cumulative: new Array(rounds.length).fill(0),
        finishCounts: [],
      });
    }
    return rows.get(driverId);
  };

  rounds.forEach((round, index) => {
    for (const result of round.results) {
      const driverId = league.resolveDriver(result.driver);
      if (!driverId) continue;
      const row = rowFor(driverId);
      const points = pointsFor(league, result);
      row.points += points;
      row.roundPoints[index] = points;
      row.positions[index] = result.position;
      row.starts += 1;
      row.team = result.team || row.team;
      if (result.position === 1) row.wins += 1;
      if (result.position <= 3) row.podiums += 1;
      if (result.fastestLap) row.fastestLaps += 1;
      row.bestFinish = row.bestFinish === null ? result.position : Math.min(row.bestFinish, result.position);
      row.finishCounts[result.position] = (row.finishCounts[result.position] || 0) + 1;
    }
  });

  const table = Array.from(rows.values());
  for (const row of table) {
    let running = 0;
    row.cumulative = row.roundPoints.map((p) => (running += p));
    const finished = row.positions.filter((p) => p !== null);
    row.avgFinish = finished.length ? finished.reduce((a, b) => a + b, 0) / finished.length : null;
    row.form = row.positions.slice(-5);
    row.teamColor = teamColor(league, row.team);
  }

  table.sort(compareRows);
  const leaderPoints = table.length ? table[0].points : 0;
  table.forEach((row, index) => {
    row.rank = index + 1;
    row.gap = row.points - leaderPoints;
  });

  return { rounds, rows: table };
}

// F1 tiebreak: points, then countback on number of P1s, P2s, P3s, ...
function compareRows(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  const depth = Math.max(a.finishCounts.length, b.finishCounts.length);
  for (let position = 1; position < depth; position += 1) {
    const diff = (b.finishCounts[position] || 0) - (a.finishCounts[position] || 0);
    if (diff) return diff;
  }
  return a.name.localeCompare(b.name);
}

// Constructors-style table: every result's points go to the team the driver
// raced for in that round, so mid-season team switches are handled.
export function teamStandings(league, season, { throughRound = Infinity } = {}) {
  const rounds = completedRounds(season, throughRound);
  const teams = new Map();
  rounds.forEach((round, index) => {
    for (const result of round.results) {
      const team = result.team || "Unassigned";
      if (!teams.has(team)) {
        teams.set(team, {
          team,
          color: teamColor(league, result.team),
          points: 0,
          wins: 0,
          podiums: 0,
          drivers: new Set(),
          cumulative: new Array(rounds.length).fill(0),
          roundPoints: new Array(rounds.length).fill(0),
          finishCounts: [],
          name: team,
        });
      }
      const row = teams.get(team);
      const points = pointsFor(league, result);
      row.points += points;
      row.roundPoints[index] += points;
      if (result.position === 1) row.wins += 1;
      if (result.position <= 3) row.podiums += 1;
      row.finishCounts[result.position] = (row.finishCounts[result.position] || 0) + 1;
      const driverId = league.resolveDriver(result.driver);
      if (driverId) row.drivers.add(driverId);
    }
  });
  const table = Array.from(teams.values());
  for (const row of table) {
    let running = 0;
    row.cumulative = row.roundPoints.map((p) => (running += p));
    row.drivers = Array.from(row.drivers).map((id) => league.drivers.get(id)).filter(Boolean);
  }
  table.sort(compareRows);
  const leaderPoints = table.length ? table[0].points : 0;
  table.forEach((row, index) => {
    row.rank = index + 1;
    row.gap = row.points - leaderPoints;
  });
  return { rounds, rows: table };
}

// Drivers entered in a season: explicit `entries` if the season lists them,
// otherwise everyone who has a result in it.
export function seasonEntries(league, season) {
  if (Array.isArray(season.entries) && season.entries.length) {
    return season.entries
      .map((entry) => {
        const driver = league.driver(entry.driver);
        return driver ? { ...driver, team: entry.team || null, teamColor: teamColor(league, entry.team) } : null;
      })
      .filter(Boolean);
  }
  return standings(league, season).rows.map((row) => ({
    ...league.drivers.get(row.id),
    team: row.team,
    teamColor: row.teamColor,
  }));
}

// One driver's record across every season, newest first.
export function driverCareer(league, driverId) {
  const seasons = [];
  const totals = { points: 0, wins: 0, podiums: 0, fastestLaps: 0, starts: 0, titles: 0, bestFinish: null };
  for (const season of league.seasons) {
    const table = standings(league, season);
    const row = table.rows.find((r) => r.id === driverId);
    if (!row) continue;
    const champion = season.status === "complete" && row.rank === 1;
    seasons.push({ season, row, rounds: table.rounds, champion });
    totals.points += row.points;
    totals.wins += row.wins;
    totals.podiums += row.podiums;
    totals.fastestLaps += row.fastestLaps;
    totals.starts += row.starts;
    if (champion) totals.titles += 1;
    if (row.bestFinish !== null) {
      totals.bestFinish = totals.bestFinish === null ? row.bestFinish : Math.min(totals.bestFinish, row.bestFinish);
    }
  }
  return { driver: league.drivers.get(driverId) || null, seasons, totals };
}

export function teamColor(league, team) {
  return (team && league.teams[team]) || "#8A8F98";
}

export function roundWinner(league, round) {
  const winner = (round.results || []).find((r) => r.position === 1);
  return winner ? league.driver(winner.driver) : null;
}

export function roundFastestLap(league, round) {
  const fastest = (round.results || []).find((r) => r.fastestLap);
  return fastest ? league.driver(fastest.driver) : null;
}

export function seasonSummary(league, season) {
  const { rounds, rows } = standings(league, season);
  const winners = new Set();
  let streak = { driver: null, length: 0, from: null, to: null };
  let current = { driver: null, length: 0, from: null };

  for (const round of rounds) {
    const winner = roundWinner(league, round);
    if (winner) winners.add(winner.id);
    if (winner && current.driver === winner.id) {
      current.length += 1;
    } else {
      current = { driver: winner ? winner.id : null, length: winner ? 1 : 0, from: round.round };
    }
    if (current.length > streak.length) {
      streak = { driver: current.driver, length: current.length, from: current.from, to: round.round };
    }
  }

  const top = (key) => rows.slice().sort((a, b) => b[key] - a[key] || a.rank - b.rank)[0] || null;
  return {
    racesCompleted: rounds.length,
    racesScheduled: season.rounds.filter((r) => r.status !== "cancelled").length,
    drivers: rows.length,
    distinctWinners: winners.size,
    leader: rows[0] || null,
    runnerUp: rows[1] || null,
    mostWins: top("wins"),
    mostPodiums: top("podiums"),
    mostFastestLaps: top("fastestLaps"),
    longestWinStreak: streak.driver ? { ...streak, driver: league.drivers.get(streak.driver) } : null,
  };
}

// Head-to-head over rounds both drivers started.
export function headToHead(table, idA, idB) {
  const a = table.rows.find((r) => r.id === idA);
  const b = table.rows.find((r) => r.id === idB);
  if (!a || !b) return null;
  let aAhead = 0;
  let bAhead = 0;
  let shared = 0;
  let gapTotal = 0;
  a.positions.forEach((pa, i) => {
    const pb = b.positions[i];
    if (pa === null || pb === null) return;
    shared += 1;
    gapTotal += pb - pa;
    if (pa < pb) aAhead += 1;
    else if (pb < pa) bAhead += 1;
  });
  return { a, b, aAhead, bAhead, shared, avgGap: shared ? gapTotal / shared : null };
}

function validate(league) {
  const issues = [];
  for (const season of league.seasons) {
    for (const round of season.rounds) {
      const where = `${season.label} R${round.round}`;
      const seenDrivers = new Set();
      const seenPositions = new Set();
      for (const result of round.results || []) {
        const id = league.resolveDriver(result.driver);
        if (!id) issues.push(`${where}: unknown driver "${result.driver}" (add them to "drivers")`);
        if (id && seenDrivers.has(id)) issues.push(`${where}: ${result.driver} listed twice`);
        if (!Number.isInteger(result.position) || result.position < 1) {
          issues.push(`${where}: ${result.driver} has invalid position "${result.position}"`);
        } else if (seenPositions.has(result.position)) {
          issues.push(`${where}: two drivers finished P${result.position}`);
        }
        seenDrivers.add(id);
        seenPositions.add(result.position);
      }
      if (round.start && !parseStart(round)) issues.push(`${where}: unreadable start "${round.start}"`);
    }
  }
  return issues;
}
