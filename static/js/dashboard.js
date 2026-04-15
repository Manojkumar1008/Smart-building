let trendChart = null;
let floorChart = null;
let familyChart = null;
let selectedMetric = "energy_consumption";
let selectedWindow = "hourly";
let selectedTrendView = "consumption";
let combinationsPayload = null;
const ENERGY_UNIT_COST_EUR = 0.15;
const HISTORY_FETCH_LIMIT = 60000;
const WINDOW_LIMITS = {
  minute: 120,
  hourly: 800,
  daily: 1500,
  monthly: 2500,
  yearly: 3000,
};
const RESPONSE_CACHE_TTL_MS = 15000;
let activeLoadController = null;
const responseCache = new Map();

async function authFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Session expired");
  }
  return response;
}

const selects = {
  organization: document.getElementById("organization"),
  building: document.getElementById("building"),
  floor: document.getElementById("floor"),
  machine: document.getElementById("machine"),
};

const metricConfig = {
  energy_consumption: {
    label: "Energy",
    unit: "kWh",
    color: "#ff7a45",
    fill: "rgba(255,122,69,0.25)",
    floorField: "energy_consumption",
  },
  water_consumption: {
    label: "Water",
    unit: "L",
    color: "#28c9bf",
    fill: "rgba(40,201,191,0.25)",
    floorField: "water_consumption",
  },
  avg_co2: {
    label: "CO2",
    unit: "ppm",
    color: "#f5c542",
    fill: "rgba(245,197,66,0.25)",
    floorField: "avg_co2",
  },
  avg_temperature: {
    label: "Temperature",
    unit: "C",
    color: "#ff9f5c",
    fill: "rgba(255,159,92,0.25)",
    floorField: "avg_temperature",
  },
  avg_humidity: {
    label: "Humidity",
    unit: "%",
    color: "#6cb7ff",
    fill: "rgba(108,183,255,0.25)",
    floorField: "avg_humidity",
  },
  occupancy: {
    label: "Occupancy",
    unit: "state",
    color: "#9de27c",
    fill: "rgba(157,226,124,0.25)",
    floorField: "occupancy",
  },
};

const windowConfig = {
  minute: { label: "Minute", emptyLabel: "Current Minute" },
  hourly: { label: "Hourly", emptyLabel: "Current Hour" },
  daily: { label: "Daily", emptyLabel: "Current Day" },
  monthly: { label: "Monthly", emptyLabel: "Current Month" },
  yearly: { label: "Yearly", emptyLabel: "Current Year" },
};

function setOptions(select, values, fallback = "All", preferred = "") {
  const unique = Array.from(new Set(values)).sort();
  select.innerHTML =
    `<option value="">${fallback}</option>` +
    unique.map((v) => `<option value="${v}">${v}</option>`).join("");

  if (preferred && unique.includes(preferred)) {
    select.value = preferred;
  }
}

function f2(value) {
  return Number(value || 0).toFixed(2);
}

function formatCost(euroAmount) {
  const value = Number(euroAmount || 0);
  if (value < 1) {
    return `${f2(value * 100)} cents`;
  }
  return `EUR ${f2(value)}`;
}

function machineFamily(machineName) {
  if (!machineName) return "unknown";
  return machineName.replace(/_\d+$/, "");
}

function parseTimestamp(value) {
  return new Date(value);
}

function getLatestTimestamp(records) {
  if (!records.length) return new Date();
  const latest = records[records.length - 1]?.timestamp;
  const parsed = parseTimestamp(latest);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function sameMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function sameHour(a, b) {
  return sameDay(a, b) && a.getHours() === b.getHours();
}

function sameMinute(a, b) {
  return sameHour(a, b) && a.getMinutes() === b.getMinutes();
}

function sameYear(a, b) {
  return a.getFullYear() === b.getFullYear();
}

function formatWindowContext(windowName, latest) {
  if (windowName === "minute") {
    return "All History";
  }
  if (windowName === "hourly") {
    return "All History";
  }
  if (windowName === "daily") {
    return "All History";
  }
  if (windowName === "monthly") {
    return "All History";
  }
  return "All History";
}

function readFilters() {
  return {
    organization: selects.organization.value,
    building: selects.building.value,
    floor: selects.floor.value,
    machine: selects.machine.value,
  };
}

function limitForWindow(windowName) {
  return Math.min(WINDOW_LIMITS[windowName] || WINDOW_LIMITS.hourly, HISTORY_FETCH_LIMIT);
}

function toQuery(params, includeMetric = false) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v) q.set(k, v);
  });
  q.set("window", selectedWindow);
  q.set("limit", String(limitForWindow(selectedWindow)));
  if (includeMetric) {
    q.set("metric", selectedMetric);
  }
  return q.toString();
}

