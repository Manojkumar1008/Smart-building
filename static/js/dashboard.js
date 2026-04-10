let trendChart = null;
let floorChart = null;
let familyChart = null;
let selectedMetric = "energy_consumption";
let selectedWindow = "hourly";
let selectedTrendView = "consumption";
let combinationsPayload = null;
const ENERGY_UNIT_COST_EUR = 0.15;
const HISTORY_FETCH_LIMIT = 300000;

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
  return HISTORY_FETCH_LIMIT;
}

function toQuery(params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v) q.set(k, v);
  });
  q.set("window", selectedWindow);
  q.set("limit", String(limitForWindow(selectedWindow)));
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

function updateTrendChart(records) {
  const cfg = metricConfig[selectedMetric];
  const windowData = filterRecordsForWindow(records, selectedWindow);
  let series = buildWindowSeries(records, selectedMetric, selectedWindow);
  const chartType = selectedWindow === "minute" ? "line" : "bar";

  if (trendChart) trendChart.destroy();

  if (!windowData.records.length) {
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

function updateFloorChart(records) {
  const cfg = metricConfig[selectedMetric];
  const windowRecords = filterRecordsForWindow(records, selectedWindow).records;
  const map = {};
  windowRecords.forEach((row) => {
    const floors = (row.aggregations || {}).floors || {};
    Object.entries(floors).forEach(([path, values]) => {
      if (!map[path]) map[path] = { total: 0, count: 0 };
      map[path].total += Number(values[cfg.floorField] || 0);
      map[path].count += 1;
    });
  });

  const labels = Object.keys(map).map((path) => path.split("/").slice(-1)[0]);
  const values = Object.values(map).map((entry) =>
    Number(
      (isSummedMetric(selectedMetric)
        ? entry.total
        : entry.total / Math.max(entry.count, 1)).toFixed(2),
    ),
  );

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

function updateFamilyChart(records) {
  const panel = document.getElementById("familyPanel");
  if (selectedMetric !== "energy_consumption" && selectedMetric !== "water_consumption") {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "block";

  const wantedType = selectedMetric === "energy_consumption" ? "energy" : "water";
  const familyMap = {};
  const windowRecords = filterRecordsForWindow(records, selectedWindow).records;

  windowRecords.forEach((row) => {
    (row.meter_events || []).forEach((event) => {
      if (event.meter_type !== wantedType) return;
      const family = machineFamily(event.machine);
      if (!familyMap[family]) {
        familyMap[family] = 0;
      }
      familyMap[family] += Number(event.consumption || 0);
    });
  });

  const labels = Object.keys(familyMap).sort();
  const values = labels.map((label) => Number(familyMap[label].toFixed(2)));

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

  const windowRecords = filterRecordsForWindow(records, selectedWindow).records;

  if (!windowRecords.length) {
    body.innerHTML =
      '<tr><td colspan="6" class="empty">No records found.</td></tr>';
    return;
  }

  const latest = windowRecords[windowRecords.length - 1];
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
  const res = await fetch("/combinations");
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

async function loadData() {
  updateMetricHeaders();
  const query = toQuery(readFilters());
  const res = await fetch(`/data?${query}`);
  const payload = await res.json();
  const records = payload.data || [];

  updateCards(records);
  updateTrendChart(records);
  updateFloorChart(records);
  updateFamilyChart(records);
  updateMachineTable(records);
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

async function init() {
  wireMetricSwitch();
  wireTimeWindowSwitch();
  wireTrendViewSwitch();
  wireDependentFilters();
  document.getElementById("refreshBtn").addEventListener("click", loadData);
  await loadCombinations();
  await loadData();
  setInterval(loadData, 12000);
}

init();
