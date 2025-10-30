const DATA_SOURCE = "data/league-data.csv";

const state = {
  drivers: [],
  sessions: [],
};

let currentSortKey = "points";

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

function showStatus(message, tone = "info") {
  if (!elements.statusMessage) return;

  const palette = {
    info: "rgba(255, 255, 255, 0.65)",
    success: "var(--color-success)",
    error: "#fca5a5",
  };

  elements.statusMessage.textContent = message;
  elements.statusMessage.style.color = palette[tone] || palette.info;
}

function splitCsvRows(text) {
  const rows = [];
  let currentValue = "";
  let currentRow = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\"") {
      const nextChar = text[index + 1];
      if (inQuotes && nextChar === "\"") {
        currentValue += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = "";
    } else {
      currentValue += char;
    }
  }

  if (currentValue !== "" || currentRow.length) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows;
}

function parseCsv(text) {
  const rows = splitCsvRows(text.trim());
  if (!rows.length) return [];

  const headers = rows[0].map((header) => header.trim());
  const records = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.every((value) => value === undefined || value.trim() === "")) {
      continue;
    }

    const entry = {};
    headers.forEach((header, columnIndex) => {
      const value = row[columnIndex] !== undefined ? row[columnIndex].trim() : "";
      entry[header] = value;
    });
    records.push(entry);
  }

  return records;
}

function createSessionKey(sessionDate = "", sessionName = "") {
  return `${sessionDate}__${sessionName}`.trim();
}

function createSessionSkeleton(row) {
  return {
    name: row.sessionName || "",
    date: row.sessionDate || "",
    highlights: [],
    results: [],
  };
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toInteger(value) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}