function getFloorEntries(row) {
  return Object.values((row.aggregations || {}).floors || {});
}

function getRowMetricValue(row, metric) {
  if (metric === "energy_consumption" || metric === "water_consumption") {
    return Number((row.overall || {})[metric] || 0);
  }

  const floors = getFloorEntries(row);
  if (!floors.length) return 0;
  const field = metricConfig[metric].floorField;
  const total = floors.reduce((sum, floor) => sum + Number(floor[field] || 0), 0);
  return total / floors.length;
}

function isSummedMetric(metric) {
  return metric === "energy_consumption" || metric === "water_consumption";
}

function filterRecordsForWindow(records, windowName) {
  const latest = getLatestTimestamp(records);
  const filtered = records.filter((row) => {
    if (typeof row._ts === "number") {
      return Number.isFinite(row._ts);
    }
    const ts = parseTimestamp(row.timestamp);
    return !Number.isNaN(ts.getTime());
  });

  return {
    records: filtered,
    contextLabel: formatWindowContext(windowName, latest),
    latest,
  };
}

function buildWindowSeries(records, metric, windowName) {
  const summed = isSummedMetric(metric);
  const filtered = filterRecordsForWindow(records, windowName).records;
  const buckets = new Map();

  filtered.forEach((row) => {
    const ts = parseTimestamp(row.timestamp);
    if (Number.isNaN(ts.getTime())) return;

    const year = ts.getFullYear();
    const month = String(ts.getMonth() + 1).padStart(2, "0");
    const day = String(ts.getDate()).padStart(2, "0");
    const hour = String(ts.getHours()).padStart(2, "0");
    const minute = String(ts.getMinutes()).padStart(2, "0");

    let key = "";
    let label = "";
    if (windowName === "minute") {
      key = `${year}-${month}-${day} ${hour}:${minute}`;
      label = `${day}/${month} ${hour}:${minute}`;
    } else if (windowName === "hourly") {
      key = `${year}-${month}-${day} ${hour}`;
      label = `${day}/${month} ${hour}:00`;
    } else if (windowName === "daily") {
      key = `${year}-${month}-${day}`;
      label = `${day}/${month}/${year}`;
    } else if (windowName === "monthly") {
      key = `${year}-${month}`;
      label = `${month}/${year}`;
    } else {
      key = String(year);
      label = String(year);
    }

    if (!buckets.has(key)) {
      buckets.set(key, { label, total: 0, count: 0 });
    }

    const bucket = buckets.get(key);
    bucket.total += getRowMetricValue(row, metric);
    bucket.count += 1;
  });

  const orderedKeys = Array.from(buckets.keys()).sort();
  return {
    labels: orderedKeys.map((key) => buckets.get(key).label),
    values: orderedKeys.map((key) => {
      const bucket = buckets.get(key);
      if (!bucket.count) return 0;
      return Number((summed ? bucket.total : bucket.total / bucket.count).toFixed(2));
    }),
  };
}

function downsampleSeries(series, maxPoints = 60) {
  if (series.labels.length <= maxPoints) return series;
  const step = Math.ceil(series.labels.length / maxPoints);
  return {
    labels: series.labels.filter((_, index) => index % step === 0),
    values: series.values.filter((_, index) => index % step === 0),
  };
}

