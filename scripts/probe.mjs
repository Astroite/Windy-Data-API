/* Probe: validates every unverified assumption about s3://openmeteo before trusting build.mjs.
 *
 * Answers, in order:
 *   1. latest.json schema + resolvable run reference time
 *   2. reader API surface (method names on OmFileReader instances)
 *   3. children enumeration -> available variable names
 *   4. dims of temperature_2m -> derived source grid params
 *   5. sanity read: 3x3 box around Hong Kong (July temp should be ~26-33 C)
 *   6. HTTP behavior: does MemoryHttpBackend issue Range requests (partial reads)
 *      or download whole files? -> decides transfer cost per build
 *
 * Run: npm run probe
 */
import {
  S3_BASE,
  MODEL,
  fetchJson,
  resolveRun,
  runPath,
  timestepUrl,
  openOm,
  listChildren,
  findVariable,
  dimsOf,
  sourceGrid,
  nearestIndex,
  readVariableBox,
  protoMethods
} from "./lib/omsource.mjs";

const HOUR = 3600000;

/* ---- instrument fetch to observe Range usage and transfer volume ---- */
const stats = { requests: 0, ranged: 0, bytes: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  let range = null;
  try {
    const headers = new Headers((init && init.headers) || (typeof input === "object" && input.headers) || {});
    range = headers.get("range");
  } catch {
    /* ignore */
  }
  stats.requests++;
  if (range) stats.ranged++;
  const res = await realFetch(input, init);
  const isHead = init && init.method === "HEAD";
  const len = isHead ? 0 : Number(res.headers.get("content-length")) || 0;
  stats.bytes += len;
  console.log(
    `    [http] ${res.status}${range ? " range=" + range : ""}${len ? " " + (len / 1024).toFixed(1) + "KiB" : ""} ...${url.slice(-72)}`
  );
  return res;
};

function fail(step, err) {
  console.error(`\nPROBE FAILED at step: ${step}`);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

console.log(`probe: model=${MODEL} base=${S3_BASE}\n`);

/* 1. latest.json */
let run;
try {
  console.log("[1] latest.json");
  const latest = await fetchJson(`${S3_BASE}/data_spatial/${MODEL}/latest.json`);
  console.log("    raw:", JSON.stringify(latest).slice(0, 600));
  run = resolveRun(latest);
  console.log(`    resolved run: ${runPath(run.referenceMs)} (matched "${run.matched}")`);
} catch (e) {
  fail("latest.json", e);
}

/* 2+3. open a mid-run timestep, inspect reader */
let reader, children;
const probeTimeMs = run.referenceMs + 3 * HOUR;
const url = timestepUrl(MODEL, run.referenceMs, probeTimeMs);
try {
  console.log(`\n[2] open ${url}`);
  reader = await openOm(url);
  console.log("    reader methods:", protoMethods(reader).join(", "));
  console.log("\n[3] children");
  children = await listChildren(reader);
  console.log(`    ${children.length} children: ${children.map((c) => c.name).join(", ")}`);
} catch (e) {
  fail("open/children", e);
}

/* 4. dims + source grid */
let src;
try {
  console.log("\n[4] temperature_2m dims");
  const temp = await findVariable(reader, "temperature_2m");
  const dims = dimsOf(temp);
  console.log("    dims:", JSON.stringify(dims));
  src = sourceGrid(dims);
  console.log(
    `    derived grid: ny=${src.ny} nx=${src.nx} dy=${src.dy.toFixed(6)} dx=${src.dx.toFixed(6)} lat0=${src.lat0} lon0=${src.lon0}`
  );

  /* 5. sanity read around Hong Kong */
  console.log("\n[5] 3x3 read around Hong Kong (22.32N 114.17E)");
  const iy = nearestIndex(22.32, src.lat0, src.dy, src.ny);
  const ix = nearestIndex(114.17, src.lon0, src.dx, src.nx);
  const box = await readVariableBox(temp, { start: iy - 1, end: iy + 2 }, { start: ix - 1, end: ix + 2 });
  const vals = Array.from(box).map((v) => (Number.isFinite(v) ? v.toFixed(1) : "NaN"));
  console.log("    temperature_2m:", vals.join(", "));
  const center = box[4];
  if (!Number.isFinite(center)) throw new Error("center value is NaN — index mapping or grid params wrong");
  if (center < 5 || center > 45) {
    console.warn(`    WARNING: ${center.toFixed(1)}C is implausible for HK — check grid orientation/params`);
  } else {
    console.log(`    center ${center.toFixed(1)}C — plausible ✓`);
  }

  const u = await findVariable(reader, "wind_u_component_10m");
  const ubox = await readVariableBox(u, { start: iy, end: iy + 1 }, { start: ix, end: ix + 1 });
  console.log(`    wind_u_component_10m @HK: ${ubox[0].toFixed(2)} m/s`);

  /* 5b. realistic cost: full wide-grid box (lat 0..45, lon 100..160) for one variable */
  console.log("\n[5b] wide-domain box read (realistic per-variable per-timestep cost)");
  const before = { ...(reader.__backend ? reader.__backend.stats : { requests: 0, bytes: 0 }) };
  const r0 = nearestIndex(0, src.lat0, src.dy, src.ny);
  const r1 = nearestIndex(45, src.lat0, src.dy, src.ny) + 1;
  const c0 = nearestIndex(100, src.lon0, src.dx, src.nx);
  const c1 = nearestIndex(160, src.lon0, src.dx, src.nx) + 1;
  const wideBox = await readVariableBox(temp, { start: r0, end: r1 }, { start: c0, end: c1 });
  const finite = wideBox.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0);
  if (reader.__backend) {
    const d = {
      requests: reader.__backend.stats.requests - before.requests,
      bytes: reader.__backend.stats.bytes - before.bytes
    };
    console.log(
      `    box ${r1 - r0}x${c1 - c0} = ${wideBox.length} cells, finite ${((finite / wideBox.length) * 100).toFixed(1)}%, ` +
        `${d.requests} range requests, ${(d.bytes / 1048576).toFixed(2)}MiB`
    );
  }
} catch (e) {
  fail("dims/read", e);
}

/* 6. verdict */
console.log("\n[6] HTTP transfer verdict");
console.log(`    requests=${stats.requests} ranged=${stats.ranged} bytes~=${(stats.bytes / 1048576).toFixed(1)}MiB`);
if (stats.ranged > 0) {
  console.log("    -> Range requests observed: partial reads work, per-build transfer stays small ✓");
} else if (stats.bytes > 50 * 1048576) {
  console.log("    -> NO Range requests and large transfer: MemoryHttpBackend downloads whole files.");
  console.log("       Decision tree: switch OM_MODEL=ncep_gfs025 (smaller files), or implement a");
  console.log("       custom Range backend, or fall back to the GFS+Actions plan (see README).");
} else {
  console.log("    -> No Range header seen but transfer volume acceptable; inspect logs above.");
}
console.log("\nPROBE OK");