function toBoolean(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function normaliseHighlights(value) {
  if (!value) return [];
  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function transformRows(rows) {
  const drivers = [];
  const sessionsMap = new Map();

  rows.forEach((row) => {
    const recordType = (row.recordType || "").toLowerCase();
    if (!recordType) return;

    if (recordType === "driver") {
      const driver = {
        name: row.driverName || "",
        code: row.driverCode || "",
        points: toNumber(row.points),
        wins: toNumber(row.wins),
        podiums: toNumber(row.podiums),
        fastestLaps: toNumber(row.fastestLaps),
        previousRank: toInteger(row.previousRank),
        consistencyIndex: row.consistencyIndex ? toNumber(row.consistencyIndex, null) : null,
      };
      drivers.push(driver);
      return;
    }

    if (recordType === "session") {
      const key = createSessionKey(row.sessionDate, row.sessionName);
      const session = sessionsMap.get(key) || createSessionSkeleton(row);
      session.highlights = normaliseHighlights(row.highlights);
      sessionsMap.set(key, session);
      return;
    }

    if (recordType === "session-result") {
      const key = createSessionKey(row.sessionDate, row.sessionName);
      const session = sessionsMap.get(key) || createSessionSkeleton(row);
      session.results.push({
        driver: row.driverName || "",
        position: toInteger(row.position),
        points: toNumber(row.points),
        fastestLap: toBoolean(row.fastestLap),
      });
      sessionsMap.set(key, session);
    }
  });

  const sessions = Array.from(sessionsMap.values()).map((session) => {
    const ordered = session.results
      .slice()
      .filter((result) => result.driver)
      .sort((a, b) => {
        if (a.position !== null && b.position !== null) {
          return a.position - b.position;
        }
        if (a.position !== null) return -1;
        if (b.position !== null) return 1;
        return a.driver.localeCompare(b.driver);
      });

    return {
      name: session.name,
      date: session.date,
      highlights: session.highlights || [],
      results: ordered,
    };
  });

  return { drivers, sessions };
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function renderLeaderboard(sortKey = "points") {
  const { drivers } = state;
  if (!elements.leaderboardBody) return;

  if (!drivers.length) {
    elements.leaderboardBody.innerHTML =
      '<tr><td class="leaderboard__empty" colspan="6">Add driver rows to <code>data/league-data.csv</code> to see standings.</td></tr>';
    return;
  }

  const sorted = drivers.slice().sort((a, b) => {
    const valueA = typeof a[sortKey] === "number" ? a[sortKey] : 0;
    const valueB = typeof b[sortKey] === "number" ? b[sortKey] : 0;

    if (valueB === valueA) {
      return (typeof b.points === "number" ? b.points : 0) - (typeof a.points === "number" ? a.points : 0);
    }

    return valueB - valueA;
  });

  const rows = sorted
    .map((driver, index) => {
      const tags = [];
      if (index === 0 && sortKey === "points") {
        tags.push('<span class="badge badge--leader">Leader</span>');
      }
      if (driver.fastestLaps > 0 && sortKey === "fastestLaps") {
        tags.push('<span class="badge badge--fastest">FL threat</span>');
      }

      const code = driver.code ? `<span>${driver.code}</span>` : "";
      const points = Number.isFinite(driver.points) ? driver.points : 0;
      const wins = Number.isFinite(driver.wins) ? driver.wins : 0;
      const podiums = Number.isFinite(driver.podiums) ? driver.podiums : 0;
      const fastest = Number.isFinite(driver.fastestLaps) ? driver.fastestLaps : 0;

      return `
        <tr>
          <td data-label="Position">${index + 1}</td>
          <td data-label="Driver">
            <div class="leaderboard__driver">
              <div>
                <strong>${driver.name || "Unknown Driver"}</strong>
                ${code}
              </div>
              ${tags.join(" ")}
            </div>
          </td>
          <td data-label="Points">${points}</td>
          <td data-label="Wins">${wins}</td>
          <td data-label="Podiums">${podiums}</td>
          <td data-label="Fastest Laps">${fastest}</td>
        </tr>
      `;
    })
    .join("");

  elements.leaderboardBody.innerHTML = rows;
}

function updateInsights() {
  const standings = state.drivers.slice().sort((a, b) => {
    const pointsA = Number.isFinite(a.points) ? a.points : 0;
    const pointsB = Number.isFinite(b.points) ? b.points : 0;
    return pointsB - pointsA;
  });

  const leader = standings[0];
  const winsLeader = state.drivers
    .slice()
    .sort((a, b) => {
      const winsA = Number.isFinite(a.wins) ? a.wins : 0;
      const winsB = Number.isFinite(b.wins) ? b.wins : 0;
      if (winsB === winsA) {
        const pointsA = Number.isFinite(a.points) ? a.points : 0;
        const pointsB = Number.isFinite(b.points) ? b.points : 0;
        return pointsB - pointsA;
      }
      return winsB - winsA;
    })[0];

  if (elements.leaderName) {
    elements.leaderName.textContent = leader ? leader.name || "-" : "-";
  }
  if (elements.leaderPoints) {
    const points = leader && Number.isFinite(leader.points) ? leader.points : 0;
    elements.leaderPoints.textContent = leader ? `${points} pts` : "0 pts";
  }

  if (elements.winsLeader) {
    elements.winsLeader.textContent = winsLeader ? winsLeader.name || "-" : "-";
  }
  if (elements.winsCount) {
    const wins = winsLeader && Number.isFinite(winsLeader.wins) ? winsLeader.wins : 0;
    elements.winsCount.textContent = winsLeader ? `${wins} wins` : "0 wins";
  }

  const watchPool = standings
    .map((driver, index) => {
      const currentRank = index + 1;
      const previousRank = Number.isFinite(driver.previousRank) ? driver.previousRank : currentRank;
      const improvement = previousRank - currentRank;
      return {
        driver,
        currentRank,
        previousRank,
        improvement,
      };
    })
    .filter((entry) => entry.currentRank !== 1);

  const positiveImprovement = watchPool
    .filter((entry) => entry.improvement > 0)
    .sort((a, b) => {
      if (b.improvement === a.improvement) {
        return a.currentRank - b.currentRank;
      }
      return b.improvement - a.improvement;
    });

  const watchCandidate = positiveImprovement[0] || watchPool[0] || null;

  if (!elements.watchName || !elements.watchMeta) return;

  if (!watchCandidate) {
    elements.watchName.textContent = "-";
    elements.watchMeta.textContent = "Momentum data not available";
    return;
  }

  elements.watchName.textContent = watchCandidate.driver.name || "-";

  if (watchCandidate.improvement > 0) {
    elements.watchMeta.textContent = `Up ${watchCandidate.improvement} places • Now P${watchCandidate.currentRank} (was P${watchCandidate.previousRank})`;
  } else if (watchCandidate.improvement < 0) {
    elements.watchMeta.textContent = `Down ${Math.abs(watchCandidate.improvement)} places • Currently P${watchCandidate.currentRank}`;
  } else if (watchCandidate.previousRank !== watchCandidate.currentRank) {
    const delta = watchCandidate.previousRank - watchCandidate.currentRank;
    const direction = delta > 0 ? "Up" : "Down";
    elements.watchMeta.textContent = `${direction} ${Math.abs(delta)} places • P${watchCandidate.currentRank}`;
  } else {
    elements.watchMeta.textContent = `Holding P${watchCandidate.currentRank} • Watch for a push next round`;
  }
}

function renderSessions() {
  if (!elements.sessionList) return;

  if (!state.sessions.length) {
    elements.sessionList.innerHTML =
      '<p class="sessions__empty">Add session and session-result rows to <code>data/league-data.csv</code> to surface recent events.</p>';
    return;
  }

  const ordered = state.sessions
    .slice()
    .sort((a, b) => {
      if (a.date && b.date) {
        const aTime = new Date(`${a.date}T00:00:00`).getTime();
        const bTime = new Date(`${b.date}T00:00:00`).getTime();
        if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) {
          return bTime - aTime;
        }
      }
      if (b.date) return 1;
      if (a.date) return -1;
      return (b.name || "").localeCompare(a.name || "");
    });

  const markup = ordered
    .map((session) => {
      const highlights = session.highlights.length
        ? `<div class="session__tags">${session.highlights
            .map((highlight) => `<span class="badge">${highlight}</span>`)
            .join("")}</div>`
        : "";

      const results = session.results.length
        ? session.results
            .map((result) => {
              const position = result.position !== null ? result.position : "—";
              const points = Number.isFinite(result.points) ? `${result.points} pts` : "";
              const fastest = result.fastestLap
                ? '<span class="badge badge--fastest">Fastest Lap</span>'
                : "";
              const details = [points, fastest].filter(Boolean).join(" ");
              const detailsMarkup = details || "&nbsp;";

              return `
                <div class="session__result">
                  <span><strong>${position}</strong> • ${result.driver}</span>
                  <span>${detailsMarkup}</span>
                </div>
              `;
            })
            .join("")
        : '<p class="session__empty">No results recorded yet for this session.</p>';

      return `
        <article class="session">
          <div class="session__header">
            <h4 class="session__title">${session.name || "Unnamed Session"}</h4>
            <p class="session__meta">${formatDate(session.date)}</p>
          </div>
          ${highlights}
          <div class="session__results">${results}</div>
        </article>
      `;
    })
    .join("");

  elements.sessionList.innerHTML = markup;
}

function buildSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    source: DATA_SOURCE,
    standings: state.drivers.map((driver) => ({
      name: driver.name,
      code: driver.code,
      points: Number.isFinite(driver.points) ? driver.points : 0,
      wins: Number.isFinite(driver.wins) ? driver.wins : 0,
      podiums: Number.isFinite(driver.podiums) ? driver.podiums : 0,
      fastestLaps: Number.isFinite(driver.fastestLaps) ? driver.fastestLaps : 0,
      previousRank: Number.isFinite(driver.previousRank) ? driver.previousRank : null,
      consistencyIndex: driver.consistencyIndex ?? null,
    })),
    sessions: state.sessions.map((session) => ({
      name: session.name,
      date: session.date,
      highlights: session.highlights,
      results: session.results.map((result) => ({
        driver: result.driver,
        position: result.position,
        points: result.points,
        fastestLap: result.fastestLap,
      })),
    })),
  };
}

