/* Typhoon Watch data pipeline — reads Open-Meteo AWS open data (s3://openmeteo) + GDACS,
 * emits static JSON snapshots into dist/ for EdgeOne Pages hosting.
 *
 * Weather failure exits non-zero on purpose: EO Pages keeps serving the last successful
 * deployment, and stale generatedAt is the client's signal to fall back to direct APIs.
 * Storms are best-effort (ok:false marks degraded) so a GDACS hiccup never blocks weather.
 *
 * Output (all consumed by the wallpaper client, see README for the schema contract):
 *   dist/v1/meta.json         run/generatedAt/index of files
 *   dist/v1/grid-wide.json    1.0 deg, lat 0..45, lon 100..160  (whole West Pacific stage)
 *   dist/v1/grid-fine.json    0.5 deg, lat 15..30, lon 105..125 (near-shore gameplay zone)
 *   dist/v1/storms.json       parsed GDACS tropical cyclones (same shape as WW.gdacs.fetchStorms)
 *   dist/v1/attribution.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import {
  S3_BASE,
  MODEL,
  fetchJson,
  resolveRun,
  runPath,
  timestepUrl,
  openOm,
  findVariable,
  dimsOf,
  sourceGrid,
  nearestIndex,
  readVariableBox,
  disposeReader
} from "./lib/omsource.mjs";

const SCHEMA_VERSION = 1;
const PAST_HOURS = 1; // mirrors WW.config.grid.pastHours
const FORECAST_HOURS = 6; // mirrors WW.config.grid.forecastHours
const HOUR = 3600000;
const MIN_FINITE_RATIO = 0.98;

// Snapshot grids consumed by the client (row-major: rows lat south->north, cols lon west->east,
// matching WW.grid points()). Domains sized for Web Mercator view spans: a 1920px window at
// zoom 5 spans ~84 deg lon (~118 padded) -> "global" serves default region views; zoom >= 6
// fits "wide". Client layer constants in js/weather/api-snapshot.js must mirror this list.
// Read order matters: "global" first so its cached blocks serve "wide" reads for free.
const GRIDS = [
  { id: "global", lat0: -60, lon0: -180, step: 2.5, ny: 53, nx: 144 },
  { id: "wide", lat0: -15, lon0: 75, step: 1.0, ny: 66, nx: 106 }
];

const VARS = ["wind_u_component_10m", "wind_v_component_10m", "temperature_2m", "precipitation"];

function round(v, digits) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const k = Math.pow(10, digits);
  return Math.round(v * k) / k;
}

// meteorological "from" direction, same convention as the Open-Meteo API wind_direction_10m
function windDirection(u, v) {
  return (Math.atan2(-u, -v) * (180 / Math.PI) + 360) % 360;
}

function planReads(grid, src) {
  const rows = [];
  const cols = [];
  for (let iy = 0; iy < grid.ny; iy++) rows.push(nearestIndex(grid.lat0 + iy * grid.step, src.lat0, src.dy, src.ny));
  for (let ix = 0; ix < grid.nx; ix++) cols.push(nearestIndex(grid.lon0 + ix * grid.step, src.lon0, src.dx, src.nx));
  const r0 = Math.min(...rows);
  const r1 = Math.max(...rows) + 1;
  const c0 = Math.min(...cols);
  const c1 = Math.max(...cols) + 1;
  return {
    rowRange: { start: r0, end: r1 },
    colRange: { start: c0, end: c1 },
    rowOff: rows.map((r) => r - r0),
    colOff: cols.map((c) => c - c0),
    boxW: c1 - c0
  };
}

async function readTimestep(url, plans) {
  const reader = await openOm(url);
  try {
    const out = {};
    for (const name of VARS) {
      const variable = await findVariable(reader, name);
      out[name] = {};
      for (const grid of GRIDS) {
        const plan = plans[grid.id];
        const box = await readVariableBox(variable, plan.rowRange, plan.colRange);
        const vals = new Array(grid.ny * grid.nx);
        let k = 0;
        for (let iy = 0; iy < grid.ny; iy++) {
          const rowBase = plan.rowOff[iy] * plan.boxW;
          for (let ix = 0; ix < grid.nx; ix++) vals[k++] = box[rowBase + plan.colOff[ix]];
        }
        out[name][grid.id] = vals;
      }
    }
    return out;
  } finally {
    disposeReader(reader);
  }
}

async function buildWeather() {
  const latest = await fetchJson(`${S3_BASE}/data_spatial/${MODEL}/latest.json`);
  const run = resolveRun(latest);
  console.log(`[weather] model=${MODEL} run=${runPath(run.referenceMs)}`);

  const nowFloor = Math.floor(Date.now() / HOUR) * HOUR;
  let startMs = nowFloor - PAST_HOURS * HOUR;
  if (startMs < run.referenceMs) startMs = run.referenceMs;
  const timesMs = [];
  for (let t = startMs; t <= nowFloor + FORECAST_HOURS * HOUR; t += HOUR) timesMs.push(t);
  console.log(`[weather] ${timesMs.length} timesteps: ${new Date(timesMs[0]).toISOString()} .. ${new Date(timesMs[timesMs.length - 1]).toISOString()}`);

  // derive source grid + read plans from the first timestep
  const firstUrl = timestepUrl(MODEL, run.referenceMs, timesMs[0]);
  const firstReader = await openOm(firstUrl);
  let src;
  try {
    src = sourceGrid(dimsOf(await findVariable(firstReader, "temperature_2m")));
  } finally {
    disposeReader(firstReader);
  }
  console.log(`[weather] source grid ny=${src.ny} nx=${src.nx} dy=${src.dy.toFixed(4)} dx=${src.dx.toFixed(4)}`);
  const plans = {};
  for (const grid of GRIDS) plans[grid.id] = planReads(grid, src);

  const perTime = [];
  for (const t of timesMs) {
    const url = timestepUrl(MODEL, run.referenceMs, t);
    console.log(`[weather] read ${new Date(t).toISOString()}`);
    perTime.push(await readTimestep(url, plans));
  }

  const generatedAt = Math.floor(Date.now() / 1000);
  const times = timesMs.map((t) => Math.floor(t / 1000));
  const files = {};
  for (const grid of GRIDS) {
    const np = grid.ny * grid.nx;
    const series = [];
    let finiteSpeed = 0;
    let finiteTemp = 0;
    for (let p = 0; p < np; p++) {
      const speed = [];
      const dir = [];
      const temp = [];
      const precip = [];
      for (let t = 0; t < perTime.length; t++) {
        const u = perTime[t].wind_u_component_10m[grid.id][p];
        const v = perTime[t].wind_v_component_10m[grid.id][p];
        const windOk = Number.isFinite(u) && Number.isFinite(v);
        if (windOk) finiteSpeed++;
        speed.push(windOk ? round(Math.hypot(u, v), 1) : null);
        dir.push(windOk ? Math.round(windDirection(u, v)) : null);
        const tv = perTime[t].temperature_2m[grid.id][p];
        if (Number.isFinite(tv)) finiteTemp++;
        temp.push(round(tv, 1));
        precip.push(round(perTime[t].precipitation[grid.id][p], 1)); // first run-timestep has no precip -> null
      }
      series.push({ speed, dir, temp, precip });
    }
    const cells = np * perTime.length;
    const speedRatio = finiteSpeed / cells;
    const tempRatio = finiteTemp / cells;
    console.log(`[weather] grid-${grid.id}: finite speed=${(speedRatio * 100).toFixed(1)}% temp=${(tempRatio * 100).toFixed(1)}%`);
    if (speedRatio < MIN_FINITE_RATIO || tempRatio < MIN_FINITE_RATIO) {
      throw new Error(`grid-${grid.id} failed validation (speed ${speedRatio}, temp ${tempRatio})`);
    }
    files[grid.id] = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      model: MODEL,
      run: runPath(run.referenceMs),
      spec: { lat0: grid.lat0, lon0: grid.lon0, step: grid.step, nx: grid.nx, ny: grid.ny },
      times,
      series
    };
  }
  return { generatedAt, run, files };
}

/* ---------- GDACS storms (port of js/weather/api-gdacs.js in the wallpaper repo; ----------
 * ---------- keep the output shape identical to WW.gdacs.fetchStorms resolution)  ---------- */
