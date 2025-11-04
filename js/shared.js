// Shared utilities and data management for F1 Slayter League

const DATA_SOURCE = "../data/league-data.csv";

// Global state
const appState = {
  drivers: [],
  sessions: [],
  isLoading: false,
  error: null,
};

// CSV Parsing Utilities
function splitCsvRows(text) {
  const rows = [];
  let currentValue = "";
  let currentRow = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      const nextChar = text[index + 1];
      if (inQuotes && nextChar === '"') {
        currentValue += '"';
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

// Data Transformation
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

// Format Date
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

// Team Color Mapping
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

const driverColorPalette = [
  "#FF6B6B", "#F7B32B", "#59C9A5", "#4D9DE0", "#9D4EDD",
  "#FF7F50", "#2EC4B6", "#F86624", "#118AB2", "#EF476F",
  "#FFD166", "#06D6A0", "#073B4C", "#A2D2FF", "#B5179E",
  "#FF8FAB", "#00BBF9", "#F15BB5", "#43AA8B", "#D4A373"
];

const driverColorCache = new Map();

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

function getDriverColor(driverName = "") {
  const name = driverName.trim();
  if (!name) return "#888888";

  if (driverColorCache.has(name)) {
    return driverColorCache.get(name);
  }

  const hash = Math.abs(hashString(name));
  const color = driverColorPalette[hash % driverColorPalette.length];
  driverColorCache.set(name, color);
  return color;
}

let raceDayNotificationDisplayed = false;
let raceDayNotificationDismissed = false;

function getLocalIsoDate(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function notifyRaceDayIfNeeded() {
  if (raceDayNotificationDisplayed || raceDayNotificationDismissed) return;
  if (typeof document === "undefined") return;

  const { sessions } = appState;
  if (!Array.isArray(sessions) || sessions.length === 0) return;

  const todayIso = getLocalIsoDate();
  const raceToday = sessions.find((session) => session.date === todayIso);
  if (!raceToday) return;

  const existingAlert = document.getElementById("race-day-alert");
  if (existingAlert) {
    const raceNameEl = existingAlert.querySelector("[data-race-name]");
    if (raceNameEl) {
      raceNameEl.textContent = raceToday.name || "Race Day";
    }
    const raceDateEl = existingAlert.querySelector("[data-race-date]");
    if (raceDateEl) {
      raceDateEl.textContent = formatDate(raceToday.date);
    }
    raceDayNotificationDisplayed = true;
    return;
  }

  const alert = document.createElement("section");
  alert.id = "race-day-alert";
  alert.className = "race-day-alert";
  alert.setAttribute("role", "status");
  alert.setAttribute("aria-live", "polite");
  alert.innerHTML = `
    <div class="race-day-alert__content">
      <span class="race-day-alert__icon" aria-hidden="true">🏁</span>
      <div class="race-day-alert__message">
        <strong data-race-name>${raceToday.name || "Race Day"}</strong>
        <p>
          It's race day! ${raceToday.name ? `${raceToday.name} is on the schedule for` : "Your league has an event on"}
          <span data-race-date>${formatDate(raceToday.date)}</span>.
        </p>
      </div>
      <button type="button" class="race-day-alert__close" aria-label="Dismiss race day alert">×</button>
    </div>
  `;

  const closeButton = alert.querySelector(".race-day-alert__close");
  if (closeButton) {
    closeButton.addEventListener("click", () => {
      raceDayNotificationDismissed = true;
      alert.classList.add("race-day-alert--closing");
      window.setTimeout(() => {
        alert.remove();
      }, 200);
    });
  }

  const navMenu = document.querySelector(".nav-menu");
  if (navMenu && navMenu.parentNode) {
    navMenu.parentNode.insertBefore(alert, navMenu.nextSibling);
  } else {
    document.body.prepend(alert);
  }

  raceDayNotificationDisplayed = true;
}

// Track Image Mapping
function getTrackImage(sessionName) {
  const trackImages = {
    "Abu Dhabi": "../assets/tracks/abu-dhabi.avif",
    "Las Vegas": "../assets/tracks/las-vegas.png",
    "Bahrain": "../assets/tracks/bahrain.avif",
    "Saudi Arabia": "../assets/tracks/saudi-arabia.jpg",
    "Azerbaijan": "../assets/tracks/azerbaijan.jpg",
    "Miami": "../assets/tracks/miami.jpg",
    "Austria": "../assets/tracks/austria.avif",
    "Singapore": "../assets/tracks/singapore.jpg",
    "Australia": "../assets/tracks/australia.jpg",
    "United States": "../assets/tracks/united-states.jpg",
    "Japan": "https://f1chronicle.com/wp-content/uploads/2024/04/2024-Japanese-Grand-Prix-Track-Map.jpg",
    "Netherlands": "https://f1chronicle.com/wp-content/uploads/2024/08/2024-Dutch-Grand-Prix-Track-Map.jpg",
  };
  return trackImages[sessionName] || "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1200&q=80";
}

// Load Data
async function loadData() {
  if (appState.isLoading) return appState;
  
  appState.isLoading = true;
  appState.error = null;

  try {
    const response = await fetch(DATA_SOURCE, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load data: ${response.status}`);
    }

    const csvText = await response.text();
    const rows = parseCsv(csvText);
    const { drivers, sessions } = transformRows(rows);

    appState.drivers = drivers;
    appState.sessions = sessions;
    appState.isLoading = false;

    return appState;
  } catch (error) {
    console.error("Unable to load league data", error);
    appState.error = error;
    appState.drivers = [];
    appState.sessions = [];
    appState.isLoading = false;
    return appState;
  }
}

// Scroll Progress
function updateScrollProgress() {
  const scrollProgress = document.querySelector('.scroll-progress');
  if (!scrollProgress) return;
  
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight - windowHeight;
  const scrolled = window.scrollY;
  const progress = (scrolled / documentHeight) * 100;
  
  scrollProgress.style.width = `${progress}%`;
}

// Initialize scroll progress
window.addEventListener('scroll', updateScrollProgress, { passive: true });
window.addEventListener('resize', updateScrollProgress, { passive: true });

// Modal Utilities
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('is-active');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('is-active');
    document.body.style.overflow = '';
  }
}

// Set up modal close handlers
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal__close').forEach(closeBtn => {
    closeBtn.addEventListener('click', () => {
      const modal = closeBtn.closest('.modal');
      if (modal) {
        modal.classList.remove('is-active');
        document.body.style.overflow = '';
      }
    });
  });

  document.querySelectorAll('.modal__overlay').forEach(overlay => {
    overlay.addEventListener('click', () => {
      const modal = overlay.closest('.modal');
      if (modal) {
        modal.classList.remove('is-active');
        document.body.style.overflow = '';
      }
    });
  });
});

// Export for use in other files
window.F1SlayterShared = {
  loadData,
  formatDate,
  getTeamColor,
  getDriverColor,
  getTrackImage,
  isRealF1Driver,
  openModal,
  closeModal,
  notifyRaceDayIfNeeded,
  appState,
};

