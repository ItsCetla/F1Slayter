// Calendar page functionality

(function() {
  'use strict';
  
  const { loadData, formatDate, getTrackImage, openModal, closeModal, appState } = window.F1SlayterShared;

async function initCalendarPage() {
  await loadData();
  
  updateSeasonProgress();
  setupFilterControls();
}

function setupFilterControls() {
  const calendarView = document.getElementById('calendarView');
  if (calendarView) {
    calendarView.addEventListener('change', (e) => {
      filterCalendar(e.target.value);
    });
  }
}

function filterCalendar(view) {
  const items = document.querySelectorAll('.calendar__item');
  
  items.forEach(item => {
    if (view === 'all') {
      item.style.display = '';
    } else if (view === 'completed') {
      item.style.display = item.classList.contains('calendar__item--completed') ? '' : 'none';
    } else if (view === 'upcoming') {
      item.style.display = (item.classList.contains('calendar__item--upcoming') || 
                           item.classList.contains('calendar__item--future')) ? '' : 'none';
    }
  });
}

function updateSeasonProgress() {
  const { sessions } = appState;
  const totalRaces = 12;
  const completedRaces = sessions.length;
  const progress = (completedRaces / totalRaces) * 100;
  
  const progressFill = document.getElementById('seasonProgressFill');
  const racesCompletedText = document.getElementById('racesCompleted');
  
  if (progressFill) {
    progressFill.style.width = `${progress}%`;
  }
  
  if (racesCompletedText) {
    racesCompletedText.textContent = `${completedRaces} of ${totalRaces}`;
  }
}

function showRaceDetails(raceName) {
  const { sessions } = appState;
  const session = sessions.find(s => s.name === raceName);
  const trackImage = getTrackImage(raceName);
  
  const raceInfo = {
    "Abu Dhabi": { circuit: "Yas Marina Circuit", laps: 58, distance: "5.281 km", country: "🇦🇪 UAE" },
    "Las Vegas": { circuit: "Las Vegas Street Circuit", laps: 50, distance: "6.201 km", country: "🇺🇸 USA" },
    "Bahrain": { circuit: "Bahrain International Circuit", laps: 57, distance: "5.412 km", country: "🇧🇭 Bahrain" },
    "Saudi Arabia": { circuit: "Jeddah Corniche Circuit", laps: 50, distance: "6.174 km", country: "🇸🇦 Saudi Arabia" },
    "Azerbaijan": { circuit: "Baku City Circuit", laps: 51, distance: "6.003 km", country: "🇦🇿 Azerbaijan" },
    "Miami": { circuit: "Miami International Autodrome", laps: 57, distance: "5.412 km", country: "🇺🇸 USA" },
    "Japan": { circuit: "Suzuka Circuit", laps: 53, distance: "5.807 km", country: "🇯🇵 Japan" },
    "Austria": { circuit: "Red Bull Ring", laps: 71, distance: "4.318 km", country: "🇦🇹 Austria" },
    "Singapore": { circuit: "Marina Bay Street Circuit", laps: 62, distance: "4.940 km", country: "🇸🇬 Singapore" },
    "Netherlands": { circuit: "Circuit Zandvoort", laps: 72, distance: "4.259 km", country: "🇳🇱 Netherlands" },
    "Australia": { circuit: "Albert Park Circuit", laps: 58, distance: "5.278 km", country: "🇦🇺 Australia" },
    "United States": { circuit: "Circuit of the Americas", laps: 56, distance: "5.513 km", country: "🇺🇸 USA" }
  };
  
  const info = raceInfo[raceName] || { circuit: "Unknown Circuit", laps: "TBD", distance: "TBD", country: "" };
  
  const content = `
    <div class="race-detail">
      <img src="${trackImage}" alt="${raceName} Track" 
           style="width: 100%; border-radius: var(--radius-md); margin-bottom: 1.5rem;" />
      
      <h2 style="font-family: 'Orbitron', sans-serif; font-size: 2rem; margin: 0 0 0.5rem;">
        ${raceName} Grand Prix
      </h2>
      <p style="color: rgba(255, 255, 255, 0.7); margin: 0 0 2rem; font-size: 1.1rem;">
        ${info.country} ${info.circuit}
      </p>
      
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
        <div style="text-align: center; padding: 1rem; background: rgba(255, 255, 255, 0.05); border-radius: var(--radius-md);">
          <div style="font-family: 'Orbitron', sans-serif; font-size: 1.75rem; color: var(--color-primary);">
            ${info.laps}
          </div>
          <div style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6); text-transform: uppercase; margin-top: 0.25rem;">
            Laps
          </div>
        </div>
        <div style="text-align: center; padding: 1rem; background: rgba(255, 255, 255, 0.05); border-radius: var(--radius-md);">
          <div style="font-family: 'Orbitron', sans-serif; font-size: 1.75rem; color: var(--color-primary);">
            ${info.distance}
          </div>
          <div style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6); text-transform: uppercase; margin-top: 0.25rem;">
            Lap Length
          </div>
        </div>
      </div>
      
      ${session ? `
        <div style="padding: 1.5rem; background: rgba(225, 6, 0, 0.1); border-left: 3px solid var(--color-primary); 
                    border-radius: var(--radius-md); margin-bottom: 1rem;">
          <h3 style="font-family: 'Orbitron', sans-serif; font-size: 1.1rem; margin: 0 0 0.75rem;">
            Race Complete
          </h3>
          <p style="margin: 0; color: rgba(255, 255, 255, 0.8);">
            📅 ${formatDate(session.date)}
          </p>
          ${session.results.filter(r => !window.F1SlayterShared.isRealF1Driver(r.driver))[0] ? `
            <p style="margin: 0.5rem 0 0; font-size: 1.1rem;">
              🏆 Winner: <strong>${session.results.filter(r => !window.F1SlayterShared.isRealF1Driver(r.driver))[0].driver}</strong>
            </p>
          ` : ''}
        </div>
        <a href="sessions.html" style="display: inline-block; padding: 0.75rem 1.5rem; background: var(--color-primary); 
                                        color: #fff; text-decoration: none; border-radius: var(--radius-md); 
                                        font-weight: 600; text-align: center;">
          View Full Race Results
        </a>
      ` : `
        <div style="padding: 1.5rem; background: rgba(255, 255, 255, 0.05); border-radius: var(--radius-md); 
                    text-align: center;">
          <p style="margin: 0; color: rgba(255, 255, 255, 0.7);">
            This race hasn't been completed yet. Check back after the race day!
          </p>
        </div>
      `}
    </div>
  `;
  
  const contentDiv = document.getElementById('raceDetailContent');
  if (contentDiv) {
    contentDiv.innerHTML = content;
  }
  
  openModal('raceModal');
}

  // Make function globally available for onclick
  window.showRaceDetails = showRaceDetails;

  // Initialize on load
  document.addEventListener('DOMContentLoaded', initCalendarPage);
})();

