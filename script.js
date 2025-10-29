const drivers = [
  {
    name: "Neo Blaze",
    code: "NBZ",
    team: "Ignite Racing",
    points: 168,
    wins: 4,
    podiums: 9,
    fastestLaps: 4,
    isRookie: false,
    consistencyIndex: 0.92,
    previousRank: 1,
  },
  {
    name: "Luna Storm",
    code: "LST",
    team: "Aurora Velocity",
    points: 154,
    wins: 3,
    podiums: 10,
    fastestLaps: 3,
    isRookie: false,
    consistencyIndex: 0.9,
    previousRank: 2,
  },
  {
    name: "Aria Flux",
    code: "AFX",
    team: "Photon Motors",
    points: 121,
    wins: 1,
    podiums: 6,
    fastestLaps: 2,
    isRookie: true,
    consistencyIndex: 0.84,
    previousRank: 5,
  },
  {
    name: "Kael Drift",
    code: "KDF",
    team: "Vector Apex",
    points: 109,
    wins: 1,
    podiums: 4,
    fastestLaps: 1,
    isRookie: false,
    consistencyIndex: 0.81,
    previousRank: 3,
  },
  {
    name: "Mira Volt",
    code: "MVL",
    team: "Pulseworks",
    points: 98,
    wins: 0,
    podiums: 3,
    fastestLaps: 2,
    isRookie: false,
    consistencyIndex: 0.78,
    previousRank: 4,
  },
  {
    name: "Jax Lancer",
    code: "JXL",
    team: "Nova Wing",
    points: 76,
    wins: 0,
    podiums: 2,
    fastestLaps: 1,
    isRookie: true,
    consistencyIndex: 0.73,
    previousRank: 7,
  },
];

const sessions = [
  {
    name: "Singapore Night Sprint",
    date: "2024-08-31",
    highlights: ["Safety car on lap 12", "Blaze undercut for the win"],
    results: [
      { driver: "Neo Blaze", position: 1, points: 25, fastestLap: true },
      { driver: "Luna Storm", position: 2, points: 18 },
      { driver: "Aria Flux", position: 3, points: 15 },
      { driver: "Kael Drift", position: 4, points: 12 },
      { driver: "Mira Volt", position: 5, points: 10 },
      { driver: "Jax Lancer", position: 6, points: 8 },
    ],
  },
  {
    name: "Monaco Precision Run",
    date: "2024-07-18",
    highlights: ["Rookie podium for Flux", "Storm leads most laps"],
    results: [
      { driver: "Luna Storm", position: 1, points: 25 },
      { driver: "Neo Blaze", position: 2, points: 18 },
      { driver: "Aria Flux", position: 3, points: 15, fastestLap: true },
      { driver: "Mira Volt", position: 4, points: 12 },
      { driver: "Kael Drift", position: 5, points: 10 },
      { driver: "Jax Lancer", position: 6, points: 8 },
    ],
  },
  {
    name: "Silverstone Thunder",
    date: "2024-06-01",
    highlights: ["Storm vs Blaze duel", "Volt fastest in sector 2"],
    results: [
      { driver: "Neo Blaze", position: 1, points: 25 },
      { driver: "Luna Storm", position: 2, points: 18, fastestLap: true },
      { driver: "Kael Drift", position: 3, points: 15 },
      { driver: "Mira Volt", position: 4, points: 12 },
      { driver: "Aria Flux", position: 5, points: 10 },
      { driver: "Jax Lancer", position: 6, points: 8 },
    ],
  },
];

const elements = {
  leaderboardBody: document.getElementById("leaderboardBody"),
  sortSelect: document.getElementById("sortSelect"),
  leaderName: document.getElementById("leaderName"),
  leaderPoints: document.getElementById("leaderPoints"),
  winsLeader: document.getElementById("winsLeader"),
  winsCount: document.getElementById("winsCount"),
  watchName: document.getElementById("watchName"),
  watchMeta: document.getElementById("watchMeta"),
  sessionList: document.getElementById("sessionList"),
  copyJson: document.getElementById("copyJson"),
  statusMessage: document.getElementById("statusMessage"),
};

