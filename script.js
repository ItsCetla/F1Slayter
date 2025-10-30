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

function getTeamColor(teamName) {
  const teamColors = {
    "Ferrari": "#DC0000",
    "Red Bull": "#3671C6",
    "Mercedes-AMG Petronas": "#27F4D2",
    "McLaren": "#FF8000",
    "Aston Martin": "#229971",
    "Alpine": "#FF87BC",
    "Williams": "#64C4FF",
    "Kick Sauber": "#52E252",
    "Haas": "#B6BABD",
    "Visa Cash App RB": "#6692FF"
  };
  return teamColors[teamName] || "#666666";
}

function getTrackImage(sessionName) {
  // Prefer local assets if available; fall back to remote images otherwise
  const trackImages = {
    // Local assets (copied to assets/tracks)
    "Abu Dhabi": "./assets/tracks/abu-dhabi.avif",
    "Las Vegas": "./assets/tracks/las-vegas.png",
    "Bahrain": "./assets/tracks/bahrain.avif",
    "Saudi Arabia": "./assets/tracks/saudi-arabia.jpg",
    "Azerbaijan": "./assets/tracks/azerbaijan.jpg",
    "Miami": "./assets/tracks/miami.jpg",
    "Austria": "./assets/tracks/austria.avif",
    "Singapore": "./assets/tracks/singapore.jpg",
    "Australia": "./assets/tracks/australia.jpg",
    "United States": "./assets/tracks/united-states.jpg",

    // Keep remote fallbacks for tracks without local files yet
    "Japan": "https://f1chronicle.com/wp-content/uploads/2024/04/2024-Japanese-Grand-Prix-Track-Map.jpg",
    "Netherlands": "https://f1chronicle.com/wp-content/uploads/2024/08/2024-Dutch-Grand-Prix-Track-Map.jpg",
    "China": "https://f1chronicle.com/wp-content/uploads/2024/04/2024-Chinese-Grand-Prix-Track-Map.jpg",
    "Monaco": "https://f1chronicle.com/wp-content/uploads/2024/05/2024-Monaco-Grand-Prix-Track-Map.jpg",
    "Canada": "https://f1chronicle.com/wp-content/uploads/2024/06/2024-Canadian-Grand-Prix-Track-Map.jpg",
    "Spain": "https://f1chronicle.com/wp-content/uploads/2024/06/2024-Spanish-Grand-Prix-Track-Map.jpg",
    "Great Britain": "https://f1chronicle.com/wp-content/uploads/2024/07/2024-British-Grand-Prix-Track-Map.jpg",
    "Hungary": "https://f1chronicle.com/wp-content/uploads/2024/07/2024-Hungarian-Grand-Prix-Track-Map.jpg",
    "Belgium": "https://f1chronicle.com/wp-content/uploads/2024/07/2024-Belgian-Grand-Prix-Track-Map.jpg",
    "Italy": "https://f1chronicle.com/wp-content/uploads/2024/08/2024-Italian-Grand-Prix-Track-Map.jpg",
    "Mexico": "https://f1chronicle.com/wp-content/uploads/2024/10/2024-Mexico-City-Grand-Prix-Track-Map.jpg",
    "Brazil": "https://f1chronicle.com/wp-content/uploads/2024/10/2024-Brazilian-Grand-Prix-Track-Map.jpg",
    "Qatar": "https://f1chronicle.com/wp-content/uploads/2023/10/2023-Qatar-Grand-Prix-Track-Map.jpg"
  };
  return trackImages[sessionName] || "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1200&q=80";
}