function syncBuildingFloorMachineOptions() {
  if (!combinationsPayload) return;

  const hierarchy = combinationsPayload.hierarchy || {};
  const selectedOrg = selects.organization.value;
  const orgOptions = selectedOrg ? [selectedOrg] : Object.keys(hierarchy);

  let buildingOptions = combinationsPayload.buildings || [];
  if (selectedOrg && hierarchy[selectedOrg]) {
    buildingOptions = Object.keys(hierarchy[selectedOrg]);
  }

  const currentBuilding = selects.building.value;
  setOptions(selects.building, buildingOptions, "All Buildings", currentBuilding);
  const activeBuilding = selects.building.value;

  let floorOptions = combinationsPayload.floors || [];
  if (selectedOrg && activeBuilding && hierarchy[selectedOrg]?.[activeBuilding]) {
    floorOptions = hierarchy[selectedOrg][activeBuilding].floors || [];
  }

  const currentFloor = selects.floor.value;
  setOptions(selects.floor, floorOptions, "All Floors", currentFloor);
  const activeFloor = selects.floor.value;

  let machineOptions = combinationsPayload.machines || [];
  if (selectedOrg && activeBuilding && hierarchy[selectedOrg]?.[activeBuilding]) {
    const floorMachines = hierarchy[selectedOrg][activeBuilding].floor_machines || {};
    const floorMachinesByType =
      hierarchy[selectedOrg][activeBuilding].floor_machines_by_type || {};
    const wantsEnergy = selectedMetric === "energy_consumption";
    const wantsWater = selectedMetric === "water_consumption";
    const selectedType = wantsEnergy ? "energy" : wantsWater ? "water" : "";

    if (activeFloor) {
      if (selectedType) {
        machineOptions = (floorMachinesByType[activeFloor] || {})[selectedType] || [];
      } else {
        machineOptions = floorMachines[activeFloor] || [];
      }
    } else {
      const union = new Set();
      if (selectedType) {
        Object.values(floorMachinesByType).forEach((typeMap) => {
          (typeMap[selectedType] || []).forEach((machine) => union.add(machine));
        });
      } else {
        Object.values(floorMachines).forEach((machines) => {
          machines.forEach((machine) => union.add(machine));
        });
      }
      machineOptions = Array.from(union);
    }
  }

  const currentMachine = selects.machine.value;
  setOptions(selects.machine, machineOptions, "All Machines", currentMachine);
}

function updateMetricHeaders() {
  const cfg = metricConfig[selectedMetric];
  const windowLabel = windowConfig[selectedWindow].label;
  document.getElementById("metricTotalLabel").textContent = `${windowLabel} ${cfg.label} Total`;
  document.getElementById("metricAvgLabel").textContent = `${windowLabel} ${cfg.label} Average`;
  document.getElementById("trendTitle").textContent = `${windowLabel} ${cfg.label} Trend`;
  document.getElementById("floorTitle").textContent = `${windowLabel} Floor-wise ${cfg.label}`;
}

function updateCards(records) {
  const cfg = metricConfig[selectedMetric];
  const windowData = filterRecordsForWindow(records, selectedWindow);
  const values = windowData.records.map((row) => getRowMetricValue(row, selectedMetric));
  const total = values.reduce((sum, value) => sum + value, 0);
  const avg = values.length ? total / values.length : 0;

  const floorSet = new Set();
  const machineSet = new Set();
  windowData.records.forEach((row) => {
    getFloorEntries(row).forEach((floor) => {
      if (floor.floor) floorSet.add(floor.floor);
    });
    (row.meter_events || []).forEach((event) => {
      if (event.machine) machineSet.add(event.machine);
    });
  });

  document.getElementById("metricTotal").textContent = `${f2(total)} ${cfg.unit}`;
  document.getElementById("metricAverage").textContent = `${f2(avg)} ${cfg.unit}`;
  document.getElementById("floorsCount").textContent = String(floorSet.size);
  document.getElementById("machinesCount").textContent = String(machineSet.size);
  document.getElementById("windowLabel").textContent = windowData.contextLabel;

  const totalCostNode = document.getElementById("metricTotalCost");
  const averageCostNode = document.getElementById("metricAverageCost");
  if (selectedMetric === "energy_consumption") {
    totalCostNode.textContent = `Cost: ${formatCost(total * ENERGY_UNIT_COST_EUR)}`;
    averageCostNode.textContent = `Avg Cost: ${formatCost(avg * ENERGY_UNIT_COST_EUR)}`;
  } else {
    totalCostNode.textContent = "";
    averageCostNode.textContent = "";
  }
}

