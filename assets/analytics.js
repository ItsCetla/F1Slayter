const DATA_URL = 'v2/data/seasons.json';
const DRIVER_COLORS = [
  '#ff6b6b',
  '#845ef7',
  '#339af0',
  '#ffa94d',
  '#51cf66',
  '#f06595',
  '#22b8cf',
  '#94d82d',
  '#ffd43b',
  '#4dabf7',
  '#ff922b',
];

const TEAM_COLORS = {
  Ferrari: '#ff1e00',
  'Red Bull': '#1e41ff',
  McLaren: '#ff7f0f',
  'Mercedes-AMG Petronas': '#06b0b0',
  Alpine: '#0090ff',
  'Visa Cash App RB': '#3a87ff',
  Haas: '#ffffff',
  Williams: '#005aff',
  'Aston Martin': '#0a9f6c',
  'Kick Sauber': '#3bffbe',
};

const state = {
  seasons: [],
  metrics: null,
  timelineValue: null,
  charts: {},
  playing: false,
  playTimer: null,
  heatmapSort: 'points',
};

document.addEventListener('DOMContentLoaded', () => {
  initPage().catch((error) => {
    console.error('Failed to initialise analytics page', error);
    renderError('Unable to load analytics data. Please try again later.');
  });
});

async function initPage() {
  setupNavigationToggle();
  setFooterYear();
  initScrollProgress();
  await loadSeasonData();
  populateSeasonControls();
  bindEventHandlers();
  const defaultSeason = state.seasons[0];
  if (defaultSeason) {
    selectSeason(defaultSeason.id);
  } else {
    renderError('No season data available yet. Check back soon.');
  }
}

function setupNavigationToggle() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('primary-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    nav.classList.toggle('is-open', !expanded);
  });
}

function setFooterYear() {
  const yearElement = document.getElementById('footer-year');
  if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
  }
}

