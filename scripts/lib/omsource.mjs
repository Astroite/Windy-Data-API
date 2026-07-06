/* Shared helpers for reading the Open-Meteo AWS open data bucket (s3://openmeteo).
 *
 * Layout (https://github.com/open-meteo/open-data):
 *   data_spatial/<model>/latest.json                     -> most recent completed run
 *   data_spatial/<model>/<YYYY/MM/DD/hhmmZ>/<YYYY-MM-DDThhmm>.om
 * Each timestep .om file contains all variables of the model as children,
 * dimensions [ny, nx]. Wind is stored as u/v components; speed/direction are
 * derived downstream (same convention as the Open-Meteo API).
 *
 * The @openmeteo/file-reader API surface is still 0.0.x and only partially
 * documented, so child enumeration is written defensively: every method probe
 * failure produces an error message listing what IS available.
 */

export const S3_BASE = process.env.OM_S3_BASE || "https://openmeteo.s3.amazonaws.com";
export const MODEL = process.env.OM_MODEL || "ncep_gfs013";

let _mod = null;
export async function om() {
  if (!_mod) _mod = await import("@openmeteo/file-reader");
  return _mod;
}

export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

export function protoMethods(obj) {
  const names = new Set();
  let p = Object.getPrototypeOf(obj);
  while (p && p !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") names.add(n);
    p = Object.getPrototypeOf(p);
  }
  return [...names].sort();
}

async function maybeAwait(v) {
  return v && typeof v.then === "function" ? await v : v;
}

/* latest.json schema is not formally documented yet; scan tolerantly for a
 * parseable run reference time and fail loudly with the raw payload if none found. */
export function resolveRun(latest) {
  const candidates = [];
  const visit = (v) => {
    if (typeof v === "string") candidates.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const key of ["reference_time", "referenceTime", "init_time", "run", "path"]) {
    if (latest && latest[key] !== undefined) visit(latest[key]);
  }
  if (!candidates.length) visit(latest);
  for (const s of candidates) {
    const m = s.match(/(\d{4})[/-](\d{2})[/-](\d{2})[T/\s]?(\d{2}):?(\d{2})?/);
    if (!m) continue;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +(m[5] || 0));
    if (Number.isFinite(ms) && ms > Date.UTC(2020, 0, 1) && ms < Date.now() + 86400000) {
      return { referenceMs: ms, matched: s };
    }
  }
  throw new Error("cannot resolve run reference time from latest.json: " + JSON.stringify(latest).slice(0, 500));
}

const pad2 = (n) => String(n).padStart(2, "0");

