// Standings page functionality

const { loadData, getTeamColor, openModal, closeModal, appState } = window.F1SlayterShared;

let currentSortKey = "points";

async function initStandingsPage() {
  await loadData();
  
  renderLeaderboard();
  renderTopThree();
  setupSortingControls();
}

function setupSortingControls() {
  const sortSelect = document.getElementById('sortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      currentSortKey = e.target.value;
      renderLeaderboard();
    });
  }
}

function renderLeaderboard() {
  const { drivers } = appState;
  const leaderboardBody = document.getElementById('leaderboardBody');
  
  if (!leaderboardBody) return;
  
  if (!drivers.length) {
    leaderboardBody.innerHTML = '<tr><td class="leaderboard__empty" colspan="8">No driver data available.</td></tr>';
    return;
  }
  
  const sorted = drivers.slice().sort((a, b) => {
    const valueA = typeof a[currentSortKey] === "number" ? a[currentSortKey] : 0;
    const valueB = typeof b[currentSortKey] === "number" ? b[currentSortKey] : 0;

    if (valueB === valueA) {
      return (typeof b.points === "number" ? b.points : 0) - (typeof a.points === "number" ? a.points : 0);
    }

    return valueB - valueA;
  });
  
  const rows = sorted.map((driver, index) => {
    const tags = [];
    if (index === 0 && currentSortKey === "points") {
      tags.push('<span class="badge badge--leader">Leader</span>');
    }
    if (driver.fastestLaps > 0 && currentSortKey === "fastestLaps") {
      tags.push('<span class="badge badge--fastest">FL threat</span>');
    }

    const code = driver.code ? `<span style="font-size: 0.75rem; color: var(--color-muted);">${driver.code}</span>` : "";
    const teamColor = getTeamColor(driver.team);
    
    return `
      <tr onclick="showDriverDetail('${driver.name.replace(/'/g, "\\'")}')">
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
        <td data-label="Team">
          <div class="team-badge">
            <span class="team-badge__color" style="--team-color: ${teamColor};"></span>
            <span class="team-badge__name">${driver.team || "-"}</span>
          </div>
        </td>
        <td data-label="Points">${driver.points}</td>
        <td data-label="Wins">${driver.wins}</td>
        <td data-label="Podiums">${driver.podiums}</td>
        <td data-label="Fastest Laps">${driver.fastestLaps}</td>
        <td data-label="Actions">
          <button 
            onclick="event.stopPropagation(); showDriverDetail('${driver.name.replace(/'/g, "\\'")}')" 
            class="btn btn--ghost" 
            style="padding: 0.4rem 0.75rem; font-size: 0.8rem;"
          >
            View Details
          </button>
        </td>
      </tr>
    `;
  }).join('');
  
  leaderboardBody.innerHTML = rows;
}

function renderTopThree() {
  const { drivers } = appState;
  const container = document.getElementById('topThreeSpotlight');
  
  if (!container) return;
  
  const standings = drivers.slice().sort((a, b) => b.points - a.points);
  const topThree = standings.slice(0, 3);
  
  const markup = topThree.map((driver, index) => {
    const positionClass = ['first', 'second', 'third'][index];
    const medal = ['🥇', '🥈', '🥉'][index];
    const teamColor = getTeamColor(driver.team);
    
    return `
      <div class="spotlight-card spotlight-card--${positionClass}">
        <div style="font-size: 3rem; margin-bottom: 1rem;">${medal}</div>
        <h3 style="font-family: 'Orbitron', sans-serif; font-size: 1.5rem; margin: 0 0 0.5rem;">
          ${driver.name}
        </h3>
        <p style="margin: 0 0 1rem; color: rgba(255, 255, 255, 0.6);">
          ${driver.team}
        </p>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
          <div>
            <div style="font-size: 2rem; font-family: 'Orbitron', sans-serif; color: var(--color-primary);">
              ${driver.points}
            </div>
            <div style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6); text-transform: uppercase;">
              Points
            </div>
          </div>
          <div>
            <div style="font-size: 2rem; font-family: 'Orbitron', sans-serif; color: var(--color-success);">
              ${driver.wins}
            </div>
            <div style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6); text-transform: uppercase;">
              Wins
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  container.innerHTML = markup;
}

function showDriverDetail(driverName) {
  const { drivers, sessions } = appState;
  const driver = drivers.find(d => d.name === driverName);
  
  if (!driver) return;
  
  const driverSessions = sessions.map(session => {
    const result = session.results.find(r => r.driver === driverName);
    if (result) {
      return {
        session: session.name,
        date: session.date,
        position: result.position,
        points: result.points,
        fastestLap: result.fastestLap
      };
    }
    return null;
  }).filter(Boolean);
  
  const teamColor = getTeamColor(driver.team);
  
  const content = `
    <div class="driver-detail__header">
      <h2 class="driver-detail__name">${driver.name}</h2>
      <div class="team-badge" style="justify-content: center;">
        <span class="team-badge__color" style="--team-color: ${teamColor};"></span>
        <span class="team-badge__name">${driver.team}</span>
      </div>
    </div>
    
    <div class="driver-detail__stats">
      <div class="driver-detail__stat">
        <p class="driver-detail__stat-value">${driver.points}</p>
        <p class="driver-detail__stat-label">Points</p>
      </div>
      <div class="driver-detail__stat">
        <p class="driver-detail__stat-value">${driver.wins}</p>
        <p class="driver-detail__stat-label">Wins</p>
      </div>
      <div class="driver-detail__stat">
        <p class="driver-detail__stat-value">${driver.podiums}</p>
        <p class="driver-detail__stat-label">Podiums</p>
      </div>
      <div class="driver-detail__stat">
        <p class="driver-detail__stat-value">${driver.fastestLaps}</p>
        <p class="driver-detail__stat-label">Fastest Laps</p>
      </div>
    </div>
    
    ${driverSessions.length ? `
      <div style="margin-top: 2rem;">
        <h3 style="font-family: 'Orbitron', sans-serif; font-size: 1.2rem; margin-bottom: 1rem;">
          Race History
        </h3>
        <div style="display: grid; gap: 0.75rem;">
          ${driverSessions.map(s => `
            <div style="padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); border-radius: var(--radius-sm); 
                        display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>${s.session}</strong>
                <span style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6); margin-left: 0.5rem;">
                  ${window.F1SlayterShared.formatDate(s.date)}
                </span>
              </div>
              <div style="text-align: right;">
                <strong style="color: var(--color-primary);">P${s.position}</strong>
                <span style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6); margin-left: 0.5rem;">
                  ${s.points} pts ${s.fastestLap ? '⚡' : ''}
                </span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '<p style="text-align: center; color: rgba(255, 255, 255, 0.6); margin-top: 2rem;">No race history available.</p>'}
  `;
  
  const contentDiv = document.getElementById('driverDetailContent');
  if (contentDiv) {
    contentDiv.innerHTML = content;
  }
  
  openModal('driverModal');
}

// Make function globally available for onclick
window.showDriverDetail = showDriverDetail;

// Initialize on load
document.addEventListener('DOMContentLoaded', initStandingsPage);