function formatDate(value) {
  const date = new Date(value + "T00:00:00");
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function renderLeaderboard(sortKey = "points") {
  const sorted = [...drivers].sort((a, b) => {
    if (b[sortKey] === a[sortKey]) {
      return b.points - a.points;
    }
    return b[sortKey] - a[sortKey];
  });

  elements.leaderboardBody.innerHTML = sorted
    .map((driver, index) => {
      const tags = [];
      if (index === 0 && sortKey === "points") {
        tags.push('<span class="badge badge--leader">Leader</span>');
      }
      if (driver.fastestLaps > 0 && sortKey === "fastestLaps") {
        tags.push('<span class="badge badge--fastest">FL threat</span>');
      }

      return `
        <tr>
          <td>${index + 1}</td>
          <td>
            <div class="leaderboard__driver">
              <div>
                <strong>${driver.name}</strong>
                <span>${driver.code}</span>
              </div>
              ${tags.join(" ")}
            </div>
          </td>
          <td>${driver.team}</td>
          <td>${driver.points}</td>
          <td>${driver.wins}</td>
          <td>${driver.podiums}</td>
          <td>${driver.fastestLaps}</td>
        </tr>
      `;
    })
    .join("");
}

function updateInsights() {
  const standings = [...drivers].sort((a, b) => b.points - a.points);
  const leader = standings[0];
  const winsLeader = [...drivers].sort((a, b) => b.wins - a.wins)[0];

  elements.leaderName.textContent = leader.name;
  elements.leaderPoints.textContent = `${leader.points} pts`;
  elements.winsLeader.textContent = winsLeader.name;
  elements.winsCount.textContent = `${winsLeader.wins} wins`;

  const watchCandidate = standings
    .map((driver, index) => ({
      driver,
      currentRank: index + 1,
      improvement: (driver.previousRank || index + 1) - (index + 1),
    }))
    .filter((entry) => entry.currentRank !== 1)
    .sort((a, b) => {
      if (b.improvement === a.improvement) {
        return a.currentRank - b.currentRank;
      }
      return b.improvement - a.improvement;
    })[0];

  if (watchCandidate && watchCandidate.improvement > 0) {
    elements.watchName.textContent = watchCandidate.driver.name;
    elements.watchMeta.textContent = `Up ${watchCandidate.improvement} places • Now P${watchCandidate.currentRank} (was P${watchCandidate.driver.previousRank})`;
  } else if (watchCandidate) {
    elements.watchName.textContent = watchCandidate.driver.name;
    elements.watchMeta.textContent = `Holding P${watchCandidate.currentRank} • Watch for a push next round`;
  } else {
    elements.watchName.textContent = "-";
    elements.watchMeta.textContent = "Momentum data not available";
  }
}

function renderSessions() {
  elements.sessionList.innerHTML = sessions
    .slice()
    .reverse()
    .map((session) => {
      const highlights = session.highlights
        ? `<div class="session__tags">${session.highlights
            .map((tag) => `<span class="badge">${tag}</span>`)
            .join("")}</div>`
        : "";

      const results = session.results
        .map((result) => {
          const fastest = result.fastestLap
            ? '<span class="badge badge--fastest">Fastest Lap</span>'
            : "";

          return `
            <div class="session__result">
              <span><strong>${result.position}</strong> • ${result.driver}</span>
              <span>${result.points} pts ${fastest}</span>
            </div>
          `;
        })
        .join("");

      return `
        <article class="session">
          <div class="session__header">
            <h4 class="session__title">${session.name}</h4>
            <p class="session__meta">${formatDate(session.date)}</p>
          </div>
          ${highlights}
          <div class="session__results">${results}</div>
        </article>
      `;
    })
    .join("");
}

function buildSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    standings: drivers
      .slice()
      .sort((a, b) => b.points - a.points)
      .map((driver) => ({
        name: driver.name,
        code: driver.code,
        team: driver.team,
        points: driver.points,
        wins: driver.wins,
        podiums: driver.podiums,
        fastestLaps: driver.fastestLaps,
        rookie: driver.isRookie,
        consistencyIndex: driver.consistencyIndex,
      })),
    sessions: sessions.map((session) => ({
      name: session.name,
      date: session.date,
      highlights: session.highlights || [],
      results: session.results,
    })),
  };
}

function handleCopyJson() {
  const payload = JSON.stringify(buildSnapshot(), null, 2);
  navigator.clipboard
    .writeText(payload)
    .then(() => {
      if (elements.statusMessage) {
        elements.statusMessage.textContent = "JSON snapshot copied to clipboard.";
        elements.statusMessage.style.color = "var(--color-secondary)";
      }
    })
    .catch(() => {
      if (elements.statusMessage) {
        elements.statusMessage.textContent = "Unable to copy JSON.";
        elements.statusMessage.style.color = "#fca5a5";
      }
    });
}

function init() {
  renderLeaderboard();
  updateInsights();
  renderSessions();

  elements.sortSelect.addEventListener("change", (event) => {
    renderLeaderboard(event.target.value);
  });
  elements.copyJson.addEventListener("click", handleCopyJson);
}

init();