function handleCopyJson() {
  const payload = JSON.stringify(buildSnapshot(), null, 2);
  navigator.clipboard
    .writeText(payload)
    .then(() => {
      showStatus("JSON snapshot copied to clipboard.", "success");
    })
    .catch(() => {
      showStatus("Unable to copy JSON.", "error");
    });
}

async function loadData() {
  try {
    const response = await fetch(DATA_SOURCE, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load data: ${response.status}`);
    }

    const csvText = await response.text();
    const rows = parseCsv(csvText);
    const { drivers, sessions } = transformRows(rows);

    state.drivers = drivers;
    state.sessions = sessions;

    renderLeaderboard(currentSortKey);
    updateInsights();
    renderSessions();

    if (!drivers.length && !sessions.length) {
      showStatus("Add rows to data/league-data.csv to populate the dashboard.", "info");
    } else {
      showStatus("Data loaded from data/league-data.csv.", "success");
    }
  } catch (error) {
    console.error("Unable to load league data", error);
    state.drivers = [];
    state.sessions = [];

    renderLeaderboard(currentSortKey);
    updateInsights();
    renderSessions();

    showStatus(
      "Unable to load data/league-data.csv. Confirm the file exists and matches the documented format.",
      "error",
    );
  }
}

function init() {
  if (elements.sortSelect) {
    elements.sortSelect.addEventListener("change", (event) => {
      currentSortKey = event.target.value;
      renderLeaderboard(currentSortKey);
    });
  }

  if (elements.copyJson) {
    elements.copyJson.addEventListener("click", handleCopyJson);
  }

  renderLeaderboard(currentSortKey);
  updateInsights();
  renderSessions();
  loadData();
}

init();