export function runPath(referenceMs) {
  const d = new Date(referenceMs);
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}Z`;
}

export function timestampName(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
}

export function timestepUrl(model, referenceMs, timeMs) {
  return `${S3_BASE}/data_spatial/${model}/${runPath(referenceMs)}/${timestampName(timeMs)}.om`;
}

/* The stock MemoryHttpBackend downloads whole files (~37 MiB per gfs013 timestep,
 * measured 2026-07-06, and twice at that). OM files are chunked precisely so that
 * partial reads work, and S3 supports Range — so we bring our own backend:
 * block-aligned Range GETs with an in-memory cache, contiguous misses coalesced
 * into a single request. Implements the OmFileReaderBackend interface
 * (getBytes/count/close) from @openmeteo/file-reader. */
const BLOCK = 128 * 1024;

export class RangeHttpBackend {
  constructor(url) {
    this.url = url;
    this._size = null;
    this._blocks = new Map(); // blockIndex -> Uint8Array(BLOCK)
    this.stats = { requests: 0, bytes: 0 };
  }

  async count(signal) {
    if (this._size === null) {
      const res = await fetch(this.url, { method: "HEAD", signal });
      if (!res.ok) throw new Error(`HEAD ${this.url} -> HTTP ${res.status}`);
      const len = Number(res.headers.get("content-length"));
      if (!Number.isFinite(len) || len <= 0) throw new Error("no content-length for " + this.url);
      this._size = len;
    }
    return this._size;
  }

  async _fetchBlocks(first, last, signal) {
    const size = await this.count(signal);
    const from = first * BLOCK;
    const to = Math.min(size, (last + 1) * BLOCK) - 1;
    const res = await fetch(this.url, { headers: { Range: `bytes=${from}-${to}` }, signal });
    if (res.status !== 206 && res.status !== 200) throw new Error(`GET ${this.url} range -> HTTP ${res.status}`);
    let buf = new Uint8Array(await res.arrayBuffer());
    if (res.status === 200) buf = buf.slice(from, to + 1); // server ignored Range
    this.stats.requests++;
    this.stats.bytes += buf.length;
    for (let b = first; b <= last; b++) {
      const off = (b - first) * BLOCK;
      this._blocks.set(b, buf.subarray(off, Math.min(off + BLOCK, buf.length)));
    }
  }

  async getBytes(offset, size, signal) {
    const total = await this.count(signal);
    if (offset + size > total) size = total - offset;
    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((offset + size - 1) / BLOCK);
    let runStart = -1;
    for (let b = first; b <= last; b++) {
      const missing = !this._blocks.has(b);
      if (missing && runStart < 0) runStart = b;
      if (!missing && runStart >= 0) {
        await this._fetchBlocks(runStart, b - 1, signal);
        runStart = -1;
      }
    }
    if (runStart >= 0) await this._fetchBlocks(runStart, last, signal);

    const out = new Uint8Array(size);
    let written = 0;
    for (let b = first; b <= last; b++) {
      const block = this._blocks.get(b);
      const from = b === first ? offset - b * BLOCK : 0;
      const len = Math.min(block.length - from, size - written);
      out.set(block.subarray(from, from + len), written);
      written += len;
    }
    return out;
  }

  async close() {
    this._blocks.clear();
  }
}

export async function openOm(url) {
  const { OmFileReader } = await om();
  const backend = new RangeHttpBackend(url);
  const reader = await OmFileReader.create(backend);
  reader.__backend = backend; // expose for stats/diagnostics
  return reader;
}

export async function listChildren(reader) {
  let count = null;
  for (const m of ["numberOfChildren", "getNumberOfChildren", "childrenCount"]) {
    try {
      const v = typeof reader[m] === "function" ? reader[m]() : reader[m];
      const r = await maybeAwait(v);
      if (Number.isInteger(r)) {
        count = r;
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (count === null) {
    throw new Error("cannot determine children count; reader methods: " + protoMethods(reader).join(", "));
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    let child = null;
    for (const m of ["getChild", "child"]) {
      if (typeof reader[m] === "function") {
        try {
          child = await maybeAwait(reader[m](i));
          if (child) break;
        } catch {
          /* try next */
        }
      }
    }
    if (!child) continue;
    let name = null;
    for (const m of ["getName", "name"]) {
      try {
        const v = typeof child[m] === "function" ? child[m]() : child[m];
        const r = await maybeAwait(v);
        if (typeof r === "string" && r) {
          name = r;
          break;
        }
      } catch {
        /* try next */
      }
    }
    out.push({ name: name || `#${i}`, child });
  }
  return out;
}

export async function findVariable(reader, name) {
  const children = await listChildren(reader);
  const hit = children.find((c) => c.name === name);
  if (!hit) {
    throw new Error(`variable "${name}" not found; available: ${children.map((c) => c.name).join(", ")}`);
  }
  return hit.child;
}

export function dimsOf(variable) {
  const d = variable.getDimensions();
  return Array.from(d).map(Number);
}

/* Derive lat/lon mapping from [ny, nx] dims of a global regular grid.
 * Odd ny -> poles included (lat -90..90 inclusive); even ny -> cell-centered.
 * Validated by probe.mjs against known-climate sample points. */
export function sourceGrid(dims) {
  if (!dims || dims.length !== 2) throw new Error("expected 2D [ny,nx] dims, got " + JSON.stringify(dims));
  const [ny, nx] = dims;
  const dx = 360 / nx;
  let dy, lat0;
  if (ny % 2 === 1) {
    dy = 180 / (ny - 1);
    lat0 = -90;
  } else {
    dy = 180 / ny;
    lat0 = -90 + dy / 2;
  }
  return { ny, nx, dy, dx, lat0, lon0: -180 };
}

export function nearestIndex(v, v0, dv, n) {
  let i = Math.round((v - v0) / dv);
  if (i < 0) i = 0;
  if (i >= n) i = n - 1;
  return i;
}

export async function readVariableBox(variable, rowRange, colRange) {
  const { OmDataType } = await om();
  return variable.read({ type: OmDataType.FloatArray, ranges: [rowRange, colRange] });
}

export function disposeReader(reader) {
  for (const m of ["dispose", "destroy", "free", "close"]) {
    if (typeof reader[m] === "function") {
      try {
        reader[m]();
      } catch {
        /* ignore */
      }
      return;
    }
  }
}