const GDACS_LIST = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtypes=TC";

function parseDate(v) {
  if (!v) return NaN;
  const t = Date.parse(v);
  return isNaN(t) ? NaN : t;
}

function firstDate(props) {
  for (const key of ["trackdate", "todate", "fromdate", "eventdate", "polygondate"]) {
    const t = parseDate(props[key]);
    if (!isNaN(t)) return t;
  }
  return NaN;
}

function parseGeometry(fc, storm) {
  const now = Date.now();
  const fixes = [];
  const datedPts = [];
  const lines = [];

  for (const f of fc.features || []) {
    const g = f.geometry;
    const props = f.properties || {};
    if (!g) continue;
    const cls = String(props.Class || props.polygonlabel || "");
    let m;
    if (g.type === "Polygon" && (m = cls.match(/^Point_Polygon_Point_(\d+)$/))) {
      const ring = g.coordinates[0];
      if (!ring || ring.length < 3) continue;
      let sx = 0;
      let sy = 0;
      for (const pt of ring) {
        sx += pt[0];
        sy += pt[1];
      }
      fixes.push({ idx: +m[1], lat: sy / ring.length, lon: sx / ring.length });
    } else if (g.type === "Point" && cls.toLowerCase().indexOf("centroid") < 0) {
      const t = firstDate(props);
      if (!isNaN(t)) datedPts.push({ lat: g.coordinates[1], lon: g.coordinates[0], t });
    } else if (g.type === "LineString" && /^Line_/.test(cls)) {
      lines.push(g.coordinates);
    } else if (g.type === "MultiLineString" && /^Line_/.test(cls)) {
      for (const c of g.coordinates) lines.push(c);
    }
  }

  if (fixes.length >= 2) {
    fixes.sort((a, b) => a.idx - b.idx);
    let k = 0;
    let best = Infinity;
    for (let j = 0; j < fixes.length; j++) {
      const dx = fixes[j].lon - storm.lon;
      const dy = fixes[j].lat - storm.lat;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        k = j;
      }
    }
    storm.history = fixes.slice(0, k);
    storm.forecast = fixes.slice(k + 1);
  } else if (datedPts.length) {
    datedPts.sort((a, b) => a.t - b.t);
    storm.history = datedPts.filter((p) => p.t <= now);
    storm.forecast = datedPts.filter((p) => p.t > now);
  }
  storm.trackLines = storm.history.length || storm.forecast.length ? [] : lines;
  return storm;
}