function updateTrendChart(records, trendSeries = null) {
  const cfg = metricConfig[selectedMetric];
  let series = trendSeries || buildWindowSeries(records, selectedMetric, selectedWindow);
  series = downsampleSeries(series, 60);
  const chartType = selectedWindow === "minute" ? "line" : "bar";

  if (trendChart) trendChart.destroy();

  if ((!records || !records.length) && !(trendSeries && trendSeries.labels?.length)) {
    document.getElementById("trendEmpty").style.display = "block";
    return;
  }
  document.getElementById("trendEmpty").style.display = "none";

  // Calculate cost if needed
  let chartLabel = cfg.label;
  let chartUnit = cfg.unit;
  let chartValues = series.values;
  let chartColor = cfg.color;
  let chartFill = cfg.fill;

  if (selectedTrendView === "cost" && selectedMetric === "energy_consumption") {
    chartLabel = "Energy Cost";
    chartUnit = "EUR";
    chartValues = series.values.map((v) => Number((v * ENERGY_UNIT_COST_EUR).toFixed(2)));
    chartColor = "#22d1c6";
    chartFill = "rgba(34, 209, 198, 0.25)";
  }

  trendChart = new Chart(document.getElementById("trendChart"), {
    type: chartType,
    data: {
      labels: series.labels,
      datasets: [
        {
          label: `${chartLabel} (${chartUnit})`,
          data: chartValues,
          borderColor: chartColor,
          backgroundColor: chartFill,
          tension: chartType === "line" ? 0.25 : 0,
          borderWidth: 2,
          fill: chartType === "line",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#eaf5ff" } } },
      scales: {
        x: {
          ticks: { color: "#9cb7ca", maxTicksLimit: 8 },
          grid: { color: "rgba(170, 218, 255, 0.12)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#9cb7ca" },
          grid: { color: "rgba(170, 218, 255, 0.12)" },
        },
      },
    },
  });
}

function updateFloorChart(records, floorSeries = null) {
  const cfg = metricConfig[selectedMetric];
  let labels = [];
  let values = [];

  if (floorSeries && floorSeries.labels?.length) {
    labels = floorSeries.labels;
    values = floorSeries.values;
  } else {
    const map = {};
    records.forEach((row) => {
      const floors = (row.aggregations || {}).floors || {};
      Object.entries(floors).forEach(([path, valuesObj]) => {
        if (!map[path]) map[path] = { total: 0, count: 0 };
        map[path].total += Number(valuesObj[cfg.floorField] || 0);
        map[path].count += 1;
      });
    });

    labels = Object.keys(map).map((path) => path.split("/").slice(-1)[0]);
    values = Object.values(map).map((entry) =>
      Number(
        (isSummedMetric(selectedMetric)
          ? entry.total
          : entry.total / Math.max(entry.count, 1)).toFixed(2),
      ),
    );
  }

  if (floorChart) floorChart.destroy();

  if (!labels.length) {
    document.getElementById("floorEmpty").style.display = "block";
    return;
  }
  document.getElementById("floorEmpty").style.display = "none";

  floorChart = new Chart(document.getElementById("floorChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `${cfg.label} (${cfg.unit})`,
          data: values,
          backgroundColor: cfg.color,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#eaf5ff" } } },
      scales: {
        x: {
          ticks: { color: "#9cb7ca" },
          grid: { color: "rgba(170, 218, 255, 0.12)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#9cb7ca" },
          grid: { color: "rgba(170, 218, 255, 0.12)" },
        },
      },
    },
  });
}

function updateFamilyChart(records, familySeries = null) {
  const panel = document.getElementById("familyPanel");
  if (selectedMetric !== "energy_consumption" && selectedMetric !== "water_consumption") {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "block";

  let labels = [];
  let values = [];
  if (familySeries && familySeries.labels?.length) {
    labels = familySeries.labels;
    values = familySeries.values;
  } else {
    const wantedType = selectedMetric === "energy_consumption" ? "energy" : "water";
    const familyMap = {};

    records.forEach((row) => {
      (row.meter_events || []).forEach((event) => {
        if (event.meter_type !== wantedType) return;
        const family = machineFamily(event.machine);
        if (!familyMap[family]) {
          familyMap[family] = 0;
        }
        familyMap[family] += Number(event.consumption || 0);
      });
    });

    labels = Object.keys(familyMap).sort();
    values = labels.map((label) => Number(familyMap[label].toFixed(2)));
  }

  if (familyChart) familyChart.destroy();

  if (!labels.length) {
    document.getElementById("familyEmpty").style.display = "block";
    return;
  }
  document.getElementById("familyEmpty").style.display = "none";

  const cfg = metricConfig[selectedMetric];
  document.getElementById("familyTitle").textContent = `${windowConfig[selectedWindow].label} ${cfg.label} by Machine Family`;

  familyChart = new Chart(document.getElementById("familyChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `${cfg.label} Family Total (${cfg.unit})`,
          data: values,
          backgroundColor: cfg.color,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#eaf5ff" } } },
      scales: {
        x: {
          ticks: { color: "#9cb7ca", maxRotation: 35, minRotation: 0 },
          grid: { color: "rgba(170, 218, 255, 0.12)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#9cb7ca" },
          grid: { color: "rgba(170, 218, 255, 0.12)" },
        },
      },
    },
  });
}

function updateMachineTable(records) {
  const body = document.getElementById("machineTable");
  body.innerHTML = "";
  const costHeader = document.getElementById("costColumnHeader");

  if (!records.length) {
    body.innerHTML =
      '<tr><td colspan="6" class="empty">No records found.</td></tr>';
    return;
  }

  const latest = records[records.length - 1];
  let rows = (latest.meter_events || []).slice();
  if (selectedMetric === "energy_consumption") {
    rows = rows.filter((row) => row.meter_type === "energy");
  } else if (selectedMetric === "water_consumption") {
    rows = rows.filter((row) => row.meter_type === "water");
  }

  rows.sort((a, b) => Number(b.consumption || 0) - Number(a.consumption || 0));

  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="6" class="empty">No machine events in this selection.</td></tr>';
    return;
  }

  costHeader.textContent = selectedMetric === "energy_consumption" ? "Cost" : "Cost";

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const path = `${row.organization}/${row.building}/${row.floor}/${row.machine}`;
    const cls =
      row.meter_type === "energy"
        ? "energy"
        : row.meter_type === "water"
          ? "water"
          : "";
    const costCell =
      row.meter_type === "energy"
        ? formatCost(Number(row.consumption || 0) * ENERGY_UNIT_COST_EUR)
        : "-";
    tr.innerHTML = `
      <td>${path}</td>
      <td>${machineFamily(row.machine)}</td>
      <td>${row.meter_type || "unknown"}</td>
      <td class="${cls}">${f2(row.consumption)}</td>
      <td>${costCell}</td>
      <td>${f2(row.current_reading)}</td>
    `;
    body.appendChild(tr);
  });
}

