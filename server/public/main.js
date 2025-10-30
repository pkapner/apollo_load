const totalRequestsEl = document.querySelector('#totalRequests');
const completedEl = document.querySelector('#completed');
const errorsEl = document.querySelector('#errors');
const errorRateEl = document.querySelector('#errorRate');
const throughputEl = document.querySelector('#throughput');
const elapsedEl = document.querySelector('#elapsed');
const loadScaleEl = document.querySelector('#loadScale');
const eventLimitEl = document.querySelector('#eventLimit');
const cacheWritesEl = document.querySelector('#cacheWrites');
const cacheHitsEl = document.querySelector('#cacheHits');
const cacheMissesEl = document.querySelector('#cacheMisses');
const cacheHitRateEl = document.querySelector('#cacheHitRate');
const bytesProcessedEl = document.querySelector('#bytesProcessed');
const progressBar = document.querySelector('#progressBar');
const lastUpdateEl = document.querySelector('#lastUpdate');
const workerTableBody = document.querySelector('#workerTable');
const historyEl = document.querySelector('#history');

const history = [];
let firstTimestamp = null;

const formatNumber = (value) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);

const formatDuration = (ms) => {
  if (ms <= 1000) {
    return `${formatNumber(ms)} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${formatNumber(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${formatNumber(remainingSeconds)}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ${formatNumber(remainingSeconds)}s`;
};

const formatBytes = (value) => {
  if (value < 1024) {
    return `${formatNumber(value)} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let index = -1;
  let bytes = value;
  do {
    bytes /= 1024;
    index += 1;
  } while (bytes >= 1024 && index < units.length - 1);
  return `${formatNumber(bytes)} ${units[index]}`;
};

const updateWorkerTable = (progress, iterations) => {
  const fragment = document.createDocumentFragment();
  progress.forEach((value, index) => {
    const row = document.createElement('tr');
    const workerCell = document.createElement('td');
    workerCell.textContent = `#${index}`;
    const progressCell = document.createElement('td');
    progressCell.textContent = `${value} / ${iterations}`;
    row.append(workerCell, progressCell);
    fragment.appendChild(row);
  });
  workerTableBody.replaceChildren(fragment);
};

const pushHistory = (snapshot) => {
  history.push({
    timestamp: snapshot.timestamp,
    completed: snapshot.completed ?? 0,
    errors: snapshot.errors ?? 0,
    cacheHits: snapshot.cacheHits ?? 0,
    cacheMisses: snapshot.cacheMisses ?? 0,
  });

  const MAX_HISTORY_LENGTH = 10;
  while (history.length > MAX_HISTORY_LENGTH) {
    history.shift();
  }

  const fragment = document.createDocumentFragment();
  history
    .slice()
    .reverse()
    .forEach((entry) => {
      const item = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = new Date(entry.timestamp).toLocaleTimeString();
      const right = document.createElement('span');
      const cacheSummary =
        entry.cacheHits != null && entry.cacheMisses != null
          ? `cache hits: ${formatNumber(entry.cacheHits)}/${formatNumber(entry.cacheHits + entry.cacheMisses)}`
          : '';
      const parts = [`completed: ${formatNumber(entry.completed)}`, `errors: ${formatNumber(entry.errors || 0)}`];
      if (cacheSummary) {
        parts.push(cacheSummary);
      }
      right.textContent = parts.join(' | ');
      item.append(left, right);
      fragment.appendChild(item);
    });

  historyEl.replaceChildren(fragment);
};

const evtSource = new EventSource('/metrics-stream');

evtSource.onmessage = (event) => {
  const snapshot = JSON.parse(event.data);

  if (firstTimestamp === null) {
    firstTimestamp = snapshot.startedAt ?? snapshot.timestamp;
  }

  const totalRequests = snapshot.total ?? 0;
  const completed = snapshot.completed ?? 0;
  const errors = snapshot.errors ?? 0;
  const cacheWrites = snapshot.cacheWrites ?? 0;
  const cacheHits = snapshot.cacheHits ?? 0;
  const cacheMisses = snapshot.cacheMisses ?? 0;
  const bytesProcessed = snapshot.bytesProcessed ?? 0;
  const eventLimit = snapshot.eventLimit ?? null;
  const progress = totalRequests > 0 ? completed / totalRequests : 0;
  const errorRate = completed > 0 ? (errors / completed) * 100 : 0;
  const elapsedMs =
    (snapshot.timestamp ?? Date.now()) - (snapshot.startedAt ?? firstTimestamp);
  const throughput =
    elapsedMs > 0 ? (completed / (elapsedMs / 1000)) : 0;
  const totalCacheReads = cacheHits + cacheMisses;
  const cacheHitRate = totalCacheReads > 0 ? (cacheHits / totalCacheReads) * 100 : 0;

  totalRequestsEl.textContent = totalRequests ? formatNumber(totalRequests) : '–';
  completedEl.textContent = completed ? formatNumber(completed) : '0';
  errorsEl.textContent = formatNumber(errors);
  errorRateEl.textContent = `${formatNumber(errorRate)}%`;
  throughputEl.textContent =
    throughput > 0 ? `${formatNumber(throughput)} req/s` : '–';
  elapsedEl.textContent = elapsedMs > 0 ? formatDuration(elapsedMs) : '–';
  eventLimitEl.textContent = eventLimit ? formatNumber(eventLimit) : '–';
  cacheWritesEl.textContent = formatNumber(cacheWrites);
  cacheHitsEl.textContent = formatNumber(cacheHits);
  cacheMissesEl.textContent = formatNumber(cacheMisses);
  cacheHitRateEl.textContent =
    totalCacheReads > 0 ? `${formatNumber(cacheHitRate)}%` : '–';
  bytesProcessedEl.textContent = formatBytes(bytesProcessed);
  progressBar.max = 1;
  progressBar.value = progress;
  lastUpdateEl.textContent = new Date(snapshot.timestamp ?? Date.now()).toLocaleTimeString();

  if (Array.isArray(snapshot.workerProgress)) {
    updateWorkerTable(snapshot.workerProgress, snapshot.iterations ?? 0);
  }

  if (snapshot.loadScale) {
    loadScaleEl.textContent = `${formatNumber(snapshot.loadScale)}×`;
  } else {
    loadScaleEl.textContent = '1×';
  }

  pushHistory(snapshot);
};

evtSource.onerror = () => {
  lastUpdateEl.textContent = 'Disconnected';
};
