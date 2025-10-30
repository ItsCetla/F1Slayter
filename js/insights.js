// Insights page functionality

(function() {
  'use strict';
  
  const { loadData, getTeamColor, appState } = window.F1SlayterShared;

async function initInsightsPage() {
  await loadData();
  
  updateKeyInsights();
  renderPerformanceAnalysis();
  renderPodiumStats();
}

function updateKeyInsights() {
  const { drivers } = appState;
  
  // Filter out real F1 drivers (AI drivers)
  const leagueDrivers = drivers.filter(d => !window.F1SlayterShared.isRealF1Driver(d.name));
  
  // Championship Leader
  const standings = leagueDrivers.slice().sort((a, b) => b.points - a.points);
  const leader = standings[0];
  
  const leaderNameEl = document.getElementById('leaderName');
  const leaderPointsEl = document.getElementById('leaderPoints');
  
  if (leaderNameEl && leader) {
    leaderNameEl.textContent = leader.name || "-";
  }
  if (leaderPointsEl && leader) {
    leaderPointsEl.textContent = `${leader.points} pts`;
  }
  
  // Most Wins
  const winsLeader = leagueDrivers.slice().sort((a, b) => {
    if (b.wins === a.wins) {
      return b.points - a.points;
    }
    return b.wins - a.wins;
  })[0];
  
  const winsLeaderEl = document.getElementById('winsLeader');
  const winsCountEl = document.getElementById('winsCount');
  
  if (winsLeaderEl && winsLeader) {
    winsLeaderEl.textContent = winsLeader.name || "-";
  }
  if (winsCountEl && winsLeader) {
    winsCountEl.textContent = `${winsLeader.wins} wins`;
  }
  
  // Driver to Watch
  const watchPool = standings
    .map((driver, index) => {
      const currentRank = index + 1;
      const previousRank = driver.previousRank || currentRank;
      const improvement = previousRank - currentRank;
      return { driver, currentRank, previousRank, improvement };
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
  
  const watchNameEl = document.getElementById('watchName');
  const watchMetaEl = document.getElementById('watchMeta');
  
  if (watchNameEl && watchCandidate) {
    watchNameEl.textContent = watchCandidate.driver.name || "-";
  }
  if (watchMetaEl && watchCandidate) {
    if (watchCandidate.improvement > 0) {
      watchMetaEl.textContent = `Up ${watchCandidate.improvement} places • Now P${watchCandidate.currentRank}`;
    } else {
      watchMetaEl.textContent = `P${watchCandidate.currentRank} • Watch for momentum`;
    }
  }
}

function renderPerformanceAnalysis() {
  const { drivers } = appState;
  const container = document.getElementById('performanceAnalysis');
  
  if (!container) return;
  
  // Filter out real F1 drivers (AI drivers)
  const leagueDrivers = drivers.filter(d => !window.F1SlayterShared.isRealF1Driver(d.name));
  const sorted = leagueDrivers.slice().sort((a, b) => b.points - a.points).slice(0, 5);
  
  const maxPoints = sorted[0]?.points || 1;
  
  const markup = sorted.map(driver => {
    const percentage = (driver.points / maxPoints) * 100;
    
    return `
      <div style="margin-bottom: 1.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <strong style="font-size: 1.05rem;">${driver.name}</strong>
          <span style="font-family: 'Orbitron', sans-serif; color: var(--color-primary); font-size: 1.1rem;">
            ${driver.points} pts
          </span>
        </div>
        <div style="height: 12px; background: rgba(255, 255, 255, 0.1); border-radius: 999px; overflow: hidden;">
          <div style="height: 100%; width: ${percentage}%; background: linear-gradient(90deg, var(--color-primary), #ff4a1f); 
                      border-radius: 999px; transition: width 600ms ease;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.85rem; 
                    color: rgba(255, 255, 255, 0.6);">
          <span>🏆 ${driver.wins} wins • 🏅 ${driver.podiums} podiums</span>
          <span>⚡ ${driver.fastestLaps} fastest laps</span>
        </div>
      </div>
    `;
  }).join('');
  
  container.innerHTML = markup || '<p style="text-align: center; color: rgba(255, 255, 255, 0.6);">No data available.</p>';
}


function renderPodiumStats() {
  const { drivers } = appState;
  const container = document.getElementById('podiumStats');
  
  if (!container) return;
  
  // Filter out real F1 drivers (AI drivers)
  const leagueDrivers = drivers.filter(d => !window.F1SlayterShared.isRealF1Driver(d.name));
  
  const topPodiumDrivers = leagueDrivers
    .filter(d => d.podiums > 0)
    .sort((a, b) => b.podiums - a.podiums)
    .slice(0, 8);
  
  const markup = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
      ${topPodiumDrivers.map(driver => {
        const podiumRate = driver.podiums > 0 ? ((driver.podiums / appState.sessions.length) * 100).toFixed(0) : 0;
        
        return `
          <div style="text-align: center; padding: 1.5rem; background: rgba(255, 255, 255, 0.05); 
                      border-radius: var(--radius-md); border-top: 3px solid var(--color-primary);">
            <div style="font-size: 2.5rem; font-family: 'Orbitron', sans-serif; color: var(--color-primary); margin-bottom: 0.5rem;">
              ${driver.podiums}
            </div>
            <div style="font-weight: 600; margin-bottom: 0.25rem;">${driver.name}</div>
            <div style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6);">
              ${podiumRate}% podium rate
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  
  container.innerHTML = markup || '<p style="text-align: center; color: rgba(255, 255, 255, 0.6);">No podium data available.</p>';
}

  // Initialize on load
  document.addEventListener('DOMContentLoaded', initInsightsPage);
})();