async function loadCombinations() {
  const res = await authFetch("/combinations");
  combinationsPayload = await res.json();

  setOptions(
    selects.organization,
    combinationsPayload.organizations || ["NCI"],
    "All Organizations",
    "NCI",
  );
  syncBuildingFloorMachineOptions();

  if ((combinationsPayload.buildings || []).includes("Mayer_Square")) {
    selects.building.value = "Mayer_Square";
  }
  syncBuildingFloorMachineOptions();
}

async function loadTrendData() {
  const query = toQuery(readFilters(), true);
  const res = await authFetch(`/trend?${query}`);
  return res.ok ? res.json() : { labels: [], values: [] };
}

async function loadData() {
  updateMetricHeaders();
  const query = toQuery(readFilters());
  const trendQuery = toQuery(readFilters(), true);
  const now = Date.now();
  const cached = responseCache.get(query);

  if (cached && now - cached.ts < RESPONSE_CACHE_TTL_MS) {
    const windowData = filterRecordsForWindow(cached.records, selectedWindow);
    updateCards(windowData.records);
    updateTrendChart(windowData.records, cached.trend);
    updateFloorChart(windowData.records, cached.floor);
    updateFamilyChart(windowData.records, cached.family);
    return;
  }

  if (activeLoadController) {
    activeLoadController.abort();
  }
  activeLoadController = new AbortController();

  try {
    const [trendRes, floorRes, familyRes] = await Promise.all([
      authFetch(`/trend?${trendQuery}`, { signal: activeLoadController.signal }),
      authFetch(`/floor-aggregation?${trendQuery}`, { signal: activeLoadController.signal }),
      authFetch(`/family-aggregation?${trendQuery}`, { signal: activeLoadController.signal }),
    ]);

    const [trendPayload, floorPayload, familyPayload] = await Promise.all([
      trendRes.json(),
      floorRes.json(),
      familyRes.json(),
    ]);

    updateTrendChart([], trendPayload);
    updateFloorChart([], floorPayload);
    updateFamilyChart([], familyPayload);

    const dataRes = await authFetch(`/data?${query}`, { signal: activeLoadController.signal });
    const payload = await dataRes.json();
    const records = (payload.data || []).map((row) => {
      const parsed = parseTimestamp(row.timestamp);
      return {
        ...row,
        _ts: Number.isNaN(parsed.getTime()) ? NaN : parsed.getTime(),
      };
    });
    responseCache.set(query, {
      ts: now,
      records,
      trend: trendPayload,
      floor: floorPayload,
      family: familyPayload,
    });

    const windowData = filterRecordsForWindow(records, selectedWindow);
    updateCards(windowData.records);
    updateTrendChart(windowData.records, trendPayload);
    updateFloorChart(windowData.records, floorPayload);
    updateFamilyChart(windowData.records, familyPayload);
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("Failed to load dashboard data", error);
    }
  }
}