async function loadSeasonData() {
  const response = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch seasons: ${response.status}`);
  }
  const data = await response.json();
  const seasons = Array.isArray(data?.seasons) ? data.seasons : [];
  state.seasons = seasons
    .map((season) => ({
      ...season,
      rounds: Array.isArray(season.rounds) ? season.rounds : [],
    }))
    .sort((a, b) => (b.year || 0) - (a.year || 0));
}

function populateSeasonControls() {
  const select = document.getElementById('season-select');
  const pills = document.getElementById('season-pills');
  if (!select || !pills) return;

  clearChildren(select);
  clearChildren(pills);

  state.seasons.forEach((season) => {
    const option = document.createElement('option');
    option.value = season.id;
    option.textContent = season.name || `Season ${season.year ?? ''}`;
    select.appendChild(option);

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'season-pill';
    pill.dataset.season = season.id;
    pill.textContent = season.year ? `${season.year}` : season.name;
    pill.addEventListener('click', () => selectSeason(season.id));
    pills.appendChild(pill);
  });
}

function bindEventHandlers() {
  const select = document.getElementById('season-select');
  if (select) {
    select.addEventListener('change', (event) => {
      const value = event.target.value;
      selectSeason(value);
    });
  }

  const slider = document.getElementById('timeline-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      state.timelineValue = Number(slider.value);
      stopTimelinePlayback();
      updateTimelineLabel();
      updateCharts();
    });
  }

  const playButton = document.getElementById('timeline-play');
  if (playButton) {
    playButton.addEventListener('click', () => {
      if (state.playing) {
        stopTimelinePlayback();
      } else {
        startTimelinePlayback();
      }
    });
  }

  const resetButton = document.getElementById('timeline-reset');
  if (resetButton) {
    resetButton.addEventListener('click', () => {
      const sliderEl = document.getElementById('timeline-slider');
      if (!sliderEl) return;
      sliderEl.value = String(sliderEl.max);
      state.timelineValue = Number(sliderEl.max);
      stopTimelinePlayback();
      updateTimelineLabel();
      updateCharts();
    });
  }

  const driversToggle = document.getElementById('toggle-drivers');
  const teamsToggle = document.getElementById('toggle-teams');
  if (driversToggle) {
    driversToggle.addEventListener('change', () => {
      if (!driversToggle.checked && teamsToggle && !teamsToggle.checked) {
        driversToggle.checked = true;
      }
      updatePointsChart();
    });
  }
  if (teamsToggle) {
    teamsToggle.addEventListener('change', () => {
      if (!teamsToggle.checked && driversToggle && !driversToggle.checked) {
        teamsToggle.checked = true;
      }
      updatePointsChart();
    });
  }

  const heatmapSort = document.getElementById('heatmap-sort');
  if (heatmapSort) {
    heatmapSort.addEventListener('change', () => {
      state.heatmapSort = heatmapSort.value;
      renderHeatmap();
    });
  }

  const podiumFilter = document.getElementById('podium-filter');
  if (podiumFilter) {
    podiumFilter.addEventListener('change', () => {
      renderPodiumChart();
    });
  }

  const h2hDriver1 = document.getElementById('h2h-driver1');
  const h2hDriver2 = document.getElementById('h2h-driver2');
  if (h2hDriver1) {
    h2hDriver1.addEventListener('change', updateHeadToHeadChart);
  }
  if (h2hDriver2) {
    h2hDriver2.addEventListener('change', updateHeadToHeadChart);
  }
}

function selectSeason(seasonId) {
  const season = state.seasons.find((entry) => entry.id === seasonId);
  if (!season) return;

  stopTimelinePlayback();

  const select = document.getElementById('season-select');
  if (select) {
    select.value = seasonId;
  }

  document.querySelectorAll('.season-pill').forEach((pill) => {
    pill.classList.toggle('is-active', pill.dataset.season === seasonId);
  });

  state.metrics = buildSeasonMetrics(season);

  const slider = document.getElementById('timeline-slider');
  if (slider) {
    const roundsCount = state.metrics.rounds.length || 1;
    slider.min = '1';
    slider.max = String(roundsCount);
    slider.step = '1';
    slider.value = String(roundsCount);
    state.timelineValue = roundsCount;
    updateTimelineTicks();
  }
  updateTimelineLabel();
  populateHeadToHeadSelects();
  updateCharts(true);
}

function buildSeasonMetrics(season) {
  const rounds = season.rounds
    .slice()
    .sort((a, b) => new Date(a.date || '').getTime() - new Date(b.date || '').getTime())
    .map((round, index) => ({
      ...round,
      index,
      name: round.name || `Round ${index + 1}`,
    }));

  const driverMap = new Map();

  rounds.forEach((round) => {
    (round.results || []).forEach((result) => {
      if (!result?.driver) return;
      if (!driverMap.has(result.driver)) {
        driverMap.set(result.driver, {
          name: result.driver,
          team: result.team || 'Independent',
          positions: Array(rounds.length).fill(null),
          pointsEarned: Array(rounds.length).fill(0),
          cumulativePoints: Array(rounds.length).fill(0),
          gapToLeader: Array(rounds.length).fill(0),
          wins: 0,
          podiums: 0,
          fastestLapCount: 0,
          fastestLapPositions: [],
          raceCount: 0,
          color: TEAM_COLORS[result.team] || null,
        });
      }
    });
  });

  const drivers = Array.from(driverMap.values());

  rounds.forEach((round) => {
    (round.results || []).forEach((result) => {
      const driver = driverMap.get(result.driver);
      if (!driver) return;
      const { index } = round;
      const position = Number.isFinite(result.position) ? result.position : null;
      const points = Number.isFinite(result.points) ? result.points : 0;
      driver.positions[index] = position;
      driver.pointsEarned[index] = points;
      if (position && position <= 3) {
        driver.podiums += 1;
        if (position === 1) {
          driver.wins += 1;
        }
      }
      if (result.fastestLap) {
        driver.fastestLapCount += 1;
        driver.fastestLapPositions.push(position);
      }
      if (position) {
        driver.raceCount += 1;
      }
    });
  });

  drivers.forEach((driver, driverIndex) => {
    let runningPoints = 0;
    for (let i = 0; i < rounds.length; i += 1) {
      runningPoints += driver.pointsEarned[i] || 0;
      driver.cumulativePoints[i] = runningPoints;
      if (!driver.color) {
        driver.color = DRIVER_COLORS[driverIndex % DRIVER_COLORS.length];
      }
    }
    const finishedPositions = driver.positions.filter((position) => Number.isFinite(position));
    driver.totalPoints = runningPoints;
    driver.avgFinish = finishedPositions.length
      ? finishedPositions.reduce((sum, value) => sum + value, 0) / finishedPositions.length
      : null;
    driver.bestFinish = finishedPositions.length ? Math.min(...finishedPositions) : null;
  });

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const leader = drivers.reduce(
      (best, driver) => {
        const points = driver.cumulativePoints[roundIndex] || 0;
        if (!best || points > best.points) {
          return { points };
        }
        return best;
      },
      null,
    );
    const leaderPoints = leader ? leader.points : 0;
    drivers.forEach((driver) => {
      const driverPoints = driver.cumulativePoints[roundIndex] || 0;
      driver.gapToLeader[roundIndex] = leaderPoints - driverPoints;
    });
  }

  const teamMap = new Map();
  drivers.forEach((driver) => {
    const teamName = driver.team || 'Independent';
    if (!teamMap.has(teamName)) {
      teamMap.set(teamName, {
        name: teamName,
        color: TEAM_COLORS[teamName] || DRIVER_COLORS[teamMap.size % DRIVER_COLORS.length],
        pointsEarned: Array(rounds.length).fill(0),
        cumulativePoints: Array(rounds.length).fill(0),
        totalPoints: 0,
      });
    }
  });

  rounds.forEach((round, roundIndex) => {
    (round.results || []).forEach((result) => {
      const teamName = result.team || 'Independent';
      const team = teamMap.get(teamName);
      if (!team) return;
      const points = Number.isFinite(result.points) ? result.points : 0;
      team.pointsEarned[roundIndex] += points;
    });
  });

  const teams = Array.from(teamMap.values());
  teams.forEach((team) => {
    let running = 0;
    for (let i = 0; i < rounds.length; i += 1) {
      running += team.pointsEarned[i] || 0;
      team.cumulativePoints[i] = running;
    }
    team.totalPoints = running;
  });

  const maxPosition = drivers.reduce((highest, driver) => {
    const driverMax = driver.positions.reduce((max, position) => {
      if (!Number.isFinite(position)) return max;
      return Math.max(max, position);
    }, highest);
    return Math.max(highest, driverMax);
  }, 0) || 20;

  return {
    season,
    rounds,
    drivers,
    driverMap,
    teams,
    maxPosition,
  };
}

function updateCharts(forceCreate = false) {
  if (!state.metrics) return;
  updatePointsChart(forceCreate);
  updatePointsGapChart(forceCreate);
  updatePositionChart(forceCreate);
  renderHeatmap();
  renderPodiumChart(forceCreate);
  renderTrendChart(forceCreate);
  renderFastestLapChart(forceCreate);
  updateHeadToHeadChart(forceCreate);
}

function getActiveRoundCount() {
  if (!state.metrics) return 0;
  const total = state.metrics.rounds.length;
  if (!state.timelineValue || state.timelineValue > total) {
    return total;
  }
  return state.timelineValue;
}

function getRoundLabels(limit) {
  return state.metrics.rounds.slice(0, limit).map((round) => `R${round.round}: ${round.name}`);
}

function updatePointsChart(forceCreate = false) {
  const ctx = document.getElementById('points-chart');
  if (!ctx || !state.metrics) return;
  const showDrivers = document.getElementById('toggle-drivers')?.checked !== false;
  const showTeams = document.getElementById('toggle-teams')?.checked === true;
  const limit = getActiveRoundCount();
  const labels = getRoundLabels(limit);

  const datasets = [];
  if (showDrivers) {
    const topDrivers = state.metrics.drivers
      .slice()
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, 8);
    topDrivers.forEach((driver) => {
      datasets.push({
        label: driver.name,
        data: driver.cumulativePoints.slice(0, limit),
        tension: 0.35,
        borderColor: driver.color,
        backgroundColor: driver.color,
        borderWidth: 2,
        fill: false,
      });
    });
  }

  if (showTeams) {
    const topTeams = state.metrics.teams.slice().sort((a, b) => b.totalPoints - a.totalPoints).slice(0, 6);
    topTeams.forEach((team) => {
      datasets.push({
        label: `${team.name} (Team)`,
        data: team.cumulativePoints.slice(0, limit),
        tension: 0.35,
        borderColor: team.color,
        backgroundColor: team.color,
        borderDash: [6, 4],
        borderWidth: 2,
        fill: false,
      });
    });
  }

  const config = {
    type: 'line',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#fff' },
        },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };

  createOrUpdateChart('points', ctx, config, forceCreate);
}

function updatePointsGapChart(forceCreate = false) {
  const ctx = document.getElementById('points-gap-chart');
  if (!ctx || !state.metrics) return;
  const limit = getActiveRoundCount();
  const labels = getRoundLabels(limit);
  const datasets = state.metrics.drivers
    .slice()
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .slice(0, 8)
    .map((driver) => ({
      label: driver.name,
      data: driver.gapToLeader.slice(0, limit),
      tension: 0.35,
      borderWidth: 2,
      borderColor: driver.color,
      fill: false,
    }));

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { labels: { color: '#fff' } },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };

  createOrUpdateChart('pointsGap', ctx, config, forceCreate);
}

function updatePositionChart(forceCreate = false) {
  const ctx = document.getElementById('position-change-chart');
  if (!ctx || !state.metrics) return;
  const limit = getActiveRoundCount();
  const labels = getRoundLabels(limit);
  const datasets = state.metrics.drivers
    .slice()
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .slice(0, 10)
    .map((driver) => ({
      label: driver.name,
      data: driver.positions.slice(0, limit).map((position) => (Number.isFinite(position) ? position : null)),
      spanGaps: true,
      tension: 0.25,
      borderColor: driver.color,
      borderWidth: 2,
      fill: false,
    }));

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { labels: { color: '#fff' } },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          reverse: true,
          beginAtZero: false,
          ticks: { color: 'rgba(255,255,255,0.7)', precision: 0 },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };

  createOrUpdateChart('position', ctx, config, forceCreate);
}

function renderHeatmap() {
  const container = document.getElementById('heatmap-container');
  if (!container || !state.metrics) return;
  const limit = getActiveRoundCount();
  const rounds = state.metrics.rounds.slice(0, limit);

  const sortedDrivers = state.metrics.drivers.slice();
  if (state.heatmapSort === 'name') {
    sortedDrivers.sort((a, b) => a.name.localeCompare(b.name));
  } else if (state.heatmapSort === 'avg') {
    sortedDrivers.sort((a, b) => {
      const aAvg = Number.isFinite(a.avgFinish) ? a.avgFinish : Number.POSITIVE_INFINITY;
      const bAvg = Number.isFinite(b.avgFinish) ? b.avgFinish : Number.POSITIVE_INFINITY;
      return aAvg - bAvg;
    });
  } else {
    sortedDrivers.sort((a, b) => b.totalPoints - a.totalPoints);
  }

  clearChildren(container);
  if (!rounds.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.textContent = 'No race results to display yet.';
    container.appendChild(emptyMessage);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';
  const columnTemplate = `220px repeat(${rounds.length}, minmax(60px, 1fr))`;

  const headerRow = document.createElement('div');
  headerRow.className = 'heatmap-row heatmap-row--header';
  headerRow.style.gridTemplateColumns = columnTemplate;
  const driverHeader = createElement('div', {
    className: 'heatmap-cell heatmap-cell--driver',
    text: 'Driver',
  });
  headerRow.appendChild(driverHeader);
  rounds.forEach((round) => {
    const roundNumber = Number.isFinite(round.round) || typeof round.round === 'string'
      ? round.round
      : round.index + 1;
    const headerCell = createElement('div', {
      className: 'heatmap-cell',
      text: `R${roundNumber}`,
    });
    headerRow.appendChild(headerCell);
  });
  grid.appendChild(headerRow);

  sortedDrivers.forEach((driver) => {
    const row = document.createElement('div');
    row.className = 'heatmap-row';
    row.style.gridTemplateColumns = columnTemplate;
    const driverCell = document.createElement('div');
    driverCell.className = 'heatmap-cell heatmap-cell--driver';
    const nameSpan = createElement('span', { text: driver.name });
    const teamSmall = createElement('small', { text: driver.team });
    driverCell.append(nameSpan, teamSmall);
    row.appendChild(driverCell);

    rounds.forEach((round, index) => {
      const position = driver.positions[index];
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      if (Number.isFinite(position)) {
        cell.textContent = `P${position}`;
        cell.style.background = getHeatmapBackground(position, state.metrics.maxPosition);
        const roundName = round.name || `Round ${round.round ?? index + 1}`;
        cell.dataset.tooltip = `${driver.name} finished P${position} at ${roundName}`;
      } else {
        cell.textContent = '—';
        cell.style.background = 'rgba(255,255,255,0.05)';
      }
      row.appendChild(cell);
    });

    grid.appendChild(row);
  });

  container.appendChild(grid);
}

function getHeatmapBackground(position, maxPosition) {
  const max = Math.max(maxPosition, 1);
  const normalized = 1 - (position - 1) / max;
  const alpha = 0.15 + normalized * 0.75;
  return `linear-gradient(135deg, rgba(79, 141, 247, ${alpha}), rgba(255, 93, 122, ${alpha * 0.9}))`;
}

function renderPodiumChart(forceCreate = false) {
  const ctx = document.getElementById('podium-chart');
  if (!ctx || !state.metrics) return;
  const limit = getActiveRoundCount();
  const filter = document.getElementById('podium-filter')?.value || '10';

  let drivers = state.metrics.drivers.slice().sort((a, b) => b.totalPoints - a.totalPoints);
  if (filter === '5') drivers = drivers.slice(0, 5);
  else if (filter === '10') drivers = drivers.slice(0, 10);

  const labels = drivers.map((driver) => driver.name);
  const wins = [];
  const seconds = [];
  const thirds = [];
  const topTen = [];
  const rest = [];

  drivers.forEach((driver) => {
    let winCount = 0;
    let p2 = 0;
    let p3 = 0;
    let top = 0;
    let others = 0;
    driver.positions.slice(0, limit).forEach((position) => {
      if (!Number.isFinite(position)) return;
      if (position === 1) winCount += 1;
      else if (position === 2) p2 += 1;
      else if (position === 3) p3 += 1;
      else if (position <= 10) top += 1;
      else others += 1;
    });
    wins.push(winCount);
    seconds.push(p2);
    thirds.push(p3);
    topTen.push(top);
    rest.push(others);
  });

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Wins', data: wins, backgroundColor: 'rgba(255, 109, 109, 0.8)' },
        { label: 'P2', data: seconds, backgroundColor: 'rgba(132, 94, 247, 0.8)' },
        { label: 'P3', data: thirds, backgroundColor: 'rgba(51, 154, 240, 0.8)' },
        { label: 'P4-P10', data: topTen, backgroundColor: 'rgba(81, 207, 102, 0.75)' },
        { label: 'P11+', data: rest, backgroundColor: 'rgba(148, 216, 45, 0.7)' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#fff' } },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { color: 'rgba(255,255,255,0.7)', precision: 0 },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };

  createOrUpdateChart('podium', ctx, config, forceCreate);
}

function renderTrendChart(forceCreate = false) {
  const ctx = document.getElementById('trend-chart');
  if (!ctx || !state.metrics) return;
  const limit = getActiveRoundCount();
  const labels = getRoundLabels(limit);

  const drivers = state.metrics.drivers
    .slice()
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .slice(0, 8);

  const datasets = drivers.map((driver) => ({
    label: driver.name,
    data: computeRollingAverage(driver.positions.slice(0, limit), 3),
    borderColor: driver.color,
    backgroundColor: driver.color,
    borderWidth: 2,
    spanGaps: true,
    tension: 0.35,
    fill: false,
  }));

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#fff' } },
      },
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          reverse: true,
          ticks: { color: 'rgba(255,255,255,0.7)', precision: 0 },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };

  createOrUpdateChart('trend', ctx, config, forceCreate);
}

function computeRollingAverage(positions, windowSize) {
  const averages = [];
  for (let i = 0; i < positions.length; i += 1) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = positions.slice(start, i + 1).filter((value) => Number.isFinite(value));
    if (!slice.length) {
      averages.push(null);
    } else {
      const average = slice.reduce((sum, value) => sum + value, 0) / slice.length;
      averages.push(Number(average.toFixed(2)));
    }
  }
  return averages;
}

function renderFastestLapChart(forceCreate = false) {
  const ctx = document.getElementById('fastest-lap-chart');
  if (!ctx || !state.metrics) return;

  const drivers = state.metrics.drivers
    .filter((driver) => driver.fastestLapCount > 0)
    .map((driver) => {
      const avgFinish = driver.fastestLapPositions.length
        ? driver.fastestLapPositions.reduce((sum, value) => sum + (value || 0), 0) /
          driver.fastestLapPositions.length
        : null;
      return {
        name: driver.name,
        color: driver.color,
        count: driver.fastestLapCount,
        avgFinish: avgFinish ?? null,
      };
    })
    .sort((a, b) => {
      if (!Number.isFinite(a.avgFinish)) return 1;
      if (!Number.isFinite(b.avgFinish)) return -1;
      return a.avgFinish - b.avgFinish;
    });

  const labels = drivers.map((driver) => driver.name);
  const data = drivers.map((driver) => (Number.isFinite(driver.avgFinish) ? Number(driver.avgFinish.toFixed(2)) : null));

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Average Finish When Setting Fastest Lap',
          data,
          backgroundColor: drivers.map((driver) => driver.color),
          borderRadius: 8,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#fff' } },
      },
      scales: {
        x: {
          reverse: true,
          beginAtZero: false,
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { display: false },
        },
      },
    },
  };

  createOrUpdateChart('fastestLap', ctx, config, forceCreate);
  renderFastestLapStats(drivers);
}

function renderFastestLapStats(drivers) {
  const container = document.getElementById('fastest-lap-stats');
  if (!container) return;
  clearChildren(container);
  if (!drivers.length) {
    const message = document.createElement('p');
    message.textContent = 'No fastest lap data available yet.';
    container.appendChild(message);
    return;
  }

  const [leader] = drivers;
  const mostFastestLaps = drivers.slice().sort((a, b) => b.count - a.count)[0];
  const bestAverage = drivers
    .filter((driver) => Number.isFinite(driver.avgFinish))
    .sort((a, b) => a.avgFinish - b.avgFinish)[0];

  const cards = [];

  if (leader) {
    cards.push({
      title: 'Fastest Lap Standout',
      value: leader.name,
      meta: Number.isFinite(leader.avgFinish)
        ? `Avg finish ${leader.avgFinish.toFixed(2)}`
        : 'Limited data',
    });
  }

  if (mostFastestLaps) {
    cards.push({
      title: 'Most Fastest Laps',
      value: `${mostFastestLaps.count} × ${mostFastestLaps.name}`,
      meta: 'Across the season',
    });
  }

  if (bestAverage && bestAverage !== leader) {
    cards.push({
      title: 'Best Finishing Form',
      value: `${bestAverage.name}`,
      meta: `Avg finish ${bestAverage.avgFinish.toFixed(2)}`,
    });
  }

  cards.forEach((card) => {
    const element = document.createElement('div');
    element.className = 'fastest-lap-card';
    const title = createElement('h4', { text: card.title });
    const value = createElement('strong', { text: card.value });
    const meta = createElement('span', { text: card.meta });
    element.append(title, value, meta);
    container.appendChild(element);
  });
}

function populateHeadToHeadSelects() {
  const selectA = document.getElementById('h2h-driver1');
  const selectB = document.getElementById('h2h-driver2');
  if (!selectA || !selectB || !state.metrics) return;

  const drivers = state.metrics.drivers.slice().sort((a, b) => b.totalPoints - a.totalPoints);
  clearChildren(selectA);
  clearChildren(selectB);
  drivers.forEach((driver) => {
    const optionA = document.createElement('option');
    optionA.value = driver.name;
    optionA.textContent = driver.name;
    selectA.appendChild(optionA);

    const optionB = document.createElement('option');
    optionB.value = driver.name;
    optionB.textContent = driver.name;
    selectB.appendChild(optionB);
  });

  if (drivers[0]) selectA.value = drivers[0].name;
  if (drivers[1]) selectB.value = drivers[1].name;
}

function updateHeadToHeadChart(forceCreate = false) {
  const ctx = document.getElementById('h2h-chart');
  if (!ctx || !state.metrics) return;

  const selectA = document.getElementById('h2h-driver1');
  const selectB = document.getElementById('h2h-driver2');
  if (!selectA || !selectB) return;

  const driverA = state.metrics.driverMap.get(selectA.value);
  const driverB = state.metrics.driverMap.get(selectB.value);

  const summary = document.getElementById('h2h-summary');
  if (!driverA || !driverB || driverA === driverB) {
    if (summary) {
      clearChildren(summary);
      const message = document.createElement('p');
      message.textContent = 'Select two different drivers to compare their performances.';
      summary.appendChild(message);
    }
    if (state.charts.h2h) {
      state.charts.h2h.destroy();
      state.charts.h2h = null;
    }
    return;
  }

  const limit = getActiveRoundCount();
  const labels = getRoundLabels(limit);

  const dataset = [
    {
      label: driverA.name,
      data: driverA.positions.slice(0, limit).map((pos) => (Number.isFinite(pos) ? pos : null)),
      borderColor: driverA.color,
      borderWidth: 2,
      tension: 0.3,
      spanGaps: true,
      fill: false,
    },
    {
      label: driverB.name,
      data: driverB.positions.slice(0, limit).map((pos) => (Number.isFinite(pos) ? pos : null)),
      borderColor: driverB.color,
      borderWidth: 2,
      borderDash: [5, 3],
      tension: 0.3,
      spanGaps: true,
      fill: false,
    },
  ];

  const config = {
    type: 'line',
    data: { labels, datasets: dataset },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#fff' } },
      },
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          ticks: { color: 'rgba(255,255,255,0.7)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          reverse: true,
          ticks: { color: 'rgba(255,255,255,0.7)', precision: 0 },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };

  createOrUpdateChart('h2h', ctx, config, forceCreate);
  renderHeadToHeadSummary(driverA, driverB, limit);
}

function renderHeadToHeadSummary(driverA, driverB, limit) {
  const container = document.getElementById('h2h-summary');
  if (!container) return;

  clearChildren(container);

  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  let bestFinish = Infinity;
  let bestDriver = null;
  let totalDiff = 0;
  let racesCompared = 0;

  for (let i = 0; i < limit; i += 1) {
    const posA = Number.isFinite(driverA.positions[i]) ? driverA.positions[i] : null;
    const posB = Number.isFinite(driverB.positions[i]) ? driverB.positions[i] : null;
    if (posA === null && posB === null) continue;
    racesCompared += 1;

    const compareA = posA ?? 999;
    const compareB = posB ?? 999;
    if (compareA === compareB) {
      ties += 1;
    } else if (compareA < compareB) {
      winsA += 1;
    } else {
      winsB += 1;
    }

    if (posA !== null && posA < bestFinish) {
      bestFinish = posA;
      bestDriver = driverA.name;
    }
    if (posB !== null && posB < bestFinish) {
      bestFinish = posB;
      bestDriver = driverB.name;
    }

    totalDiff += compareB - compareA;
  }

  const averageDiff = racesCompared ? totalDiff / racesCompared : 0;
  const leadSummary = `${driverA.name} ${winsA}-${winsB} ${driverB.name}${ties ? ` (${ties} ties)` : ''}`;
  const bestSummary = Number.isFinite(bestFinish)
    ? `Best finish: ${bestDriver} (P${bestFinish})`
    : 'No classified finishes yet';
  const avgSummary = racesCompared
    ? `Average finishing gap: ${averageDiff > 0 ? '+' : ''}${averageDiff.toFixed(2)} places in favour of ${averageDiff >= 0 ? driverA.name : driverB.name}`
    : 'Insufficient data for average gap.';

  const leadParagraph = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = leadSummary;
  leadParagraph.appendChild(strong);

  const bestParagraph = document.createElement('p');
  bestParagraph.textContent = bestSummary;

  const avgParagraph = document.createElement('p');
  avgParagraph.textContent = avgSummary;

  container.append(leadParagraph, bestParagraph, avgParagraph);
}

function createOrUpdateChart(key, canvas, config, forceCreate = false) {
  const existingChart = state.charts[key];
  if (existingChart && !forceCreate) {
    existingChart.data = config.data;
    existingChart.options = config.options;
    existingChart.update();
    return;
  }
  if (existingChart) {
    existingChart.destroy();
  }
  state.charts[key] = new Chart(canvas, config);
}

function updateTimelineLabel() {
  const label = document.getElementById('timeline-value');
  if (!label || !state.metrics) return;
  const limit = getActiveRoundCount();
  const total = state.metrics.rounds.length;
  if (total === 0) {
    label.textContent = 'No races scheduled';
    return;
  }
  if (limit >= total) {
    label.textContent = 'All Races';
  } else {
    const round = state.metrics.rounds[limit - 1];
    label.textContent = `Round ${round.round} • ${round.name}`;
  }
}

function updateTimelineTicks() {
  const ticks = document.getElementById('timeline-ticks');
  const slider = document.getElementById('timeline-slider');
  if (!ticks || !slider || !state.metrics) return;

  const rounds = state.metrics.rounds;
  ticks.innerHTML = '';
  const total = rounds.length;
  if (total === 0) {
    return;
  }
  const maxTicks = Math.max(1, Math.min(total, 12));
  const interval = Math.max(1, Math.floor(total / maxTicks));
  rounds.forEach((round, index) => {
    if (index % interval !== 0 && index !== total - 1) return;
    const tick = document.createElement('span');
    tick.textContent = `R${round.round}`;
    ticks.appendChild(tick);
  });
}

function startTimelinePlayback() {
  const slider = document.getElementById('timeline-slider');
  const playButton = document.getElementById('timeline-play');
  if (!slider || !playButton || !state.metrics) return;

  state.playing = true;
  playButton.querySelector('.play-icon').style.display = 'none';
  playButton.querySelector('.pause-icon').style.display = '';
  playButton.setAttribute('aria-label', 'Pause timeline');

  let current = Number(slider.value);
  const max = Number(slider.max);
  if (current >= max) {
    current = 1;
  }
  slider.value = String(current);
  state.timelineValue = current;
  updateTimelineLabel();
  updateCharts();

  state.playTimer = window.setInterval(() => {
    current += 1;
    if (current > max) {
      stopTimelinePlayback();
      slider.value = String(max);
      state.timelineValue = max;
      updateTimelineLabel();
      updateCharts();
      return;
    }
    slider.value = String(current);
    state.timelineValue = current;
    updateTimelineLabel();
    updateCharts();
  }, 2000);
}

function stopTimelinePlayback() {
  const playButton = document.getElementById('timeline-play');
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
  }
  state.playing = false;
  if (playButton) {
    playButton.querySelector('.play-icon').style.display = '';
    playButton.querySelector('.pause-icon').style.display = 'none';
    playButton.setAttribute('aria-label', 'Play timeline');
  }
}

function renderError(message) {
  const main = document.querySelector('main');
  if (!main) return;
  main.innerHTML = `<section class="section"><div class="container"><p>${message}</p></div></section>`;
}

function initScrollProgress() {
  const progress = document.querySelector('.scroll-progress');
  if (!progress) return;

  const update = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollable <= 0) {
      progress.style.width = '0%';
      return;
    }
    const percentage = (window.scrollY / scrollable) * 100;
    const clamped = Math.min(Math.max(percentage, 0), 100);
    progress.style.width = `${clamped}%`;
  };

  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
}

function clearChildren(element) {
  if (!element) return;
  element.replaceChildren();
}

function createElement(tagName, { className, text } = {}) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}
