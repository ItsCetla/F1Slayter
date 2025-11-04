(function() {
  'use strict';

  const {
    loadData,
    appState,
    getTeamColor,
    getDriverColor,
    isRealF1Driver,
    formatDate,
    notifyRaceDayIfNeeded,
  } = window.F1SlayterShared;

  document.addEventListener('DOMContentLoaded', initAnalyticsPage);

  async function initAnalyticsPage() {
    await loadData();
    notifyRaceDayIfNeeded();

    renderPointsTrajectory();
    renderTeamPerformance();
    renderFormGuide();
  }

  function getLeagueDrivers() {
    return appState.drivers.filter((driver) => driver.name && !isRealF1Driver(driver.name));
  }

  function getOrderedSessions() {
    return appState.sessions
      .slice()
      .sort((a, b) => {
        const aDate = toDateValue(a.date);
        const bDate = toDateValue(b.date);
        if (aDate === null && bDate === null) return 0;
        if (aDate === null) return 1;
        if (bDate === null) return -1;
        return aDate - bDate;
      });
  }

  function toDateValue(value) {
    if (!value) return null;
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }

  function formatSessionLabel(session) {
    if (!session) return 'Session';
    if (session.name && session.name.trim()) return session.name.trim();
    if (session.date) return formatDate(session.date);
    return 'Session';
  }

  function safeAverage(total, count) {
    if (!count) return '0.0';
    return (Math.round((total / count) * 10) / 10).toFixed(1);
  }

  function renderPointsTrajectory() {
    const container = document.getElementById('pointsProgression');
    if (!container) return;

    const leagueDrivers = getLeagueDrivers();
    const sessions = getOrderedSessions();

    if (!leagueDrivers.length || !sessions.length) {
      container.innerHTML = createEmptyState('Points data will appear once sessions have been recorded.');
      return;
    }

    const topDrivers = leagueDrivers
      .slice()
      .sort((a, b) => b.points - a.points || (b.wins || 0) - (a.wins || 0))
      .slice(0, 4);

    const maxRacePoints = Math.max(
      1,
      ...sessions.map((session) =>
        Math.max(0, ...session.results.map((result) => Number(result.points) || 0))
      ),
    );

    const sessionLabelsMarkup = sessions
      .map((session) => `<span>${formatSessionLabel(session)}</span>`)
      .join('');

    const cardsMarkup = topDrivers
      .map((driver) => {
        const driverColor = getDriverColor(driver.name);
        const raceSegments = sessions.map((session) => {
          const result = session.results.find((entry) => entry.driver === driver.name) || null;
          const points = result ? Number(result.points) || 0 : 0;
          const heightRatio = points > 0 ? Math.round((points / maxRacePoints) * 100) : 5;
          const labelParts = [];

          labelParts.push(formatSessionLabel(session));
          if (!result) {
            labelParts.push('no classified finish');
          } else {
            if (typeof result.position === 'number' && Number.isFinite(result.position)) {
              labelParts.push(`finished P${result.position}`);
            }
            labelParts.push(`${points} pts`);
            if (result.fastestLap) {
              labelParts.push('fastest lap');
            }
          }

          let barClass = 'analytics-trend__bar analytics-trend__bar--empty';
          if (result) {
            if (result.position === 1) {
              barClass = 'analytics-trend__bar analytics-trend__bar--win';
            } else if (result.position && result.position <= 3) {
              barClass = 'analytics-trend__bar analytics-trend__bar--podium';
            } else if (points > 0) {
              barClass = 'analytics-trend__bar analytics-trend__bar--points';
            } else {
              barClass = 'analytics-trend__bar analytics-trend__bar--classified';
            }
          }

          return `
            <div
              class="${barClass}"
              style="height: ${Math.min(100, Math.max(0, heightRatio))}%; --driver-accent: ${driverColor};"
              role="presentation"
              aria-hidden="true"
              title="${labelParts.join(' • ')}"
            ></div>
          `;
        });

        const totalPoints = raceSegments.reduce((sum, _, index) => {
          const session = sessions[index];
          const result = session.results.find((entry) => entry.driver === driver.name);
          return sum + (result ? Number(result.points) || 0 : 0);
        }, 0);

        const appearances = sessions.reduce((count, session) => {
          const result = session.results.find((entry) => entry.driver === driver.name);
          return count + (result && typeof result.position === 'number' ? 1 : 0);
        }, 0);

        const bestFinish = sessions.reduce((best, session) => {
          const result = session.results.find((entry) => entry.driver === driver.name);
          if (!result || typeof result.position !== 'number') return best;
          if (best === null) return result.position;
          return result.position < best ? result.position : best;
        }, null);

        return `
          <article class="analytics-card" style="--driver-accent: ${driverColor};">
            <header class="analytics-card__header">
              <div>
                <h3 class="analytics-card__title" style="color: ${driverColor};">${driver.name}</h3>
                <p class="analytics-card__subtitle">${driver.team || 'Independent'}</p>
              </div>
              <div class="analytics-card__metric">
                <span>${driver.points}</span>
                <small>pts</small>
              </div>
            </header>
            <div class="analytics-trend" role="img" aria-label="Points scored per race for ${driver.name}">
              ${raceSegments.join('')}
            </div>
            <div class="analytics-trend__labels" aria-hidden="true">
              ${sessionLabelsMarkup}
            </div>
            <dl class="analytics-card__meta">
              <div>
                <dt>Avg pts / race</dt>
                <dd>${safeAverage(totalPoints, appearances)}</dd>
              </div>
              <div>
                <dt>Best finish</dt>
                <dd>${bestFinish ? `P${bestFinish}` : '—'}</dd>
              </div>
              <div>
                <dt>Wins</dt>
                <dd>${driver.wins || 0}</dd>
              </div>
            </dl>
          </article>
        `;
      })
      .join('');

    container.innerHTML = cardsMarkup;
  }

  function renderTeamPerformance() {
    const container = document.getElementById('teamPerformance');
    if (!container) return;

    const leagueDrivers = getLeagueDrivers();
    const sessions = getOrderedSessions();

    if (!leagueDrivers.length) {
      container.innerHTML = createEmptyState('Add drivers to the data file to unlock team-level analytics.');
      return;
    }

    const totalPoints = leagueDrivers.reduce((sum, driver) => sum + (Number(driver.points) || 0), 0);
    const driversByName = new Map();
    leagueDrivers.forEach((driver) => {
      driversByName.set(driver.name, driver);
    });

    const teamStats = new Map();

    function ensureTeam(teamName) {
      const key = teamName && teamName.trim() ? teamName.trim() : 'Independent';
      if (!teamStats.has(key)) {
        teamStats.set(key, {
          name: key,
          drivers: [],
          points: 0,
          wins: 0,
          podiums: 0,
          fastestLaps: 0,
          finishSum: 0,
          finishCount: 0,
        });
      }
      return teamStats.get(key);
    }

    leagueDrivers.forEach((driver) => {
      const entry = ensureTeam(driver.team);
      entry.drivers.push(driver);
      entry.points += Number(driver.points) || 0;
      entry.wins += Number(driver.wins) || 0;
      entry.podiums += Number(driver.podiums) || 0;
      entry.fastestLaps += Number(driver.fastestLaps) || 0;
    });

    sessions.forEach((session) => {
      session.results.forEach((result) => {
        const driver = driversByName.get(result.driver);
        if (!driver) return;
        const entry = ensureTeam(driver.team);
        if (typeof result.position === 'number' && Number.isFinite(result.position)) {
          entry.finishSum += result.position;
          entry.finishCount += 1;
        }
      });
    });

    const teams = Array.from(teamStats.values()).sort((a, b) => b.points - a.points);

    const markup = teams
      .map((team) => {
        const driverList = team.drivers
          .slice()
          .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0))
          .map((driver) => driver.name)
          .join(', ');

        const avgFinish = team.finishCount
          ? (Math.round((team.finishSum / team.finishCount) * 10) / 10).toFixed(1)
          : '—';
        const pointsShare = totalPoints
          ? Math.round((team.points / totalPoints) * 100)
          : 0;
        const topDriver = team.drivers
          .slice()
          .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0))[0];

        return `
          <article class="analytics-card analytics-card--team" style="--team-color: ${getTeamColor(team.name)};">
            <header class="analytics-card__header">
              <div>
                <h3 class="analytics-card__title">${team.name}</h3>
                <p class="analytics-card__subtitle">${driverList || 'No registered drivers'}</p>
              </div>
              <div class="analytics-card__metric">
                <span>${team.points}</span>
                <small>pts</small>
              </div>
            </header>
            <dl class="analytics-card__meta analytics-card__meta--columns">
              <div>
                <dt>Wins</dt>
                <dd>${team.wins}</dd>
              </div>
              <div>
                <dt>Podiums</dt>
                <dd>${team.podiums}</dd>
              </div>
              <div>
                <dt>Fast laps</dt>
                <dd>${team.fastestLaps}</dd>
              </div>
              <div>
                <dt>Avg finish</dt>
                <dd>${avgFinish}</dd>
              </div>
              <div>
                <dt>Points share</dt>
                <dd>${pointsShare}%</dd>
              </div>
            </dl>
            <div class="analytics-card__footer">
              ${topDriver ? `<span class="analytics-chip">Top scorer: ${topDriver.name}</span>` : ''}
              <span class="analytics-chip analytics-chip--accent">Drivers: ${team.drivers.length}</span>
            </div>
          </article>
        `;
      })
      .join('');

    container.innerHTML = markup;
  }

  function renderFormGuide() {
    const container = document.getElementById('formGuide');
    if (!container) return;

    const leagueDrivers = getLeagueDrivers();
    const sessions = getOrderedSessions();

    if (!leagueDrivers.length || !sessions.length) {
      container.innerHTML = createEmptyState('Recent form will populate when sessions are recorded.');
      return;
    }

    const recentSessions = sessions.slice().reverse().slice(0, 5);

    const formDrivers = leagueDrivers
      .slice()
      .sort((a, b) => b.points - a.points)
      .slice(0, 6);

    const markup = formDrivers
      .map((driver) => {
        let recentPoints = 0;
        let recentAppearances = 0;

        const chips = recentSessions
          .map((session) => {
            const result = session.results.find((entry) => entry.driver === driver.name);
            const sessionLabel = formatSessionLabel(session);

            if (!result) {
              return `<span class="form-chip form-chip--absent" title="${driver.name} did not start ${sessionLabel}">—</span>`;
            }

            if (typeof result.position === 'number') {
              recentAppearances += 1;
              recentPoints += Number(result.points) || 0;
            }

            const points = Number(result.points) || 0;
            const baseLabel = typeof result.position === 'number'
              ? `Finished P${result.position}`
              : points > 0
                ? `${points} pts`
                : 'Classified';
            const extras = [];
            if (points) extras.push(`${points} pts`);
            if (result.fastestLap) extras.push('Fastest lap');

            let chipClass = 'form-chip form-chip--outside';
            if (result.position === 1) {
              chipClass = 'form-chip form-chip--win';
            } else if (result.position && result.position <= 3) {
              chipClass = 'form-chip form-chip--podium';
            } else if (points > 0) {
              chipClass = 'form-chip form-chip--points';
            } else if (typeof result.position === 'number') {
              chipClass = 'form-chip form-chip--classified';
            } else {
              chipClass = 'form-chip form-chip--outside';
            }

            const label = [sessionLabel, baseLabel, ...extras].join(' • ');
            const text = typeof result.position === 'number' ? `P${result.position}` : points ? `${points}` : '—';

            return `<span class="${chipClass}" title="${label}">${text}</span>`;
          })
          .join('');

        const seasonAppearances = sessions.reduce((count, session) => {
          const result = session.results.find((entry) => entry.driver === driver.name);
          return count + (result && typeof result.position === 'number' ? 1 : 0);
        }, 0);

        const seasonAverage = safeAverage(Number(driver.points) || 0, seasonAppearances);
        const recentAverage = safeAverage(recentPoints, recentAppearances);

        return `
          <article class="analytics-form__item">
            <div class="analytics-form__info">
              <h3>${driver.name}</h3>
              <p>${driver.team || 'Independent'} • Season avg ${seasonAverage} pts/race</p>
            </div>
            <div class="analytics-form__results" role="list" aria-label="Recent finishes for ${driver.name}">
              ${chips}
            </div>
            <div class="analytics-form__summary">
              <span>Last ${recentSessions.length} avg: ${recentAverage} pts</span>
            </div>
          </article>
        `;
      })
      .join('');

    container.innerHTML = markup;
  }

  function createEmptyState(message) {
    return `<p class="analytics-empty">${message}</p>`;
  }
})();