function wireMetricSwitch() {
  const buttons = document.querySelectorAll("#metricSwitch .metric-btn");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedMetric = button.dataset.metric;
      buttons.forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");
      
      // Show/hide trend view switch for energy metric only
      const trendViewSwitch = document.getElementById("trendViewSwitch");
      if (selectedMetric === "energy_consumption") {
        trendViewSwitch.style.display = "flex";
      } else {
        trendViewSwitch.style.display = "none";
        selectedTrendView = "consumption";
        document.querySelectorAll("#trendViewSwitch .view-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.view === "consumption");
        });
      }
      
      syncBuildingFloorMachineOptions();
      loadData();
    });
  });
}

function wireTrendViewSwitch() {
  const buttons = document.querySelectorAll("#trendViewSwitch .view-btn");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedTrendView = button.dataset.view;
      buttons.forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");
      loadData();
    });
  });
}

function wireTimeWindowSwitch() {
  const buttons = document.querySelectorAll("#timeWindowSwitch .time-btn");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedWindow = button.dataset.window;
      buttons.forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");
      loadData();
    });
  });
}

function wireDependentFilters() {
  selects.organization.addEventListener("change", () => {
    syncBuildingFloorMachineOptions();
    loadData();
  });

  selects.building.addEventListener("change", () => {
    syncBuildingFloorMachineOptions();
    loadData();
  });

  selects.floor.addEventListener("change", () => {
    syncBuildingFloorMachineOptions();
    loadData();
  });

  selects.machine.addEventListener("change", loadData);
}

async function updateCollectionStats() {
  try {
    const res = await authFetch("/api/stats");
    const stats = await res.json();
    document.getElementById("docCount").textContent = stats.total_documents || "0";
  } catch (error) {
    console.error("Failed to fetch collection stats", error);
  }
}

