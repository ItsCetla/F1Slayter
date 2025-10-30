// Sessions page functionality

(function() {
  'use strict';
  
  const { loadData, formatDate, getTrackImage, isRealF1Driver, openModal, closeModal, appState } = window.F1SlayterShared;

  let currentFilter = "all";

async function initSessionsPage() {
  await loadData();
  
  renderSessions();
  setupFilterControls();
}

function setupFilterControls() {
  const filterSelect = document.getElementById('sessionFilter');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      currentFilter = e.target.value;
      renderSessions();
    });
  }
}

function renderSessions() {
  const { sessions } = appState;
  const container = document.getElementById('sessionList');
  const statusMessage = document.getElementById('statusMessage');
  
  if (!container) return;
  
  if (!sessions.length) {
    container.innerHTML = '<p class="sessions__empty">No session data available.</p>';
    if (statusMessage) {
      statusMessage.textContent = '';
    }
    return;
  }
  
  // Custom race order
  const raceOrder = [
    "Abu Dhabi", "Las Vegas", "Bahrain", "Saudi Arabia", "Azerbaijan",
    "Miami", "Japan", "Austria", "Singapore", "Netherlands", "Australia", "United States"
  ];
  
  let ordered = sessions.slice().sort((a, b) => {
    const aIndex = raceOrder.indexOf(a.name);
    const bIndex = raceOrder.indexOf(b.name);
    
    if (aIndex !== -1 && bIndex !== -1) {
      return bIndex - aIndex; // Reverse for most recent first
    }
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    
    if (a.date && b.date) {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    }
    return 0;
  });
  
  // Apply filter
  if (currentFilter === "recent") {
    ordered = ordered.slice(0, 3);
  }
  
  const markup = ordered.map((session) => {
    const filteredResults = session.results.filter(result => !isRealF1Driver(result.driver));
    const winner = filteredResults.length > 0 ? filteredResults[0] : null;
    const winnerName = winner ? winner.driver : "TBD";
    const trackImage = getTrackImage(session.name);
    
    const highlights = session.highlights.length
      ? `<div class="session__highlights">${session.highlights
          .map((highlight) => `<span class="session__highlight-badge">${highlight}</span>`)
          .join("")}</div>`
      : "";
    
    const podiumResults = filteredResults.slice(0, 3);
    const otherResults = filteredResults.slice(3, 10);
    
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
      <article class="session" onclick="showSessionDetail('${session.name.replace(/'/g, "\\'")}')">
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
  }).join('');
  
  container.innerHTML = markup;
  
  if (statusMessage) {
    statusMessage.textContent = `Showing ${ordered.length} session${ordered.length !== 1 ? 's' : ''}`;
    statusMessage.style.color = 'var(--color-success)';
  }
}

function showSessionDetail(sessionName) {
  const { sessions } = appState;
  const session = sessions.find(s => s.name === sessionName);
  
  if (!session) return;
  
  const filteredResults = session.results.filter(result => !isRealF1Driver(result.driver));
  const trackImage = getTrackImage(session.name);
  
  const content = `
    <div class="session-detail__header">
      <img src="${trackImage}" alt="${session.name} Track" 
           style="width: 100%; border-radius: var(--radius-md); margin-bottom: 1rem;" />
      <h2 style="font-family: 'Orbitron', sans-serif; font-size: 2rem; margin: 0 0 0.5rem;">
        ${session.name}
      </h2>
      <p style="color: rgba(255, 255, 255, 0.7); margin: 0;">
        📅 ${formatDate(session.date)}
      </p>
    </div>
    
    ${session.highlights.length ? `
      <div style="margin-bottom: 1.5rem;">
        <h3 style="font-family: 'Orbitron', sans-serif; font-size: 1.1rem; margin-bottom: 0.75rem;">
          Race Highlights
        </h3>
        <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
          ${session.highlights.map(h => 
            `<span class="session__highlight-badge">${h}</span>`
          ).join('')}
        </div>
      </div>
    ` : ''}
    
    <div>
      <h3 style="font-family: 'Orbitron', sans-serif; font-size: 1.1rem; margin-bottom: 1rem;">
        Full Results
      </h3>
      <div style="display: grid; gap: 0.5rem;">
        ${filteredResults.map(result => {
          const podiumColors = {
            1: '#FFD700',
            2: '#C0C0C0',
            3: '#CD7F32'
          };
          const borderColor = podiumColors[result.position] || 'rgba(255, 255, 255, 0.1)';
          
          return `
            <div style="padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); 
                        border-left: 3px solid ${borderColor}; border-radius: var(--radius-sm);
                        display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 1.1rem;">P${result.position}</strong>
                <span style="margin-left: 1rem;">${result.driver}</span>
              </div>
              <div style="text-align: right;">
                <strong style="color: var(--color-primary);">${result.points} pts</strong>
                ${result.fastestLap ? '<span style="margin-left: 0.5rem;">⚡ FL</span>' : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
  
  const contentDiv = document.getElementById('sessionDetailContent');
  if (contentDiv) {
    contentDiv.innerHTML = content;
  }
  
  openModal('sessionModal');
}

  // Make function globally available for onclick
  window.showSessionDetail = showSessionDetail;

  // Initialize on load
  document.addEventListener('DOMContentLoaded', initSessionsPage);
})();

