// Home page functionality

const { loadData, formatDate, appState } = window.F1SlayterShared;

async function initHomePage() {
  await loadData();
  
  updateQuickStats();
  renderRecentHighlights();
}

function updateQuickStats() {
  const { drivers, sessions } = appState;
  
  // Championship Leader
  const standings = drivers.slice().sort((a, b) => b.points - a.points);
  const leader = standings[0];
  
  const leaderNameEl = document.getElementById('homeLeaderName');
  const leaderPointsEl = document.getElementById('homeLeaderPoints');
  
  if (leaderNameEl && leader) {
    leaderNameEl.textContent = leader.name || "-";
  }
  if (leaderPointsEl && leader) {
    leaderPointsEl.textContent = `${leader.points} points`;
  }
  
  // Races Completed
  const racesCompletedEl = document.getElementById('homeRacesCompleted');
  if (racesCompletedEl) {
    racesCompletedEl.textContent = sessions.length;
  }
  
  // Active Drivers (non-AI drivers with points)
  const activeDriversEl = document.getElementById('homeActiveDrivers');
  if (activeDriversEl) {
    const activeCount = drivers.filter(d => !window.F1SlayterShared.isRealF1Driver(d.name) || d.points > 0).length;
    activeDriversEl.textContent = activeCount;
  }
  
  // Next Race
  const raceOrder = [
    "Abu Dhabi", "Las Vegas", "Bahrain", "Saudi Arabia", "Azerbaijan",
    "Miami", "Japan", "Austria", "Singapore", "Netherlands", "Australia", "United States"
  ];
  
  const completedRaces = sessions.map(s => s.name);
  const nextRace = raceOrder.find(race => !completedRaces.includes(race));
  
  const nextRaceEl = document.getElementById('homeNextRace');
  const nextRaceDateEl = document.getElementById('homeNextRaceDate');
  
  if (nextRaceEl) {
    nextRaceEl.textContent = nextRace || "Season Complete";
  }
  if (nextRaceDateEl && nextRace) {
    const raceCalendar = {
      "Azerbaijan": "Nov 4 • 8:00 PM ET",
      "Miami": "Nov 11 • 8:00 PM ET",
      "Japan": "Nov 18 • 8:00 PM ET",
      "Austria": "Nov 25 • 8:00 PM ET",
      "Singapore": "Dec 9 • 8:00 PM ET",
      "Netherlands": "Dec 16 • 8:00 PM ET",
      "Australia": "Dec 23 • 8:00 PM ET",
      "United States": "Dec 30 • 8:00 PM ET"
    };
    nextRaceDateEl.textContent = raceCalendar[nextRace] || "TBD";
  }
}

function renderRecentHighlights() {
  const { sessions } = appState;
  const container = document.getElementById('recentHighlights');
  
  if (!container) return;
  
  if (!sessions.length) {
    container.innerHTML = '<p class="sessions__empty">No recent activity to display.</p>';
    return;
  }
  
  const recentSessions = sessions.slice(0, 3);
  
  const markup = recentSessions.map(session => {
    const winner = session.results.filter(r => !window.F1SlayterShared.isRealF1Driver(r.driver))[0];
    const winnerName = winner ? winner.driver : "TBD";
    
    return `
      <div class="highlight-item">
        <h4 style="font-family: 'Orbitron', sans-serif; margin: 0 0 0.5rem; font-size: 1.1rem;">
          ${session.name || "Unnamed Session"}
        </h4>
        <p style="margin: 0; color: rgba(255, 255, 255, 0.7); font-size: 0.9rem;">
          🏆 Winner: <strong>${winnerName}</strong> • 📅 ${formatDate(session.date)}
        </p>
        ${session.highlights.length ? `
          <div style="margin-top: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem;">
            ${session.highlights.map(h => 
              `<span style="font-size: 0.75rem; padding: 0.25rem 0.6rem; background: rgba(225, 6, 0, 0.15); 
              border: 1px solid rgba(225, 6, 0, 0.3); border-radius: 999px;">${h}</span>`
            ).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  container.innerHTML = markup;
}

// Initialize on load
document.addEventListener('DOMContentLoaded', initHomePage);