function isRealF1Driver(driverName) {
  const realF1Drivers = [
    "Max Verstappen", "Sergio Perez", "Lewis Hamilton", "George Russell",
    "Charles Leclerc", "Carlos Sainz", "Lando Norris", "Oscar Piastri",
    "Fernando Alonso", "Lance Stroll", "Esteban Ocon", "Pierre Gasly",
    "Yuki Tsunoda", "Daniel Ricciardo", "Nico Hulkenberg", "Kevin Magnussen",
    "Alexander Albon", "Logan Sargeant", "Valtteri Bottas", "Zhou Guanyu",
    "Oliver Bearman", "Liam Lawson", "Isack Hadjar", "Jack Doohan",
    "Andrea Kimi Antonelli", "Kimi Antonelli", "Gabriel Bortoleto"
  ];
  return realF1Drivers.includes(driverName);
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
        team: row.team || "",
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

  // Custom race order for the Slayter League
  const raceOrder = [
    "Abu Dhabi",
    "Las Vegas", 
    "Bahrain",
    "Saudi Arabia",
    "Azerbaijan",
    "Miami",
    "Japan",
    "Austria",
    "Singapore",
    "Netherlands",
    "Australia",
    "United States"
  ];

  const ordered = state.sessions
    .slice()
    .sort((a, b) => {
      const aIndex = raceOrder.indexOf(a.name);
      const bIndex = raceOrder.indexOf(b.name);
      
      // If both are in the race order, sort by custom order (reverse for most recent first)
      if (aIndex !== -1 && bIndex !== -1) {
        return bIndex - aIndex;
      }
      
      // If only one is in the race order, prioritize it
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      
      // Fall back to date sorting for any races not in the custom order
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
      // Filter out real F1 drivers but keep original positions
      const filteredResults = session.results.filter(result => !isRealF1Driver(result.driver));
      
      // Get winner info (first non-AI driver)
      const winner = filteredResults.length > 0 ? filteredResults[0] : null;
      const winnerName = winner ? winner.driver : "TBD";
      
      // Get track image
      const trackImage = getTrackImage(session.name);
      
      const highlights = session.highlights.length
        ? `<div class="session__highlights">${session.highlights
            .map((highlight) => `<span class="session__highlight-badge">${highlight}</span>`)
            .join("")}</div>`
        : "";

      // Render top 3 podium positions with special styling (excluding AI drivers)
      const podiumResults = filteredResults.slice(0, 3);
      const otherResults = filteredResults.slice(3, 10); // Show top 10
      
      const podiumMarkup = podiumResults.length
        ? podiumResults
            .map((result) => {
              const position = result.position !== null ? result.position : "—";
              const points = Number.isFinite(result.points) ? result.points : 0;
              const fastest = result.fastestLap ? "⚡" : "";
              
              let positionClass = "";
              let positionLabel = "";
              if (position === 1) {
                positionClass = "session__podium-item--gold";
                positionLabel = "🥇";
              } else if (position === 2) {
                positionClass = "session__podium-item--silver";
                positionLabel = "🥈";
              } else if (position === 3) {
                positionClass = "session__podium-item--bronze";
                positionLabel = "🥉";
              }

              return `
                <div class="session__podium-item ${positionClass}">
                  <div class="session__podium-position">
                    <span class="session__podium-medal">${positionLabel}</span>
                    <span class="session__podium-p">P${position}</span>
                  </div>
                  <div class="session__podium-driver">
                    <span class="session__podium-name">${result.driver}</span>
                    <span class="session__podium-points">${points} pts ${fastest}</span>
                  </div>
                </div>
              `;
            })
            .join("")
        : "";

      const otherResultsMarkup = otherResults.length
        ? `<div class="session__other-results">
            <div class="session__other-header">Remaining Top 10</div>
            ${otherResults
              .map((result) => {
                const position = result.position !== null ? result.position : "—";
                const points = Number.isFinite(result.points) ? result.points : 0;
                const fastest = result.fastestLap ? "⚡" : "";
                
                return `
                  <div class="session__other-item">
                    <span class="session__other-position">P${position}</span>
                    <span class="session__other-driver">${result.driver}</span>
                    <span class="session__other-points">${points} pts ${fastest}</span>
                  </div>
                `;
              })
              .join("")}
          </div>`
        : "";

      const results = filteredResults.length
        ? `<div class="session__podium">${podiumMarkup}</div>${otherResultsMarkup}`
        : '<p class="session__empty">No league member results recorded for this session.</p>';

      return `
        <article class="session">
          <div class="session__track-image">
            <img src="${trackImage}" alt="${session.name || 'Circuit'} Track Map" loading="lazy" decoding="async" />
            <div class="session__track-overlay">
              <span class="session__track-label">Track Map</span>
            </div>
          </div>
          <div class="session__banner">
            <div class="session__banner-content">
              <div class="session__banner-left">
                <span class="session__banner-label">Grand Prix</span>
                <h4 class="session__banner-title">${session.name || "Unnamed Session"}</h4>
                <p class="session__banner-date">📅 ${formatDate(session.date)}</p>
              </div>
              <div class="session__banner-right">
                <span class="session__banner-winner-label">Race Winner</span>
                <span class="session__banner-winner-name">🏆 ${winnerName}</span>
              </div>
            </div>
          </div>
          ${highlights}
          <div class="session__results-container">${results}</div>
        </article>
      `;
    })
    .join("");

  elements.sessionList.innerHTML = markup;
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

  renderLeaderboard(currentSortKey);
  updateInsights();
  renderSessions();
  loadData();
}

init();

// Scroll Progress Indicator
function updateScrollProgress() {
  const scrollProgress = document.querySelector('.scroll-progress');
  if (!scrollProgress) return;
  
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight - windowHeight;
  const scrolled = window.scrollY;
  const progress = (scrolled / documentHeight) * 100;
  
  scrollProgress.style.width = `${progress}%`;
}

// Dynamic Navigation Menu Position
function updateNavPosition() {
  const navMenu = document.querySelector('.nav-menu');
  if (!navMenu) return;
  
  const scrolled = window.scrollY;
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;
  const distanceFromBottom = documentHeight - (scrolled + windowHeight);
  
  // Thresholds for position changes (lower thresholds for faster transition)
  const topThreshold = 150; // Show top menu when within 150px of top
  const bottomThreshold = 400; // Show bottom menu when within 400px of bottom
  
  // On smaller screens (tablets and mobile), don't use side menu
  const usesSideMenu = window.innerWidth > 1200;
  
  // Remove all position classes first
  navMenu.classList.remove('nav-menu--top', 'nav-menu--side', 'nav-menu--bottom');
  
  if (scrolled < topThreshold) {
    // At the top of the page
    navMenu.classList.add('nav-menu--top');
    console.log('Menu: Top');
  } else if (distanceFromBottom < bottomThreshold) {
    // Near the bottom of the page
    navMenu.classList.add('nav-menu--bottom');
    console.log('Menu: Bottom');
  } else {
    // In the middle - show on side (desktop only)
    if (usesSideMenu) {
      navMenu.classList.add('nav-menu--side');
      console.log('Menu: Side (Right)');
    } else {
      navMenu.classList.add('nav-menu--top');
      console.log('Menu: Top (Mobile/Tablet)');
    }
  }
}

// Combined scroll handler
function handleScroll() {
  updateScrollProgress();
  updateNavPosition();
}

// Initialize on load
updateNavPosition();

window.addEventListener('scroll', handleScroll, { passive: true });
window.addEventListener('resize', handleScroll, { passive: true });