async function clearAllData() {
  const confirmed = confirm(
    "Are you sure you want to clear ALL sensor data? This cannot be undone."
  );
  if (!confirmed) return;

  try {
    const res = await authFetch("/api/clear-data", { method: "DELETE" });
    const result = await res.json();
    alert(`✓ ${result.message}`);
    responseCache.clear();
    await updateCollectionStats();
    await loadCombinations();
    await loadData();
  } catch (error) {
    console.error("Failed to clear data", error);
    alert("✗ Failed to clear data");
  }
}

function wireLogout() {
  const logoutLink = document.getElementById("logoutLink");
  if (!logoutLink) return;

  logoutLink.addEventListener("click", async (e) => {
    e.preventDefault();
    logoutLink.textContent = "Signing out...";

    try {
      await fetch("/logout", { method: "POST" });
    } catch (error) {
      console.error("Logout failed", error);
    } finally {
      window.location.href = "/login";
    }
  });
}

function wireUserDropdown() {
  const userProfile = document.getElementById("userProfile");
  const userMenu = document.getElementById("userMenu");
  if (!userProfile || !userMenu) return;

  userProfile.addEventListener("click", () => {
    userMenu.classList.toggle("show");
  });

  document.addEventListener("click", (e) => {
    if (!userProfile.contains(e.target)) {
      userMenu.classList.remove("show");
    }
  });
}

function wireSettings() {
  const settingsBtn = document.getElementById("settingsBtn");
  const modal = document.getElementById("settingsModal");
  const modalClose = document.getElementById("modalClose");
  const saveSettings = document.getElementById("saveSettings");
  const cancelSettings = document.getElementById("cancelSettings");

  if (!settingsBtn || !modal) return;

  settingsBtn.addEventListener("click", () => {
    modal.classList.add("show");
  });

  modalClose.addEventListener("click", () => {
    modal.classList.remove("show");
  });

  cancelSettings.addEventListener("click", () => {
    modal.classList.remove("show");
  });

  saveSettings.addEventListener("click", () => {
    // Save settings logic here
    const theme = document.getElementById("themeSelect").value;
    const refreshInterval = document.getElementById("refreshInterval").value;
    const chartType = document.getElementById("chartType").value;

    localStorage.setItem("dashboardTheme", theme);
    localStorage.setItem("refreshInterval", refreshInterval);
    localStorage.setItem("chartType", chartType);

    modal.classList.remove("show");
    // Apply theme
    applyTheme(theme);
  });

  // Load saved settings
  const savedTheme = localStorage.getItem("dashboardTheme") || "dark";
  const savedInterval = localStorage.getItem("refreshInterval") || "60";
  const savedChartType = localStorage.getItem("chartType") || "line";

  document.getElementById("themeSelect").value = savedTheme;
  document.getElementById("refreshInterval").value = savedInterval;
  document.getElementById("chartType").value = savedChartType;
}

function wireModeToggle() {
  const modeToggle = document.getElementById("modeToggle");
  if (!modeToggle) return;

  modeToggle.addEventListener("click", () => {
    const currentTheme = localStorage.getItem("dashboardTheme") || "dark";
    const newTheme = currentTheme === "dark" ? "light" : "dark";
    localStorage.setItem("dashboardTheme", newTheme);
    applyTheme(newTheme);
  });
}

function applyTheme(theme) {
  const body = document.body;
  if (theme === "light") {
    body.classList.add("light-mode");
    document.getElementById("modeToggle").textContent = "☀️";
  } else {
    body.classList.remove("light-mode");
    document.getElementById("modeToggle").textContent = "🌙";
  }
}

async function init() {
  wireMetricSwitch();
  wireTimeWindowSwitch();
  wireTrendViewSwitch();
  wireDependentFilters();
  wireLogout();
  wireUserDropdown();
  wireSettings();
  wireModeToggle();
  document.getElementById("refreshBtn").addEventListener("click", loadData);
  document.getElementById("clearDataBtn").addEventListener("click", clearAllData);
  await loadCombinations();
  await loadData();
  setInterval(loadData, 12000);
}

init();