async function buildStorms() {
  const fc = await fetchJson(GDACS_LIST);
  const events = {};
  for (const f of fc.features || []) {
    const p = f.properties || {};
    if (p.eventtype !== "TC" || String(p.iscurrent) === "false") continue;
    const g = f.geometry;
    if (!g || g.type !== "Point") continue;
    const id = p.eventid;
    if (events[id]) continue;
    events[id] = {
      id,
      episodeid: p.episodeid,
      name: String(p.eventname || p.name || "TC").replace(/-\d+$/, ""),
      lat: g.coordinates[1],
      lon: g.coordinates[0],
      windKmh: (p.severitydata && p.severitydata.severity) || 0,
      alertlevel: p.alertlevel || "Green",
      geometryUrl: p.url && p.url.geometry,
      history: [],
      forecast: [],
      trackLines: []
    };
  }
  const storms = Object.values(events);
  console.log(`[storms] ${storms.length} active TC worldwide`);
  return Promise.all(
    storms.map(async (storm) => {
      const { geometryUrl, ...rest } = storm;
      if (!geometryUrl) return rest;
      try {
        const geo = await fetchJson(geometryUrl);
        return parseGeometry(geo, rest);
      } catch (e) {
        console.warn(`[storms] geometry failed for ${storm.name}: ${e.message}`);
        return rest; // degrade: current position only
      }
    })
  );
}

/* ---------- output ---------- */
async function main() {
  const weather = await buildWeather();

  let storms = { ok: false, storms: [] };
  try {
    storms = { ok: true, storms: await buildStorms() };
  } catch (e) {
    console.warn(`[storms] degraded (${e.message}); publishing empty list with ok:false`);
  }

  await mkdir("dist/v1", { recursive: true });
  const meta = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: weather.generatedAt,
    model: MODEL,
    run: runPath(weather.run.referenceMs),
    files: {
      global: "/v1/grid-global.json",
      wide: "/v1/grid-wide.json",
      storms: "/v1/storms.json"
    }
  };
  const write = (name, obj) => writeFile(`dist/v1/${name}`, JSON.stringify(obj));
  await Promise.all([
    write("meta.json", meta),
    write("grid-global.json", weather.files.global),
    write("grid-wide.json", weather.files.wide),
    write("storms.json", {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: Math.floor(Date.now() / 1000),
      ok: storms.ok,
      storms: storms.storms
    }),
    write("attribution.json", {
      weather: "Weather data by Open-Meteo.com (https://open-meteo.com), served from the Open-Meteo AWS open data bucket; underlying model: NOAA NCEP GFS",
      storms: "Tropical cyclone data by GDACS (https://www.gdacs.org)",
      note: "Redistributed snapshots for the Typhoon Watch wallpaper; see repository README for licensing details"
    }),
    writeFile(
      "dist/index.html",
      `<!doctype html><meta charset="utf-8"><title>Typhoon Watch data snapshots</title>` +
        `<pre>Typhoon Watch weather snapshots\nrun ${meta.run} / generated ${new Date(weather.generatedAt * 1000).toISOString()}\n\n` +
        `<a href="/v1/meta.json">/v1/meta.json</a>\n<a href="/v1/grid-global.json">/v1/grid-global.json</a>\n` +
        `<a href="/v1/grid-wide.json">/v1/grid-wide.json</a>\n<a href="/v1/storms.json">/v1/storms.json</a>\n` +
        `<a href="/v1/attribution.json">/v1/attribution.json</a></pre>`
    )
  ]);
  console.log(`[done] run=${meta.run} generatedAt=${weather.generatedAt} storms=${storms.storms.length} ok=${storms.ok}`);
}

main().catch((e) => {
  console.error("[fatal]", e && e.stack ? e.stack : e);
  process.exit(1);
});
