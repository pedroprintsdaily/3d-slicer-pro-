/* Seamline engine — mesh cutting, seam-aware splitting, connectors, labels, exports.
   Pure JS, no dependencies. Runs in a Web Worker or in Node. */
'use strict';
(function (root) {

// ---------------------------------------------------------------- vector utils
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------------------------------------------------------------- mesh basics
// mesh = { P: Float64Array(3*nv), T: Uint32Array(3*nt), G: Int32Array(nt) }  G = cut id that made the face (0 = original surface)
function makeMesh(P, T, G) {
  const nt = T.length / 3;
  return {
    P: P instanceof Float64Array ? P : Float64Array.from(P),
    T: T instanceof Uint32Array ? T : Uint32Array.from(T),
    G: G ? (G instanceof Int32Array ? G : Int32Array.from(G)) : new Int32Array(nt),
  };
}
function triCount(m) { return m.T.length / 3; }
function vertCount(m) { return m.P.length / 3; }

function bbox(m) {
  const P = m.P, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  // only count referenced vertices
  const T = m.T;
  for (let k = 0; k < T.length; k++) {
    const i = T[k] * 3;
    for (let a = 0; a < 3; a++) { const v = P[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  }
  if (!T.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return { min: mn, max: mx, size: sub(mx, mn), center: mul(add(mn, mx), 0.5) };
}

function volume(m) {
  const P = m.P, T = m.T; let v = 0;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
       - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
       + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

// Merge identical / near-identical vertices from a triangle soup (Float32Array 9*nt)
function weldSoup(soup, tol) {
  const nt = soup.length / 9;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let a = 0; a < 3; a++) { const v = soup[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const q = tol || diag * 1e-7;
  const map = new Map();
  const P = [], T = [];
  const idx = new Uint32Array(3);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const x = soup[o], y = soup[o + 1], z = soup[o + 2];
      const key = Math.round(x / q) + ',' + Math.round(y / q) + ',' + Math.round(z / q);
      let id = map.get(key);
      if (id === undefined) { id = P.length / 3; map.set(key, id); P.push(x, y, z); }
      idx[k] = id;
    }
    if (idx[0] === idx[1] || idx[1] === idx[2] || idx[0] === idx[2]) continue;
    T.push(idx[0], idx[1], idx[2]);
  }
  return makeMesh(P, T);
}

function weldIndexed(P, T, tol) {
  const soup = new Float32Array(T.length * 3);
  for (let k = 0; k < T.length; k++) { soup[k * 3] = P[T[k] * 3]; soup[k * 3 + 1] = P[T[k] * 3 + 1]; soup[k * 3 + 2] = P[T[k] * 3 + 2]; }
  return weldSoup(soup, tol);
}

// Keep only listed triangles, reindex vertices
function subMesh(m, tris) {
  const remap = new Map(); const P = [], T = [], G = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = m.T[t * 3 + k];
      let n = remap.get(v);
      if (n === undefined) { n = P.length / 3; remap.set(v, n); P.push(m.P[v * 3], m.P[v * 3 + 1], m.P[v * 3 + 2]); }
      T.push(n);
    }
    G.push(m.G[t]);
  }
  return makeMesh(P, T, G);
}

function translateMesh(m, d) {
  const P = new Float64Array(m.P);
  for (let i = 0; i < P.length; i += 3) { P[i] += d[0]; P[i + 1] += d[1]; P[i + 2] += d[2]; }
  return { P, T: m.T, G: m.G };
}
function scaleMesh(m, s, about) {
  const c = about || [0, 0, 0];
  const P = new Float64Array(m.P);
  for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) P[i + a] = c[a] + (P[i + a] - c[a]) * s;
  return { P, T: m.T, G: m.G };
}
// rotate by 3x3 row-major matrix R about origin
function rotateMesh(m, R) {
  const P = new Float64Array(m.P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = m.P[i], y = m.P[i + 1], z = m.P[i + 2];
    P[i] = R[0] * x + R[1] * y + R[2] * z; P[i + 1] = R[3] * x + R[4] * y + R[5] * z; P[i + 2] = R[6] * x + R[7] * y + R[8] * z;
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (det < 0) { const T = new Uint32Array(m.T); for (let t = 0; t < T.length; t += 3) { const s = T[t + 1]; T[t + 1] = T[t + 2]; T[t + 2] = s; } return { P, T, G: m.G }; }
  return { P, T: m.T, G: m.G };
}

function mergeMeshes(list) {
  let nv = 0, nt = 0; for (const m of list) { nv += m.P.length; nt += m.T.length; }
  const P = new Float64Array(nv), T = new Uint32Array(nt), G = new Int32Array(nt / 3);
  let po = 0, to = 0, go = 0;
  for (const m of list) {
    P.set(m.P, po); const base = po / 3;
    for (let k = 0; k < m.T.length; k++) T[to + k] = m.T[k] + base;
    G.set(m.G, go);
    po += m.P.length; to += m.T.length; go += m.G.length;
  }
  return { P, T, G };
}

// Connected components (by shared vertices)
function components(m) {
  const nv = vertCount(m), parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const T = m.T;
  for (let t = 0; t < T.length; t += 3) {
    const a = find(T[t]), b = find(T[t + 1]), c = find(T[t + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a); if (a2 !== c) parent[c] = a2;
  }
  const groups = new Map();
  for (let t = 0; t < T.length / 3; t++) {
    const r = find(T[t * 3]);
    let g = groups.get(r); if (!g) { g = []; groups.set(r, g); } g.push(t);
  }
  return [...groups.values()].map(g => subMesh(m, g));
}

// Edge statistics: open edges, non-manifold edges
function edgeStats(m) {
  const T = m.T, nv = vertCount(m);
  const dir = new Map();
  let dup = 0;
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = T[t + k], b = T[t + (k + 1) % 3];
    const key = a * nv + b;
    if (dir.has(key)) dup++; else dir.set(key, 1);
  }
  let open = 0;
  for (const key of dir.keys()) { const a = Math.floor(key / nv), b = key % nv; if (!dir.has(b * nv + a)) open++; }
  return { open, dup, watertight: open === 0 && dup === 0 };
}

// Make triangle winding consistent across each component, then outward (positive volume)
function orientMesh(m) {
  const T = new Uint32Array(m.T), nt = T.length / 3, nv = vertCount(m);
  const edgeTris = new Map();
  const ek = (a, b) => a < b ? a * nv + b : b * nv + a;
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const key = ek(T[t * 3 + k], T[t * 3 + (k + 1) % 3]);
    let l = edgeTris.get(key); if (!l) { l = []; edgeTris.set(key, l); } l.push(t);
  }
  const seen = new Uint8Array(nt);
  const hasDirEdge = (t, a, b) => { for (let k = 0; k < 3; k++) if (T[t * 3 + k] === a && T[t * 3 + (k + 1) % 3] === b) return true; return false; };
  const compOf = new Int32Array(nt); let nComp = 0;
  for (let s = 0; s < nt; s++) {
    if (seen[s]) continue;
    const stack = [s]; seen[s] = 1; compOf[s] = nComp;
    while (stack.length) {
      const t = stack.pop();
      for (let k = 0; k < 3; k++) {
        const a = T[t * 3 + k], b = T[t * 3 + (k + 1) % 3];
        const l = edgeTris.get(ek(a, b));
        if (!l || l.length !== 2) continue; // only propagate across manifold edges
        const o = l[0] === t ? l[1] : l[0];
        if (seen[o]) continue;
        // neighbour must use edge b->a; if it uses a->b, flip it
        if (hasDirEdge(o, a, b)) { const x = T[o * 3 + 1]; T[o * 3 + 1] = T[o * 3 + 2]; T[o * 3 + 2] = x; }
        seen[o] = 1; compOf[o] = nComp; stack.push(o);
      }
    }
    nComp++;
  }
  // per-patch outward check via signed volume contribution
  const vol = new Float64Array(nComp), P = m.P;
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    vol[compOf[t]] += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  for (let t = 0; t < nt; t++) if (vol[compOf[t]] < 0) { const x = T[t * 3 + 1]; T[t * 3 + 1] = T[t * 3 + 2]; T[t * 3 + 2] = x; }
  return { P: m.P, T, G: m.G };
}

// Fill simple holes (open boundary loops) by triangulating them on their best-fit plane
function fillHoles(m, maxLoopLen = 4000) {
  const T = m.T, nv = vertCount(m);
  const dir = new Set();
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) dir.add(T[t + k] * nv + T[t + (k + 1) % 3]);
  const next = new Map(); // boundary: edge a->b without b->a ; hole loop goes b->a
  for (const key of dir) { const a = Math.floor(key / nv), b = key % nv; if (!dir.has(b * nv + a)) { if (next.has(b)) next.set(b, -1); else next.set(b, a); } }
  const used = new Set(); const addT = [], addG = []; let filled = 0;
  for (const [s] of next) {
    if (used.has(s) || next.get(s) === -1) continue;
    const loop = [s]; used.add(s); let cur = next.get(s), ok = true;
    while (cur !== s) {
      if (cur === undefined || cur === -1 || used.has(cur) || loop.length > maxLoopLen) { ok = false; break; }
      loop.push(cur); used.add(cur); cur = next.get(cur);
    }
    if (!ok || loop.length < 3) continue;
    const pts = loop.map(i => [m.P[i * 3], m.P[i * 3 + 1], m.P[i * 3 + 2]]);
    const { n } = fitPlane(pts);
    const { e1, e2 } = basisFor(n);
    const flat = []; for (const p of pts) flat.push(dot(p, e1), dot(p, e2));
    const tri = earcut(flat, null);
    for (let k = 0; k < tri.length; k += 3) { addT.push(loop[tri[k]], loop[tri[k + 1]], loop[tri[k + 2]]); addG.push(0); }
    filled++;
  }
  if (!filled) return { mesh: m, filled: 0 };
  const T2 = new Uint32Array(T.length + addT.length); T2.set(T); T2.set(addT, T.length);
  const G2 = new Int32Array(m.G.length + addG.length); G2.set(m.G); G2.set(addG, m.G.length);
  return { mesh: orientMesh({ P: m.P, T: T2, G: G2 }), filled };
}

// ---------------------------------------------------------------- plane math
function basisFor(n) {
  n = norm(n);
  const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(n[a] - 1) < 1e-12) { const e1 = ax[(a + 1) % 3], e2 = ax[(a + 2) % 3]; return { n: ax[a], e1, e2 }; }
    if (Math.abs(n[a] + 1) < 1e-12) { const e1 = ax[(a + 2) % 3], e2 = ax[(a + 1) % 3]; return { n: mul(ax[a], -1), e1, e2 }; }
  }
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm(cross(a, n)); const e2 = cross(n, e1);
  return { n, e1, e2 };
}

function jacobiEigen(A) { // symmetric 3x3, returns {vals, vecs (columns)}
  const a = [[A[0], A[1], A[2]], [A[3], A[4], A[5]], [A[6], A[7], A[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1, big = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > big) { p = 0; q = 2; big = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > big) { p = 1; q = 2; big = Math.abs(a[1][2]); }
    if (big < 1e-15) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
  }
  return { vals: [a[0][0], a[1][1], a[2][2]], vecs: [0, 1, 2].map(j => [v[0][j], v[1][j], v[2][j]]) };
}

function fitPlane(pts) {
  const c = [0, 0, 0]; for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
  const C = new Array(9).fill(0);
  for (const p of pts) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j]; }
  const { vals, vecs } = jacobiEigen(C);
  let k = 0; if (vals[1] < vals[k]) k = 1; if (vals[2] < vals[k]) k = 2;
  return { c, n: norm(vecs[k]), flatness: vals[k] / (Math.max(...vals) || 1) };
}

// ---------------------------------------------------------------- earcut (port of mapbox/earcut, ISC)
function earcut(data, holeIndices) {
  const dim = 2;
  const hasHoles = holeIndices && holeIndices.length;
  const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
  let outerNode = linkedList(data, 0, outerLen, dim, true);
  const triangles = [];
  if (!outerNode || outerNode.next === outerNode.prev) return triangles;
  let minX, minY, invSize = 0;
  if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);
  if (data.length > 80 * dim) {
    minX = Infinity; minY = Infinity; let maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < outerLen; i += dim) { const x = data[i], y = data[i + 1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    invSize = Math.max(maxX - minX, maxY - minY); invSize = invSize !== 0 ? 32767 / invSize : 0;
  }
  earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);
  return triangles;
}
function linkedList(data, start, end, dim, clockwise) {
  let i, last;
  if (clockwise === (signedAreaFlat(data, start, end, dim) > 0)) { for (i = start; i < end; i += dim) last = insertNode(i / dim | 0, data[i], data[i + 1], last); }
  else { for (i = end - dim; i >= start; i -= dim) last = insertNode(i / dim | 0, data[i], data[i + 1], last); }
  if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
  return last;
}
function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p); p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}
function earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
  if (!ear) return;
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
  let stop = ear, prev, next;
  while (ear.prev !== ear.next) {
    prev = ear.prev; next = ear.next;
    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      removeNode(ear);
      ear = next.next; stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) earcutLinked(filterPoints(ear), triangles, dim, minX, minY, invSize, 1);
      else if (pass === 1) { ear = cureLocalIntersections(filterPoints(ear), triangles); earcutLinked(ear, triangles, dim, minX, minY, invSize, 2); }
      else if (pass === 2) splitEarcut(ear, triangles, dim, minX, minY, invSize);
      break;
    }
  }
}
function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  let p = ear.next.next;
  while (p !== ear.prev) {
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}
function isEarHashed(ear, minX, minY, invSize) {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  const minTX = Math.min(a.x, b.x, c.x), minTY = Math.min(a.y, b.y, c.y), maxTX = Math.max(a.x, b.x, c.x), maxTY = Math.max(a.y, b.y, c.y);
  const minZ = zOrder(minTX, minTY, minX, minY, invSize), maxZ = zOrder(maxTX, maxTY, minX, minY, invSize);
  let p = ear.prevZ, n = ear.nextZ;
  const bad = q => q !== a && q !== c && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, q.x, q.y) && area(q.prev, q, q.next) >= 0;
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (bad(p)) return false; p = p.prevZ;
    if (bad(n)) return false; n = n.nextZ;
  }
  while (p && p.z >= minZ) { if (bad(p)) return false; p = p.prevZ; }
  while (n && n.z <= maxZ) { if (bad(n)) return false; n = n.nextZ; }
  return true;
}
function cureLocalIntersections(start, triangles) {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      removeNode(p); removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}
function splitEarcut(start, triangles, dim, minX, minY, invSize) {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next); c = filterPoints(c, c.next);
        earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
        earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}
function eliminateHoles(data, holeIndices, outerNode, dim) {
  const queue = [];
  for (let i = 0, n = holeIndices.length; i < n; i++) {
    const start = holeIndices[i] * dim, end = i < n - 1 ? holeIndices[i + 1] * dim : data.length;
    const list = linkedList(data, start, end, dim, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  for (let i = 0; i < queue.length; i++) outerNode = eliminateHole(queue[i], outerNode);
  return outerNode;
}
function eliminateHole(hole, outerNode) {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next);
}
function findHoleBridge(hole, outerNode) {
  let p = outerNode; const hx = hole.x, hy = hole.y; let qx = -Infinity, m;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;
  const stop = m, mx = m.x, my = m.y; let tanMin = Infinity, tan;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x && pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) { m = p; tanMin = tan; }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}
function sectorContainsSector(m, p) { return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0; }
function indexCurve(start, minX, minY, invSize) {
  let p = start;
  do { if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize); p.prevZ = p.prev; p.nextZ = p.next; p = p.next; } while (p !== start);
  p.prevZ.nextZ = null; p.prevZ = null;
  sortLinked(p);
}
function sortLinked(list) {
  let i, p, q, e, tail, numMerges, pSize, qSize, inSize = 1;
  do {
    p = list; list = null; tail = null; numMerges = 0;
    while (p) {
      numMerges++; q = p; pSize = 0;
      for (i = 0; i < inSize; i++) { pSize++; q = q.nextZ; if (!q) break; }
      qSize = inSize;
      while (pSize > 0 || (qSize > 0 && q)) {
        if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) { e = p; p = p.nextZ; pSize--; }
        else { e = q; q = q.nextZ; qSize--; }
        if (tail) tail.nextZ = e; else list = e;
        e.prevZ = tail; tail = e;
      }
      p = q;
    }
    tail.nextZ = null; inSize *= 2;
  } while (numMerges > 1);
  return list;
}
function zOrder(x, y, minX, minY, invSize) {
  x = (x - minX) * invSize | 0; y = (y - minY) * invSize | 0;
  x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00FF00FF; y = (y | (y << 4)) & 0x0F0F0F0F; y = (y | (y << 2)) & 0x33333333; y = (y | (y << 1)) & 0x55555555;
  return x | (y << 1);
}
function getLeftmost(start) { let p = start, l = start; do { if (p.x < l.x || (p.x === l.x && p.y < l.y)) l = p; p = p.next; } while (p !== start); return l; }
function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
}
function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (area(a.prev, a, b.prev) || area(a, b.prev, b)) ||
      equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0);
}
function area(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
function equals(p1, p2) { return p1.x === p2.x && p1.y === p2.y; }
function intersects(p1, q1, p2, q2) {
  const o1 = sgn(area(p1, q1, p2)), o2 = sgn(area(p1, q1, q2)), o3 = sgn(area(p2, q2, p1)), o4 = sgn(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}
function onSegment(p, q, r) { return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
function sgn(n) { return n > 0 ? 1 : n < 0 ? -1 : 0; }
function intersectsPolygon(a, b) {
  let p = a;
  do { if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true; p = p.next; } while (p !== a);
  return false;
}
function locallyInside(a, b) {
  return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}
function middleInside(a, b) {
  let p = a, inside = false; const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}
function splitPolygon(a, b) {
  const a2 = new ENode(a.i, a.x, a.y), b2 = new ENode(b.i, b.x, b.y), an = a.next, bp = b.prev;
  a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
  return b2;
}
function insertNode(i, x, y, last) {
  const p = new ENode(i, x, y);
  if (!last) { p.prev = p; p.next = p; } else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function removeNode(p) { p.next.prev = p.prev; p.prev.next = p.next; if (p.prevZ) p.prevZ.nextZ = p.nextZ; if (p.nextZ) p.nextZ.prevZ = p.prevZ; }
function ENode(i, x, y) { this.i = i; this.x = x; this.y = y; this.prev = null; this.next = null; this.z = 0; this.prevZ = null; this.nextZ = null; this.steiner = false; }
function signedAreaFlat(data, start, end, dim) {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) { sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]); j = i; }
  return sum;
}

// Drop the middle points of exactly straight runs before earcut (they confuse its hole bridging);
// expandChains puts them back as fans so the cap still shares every boundary vertex.
function simplifyRing(uv, ids, eps) {
  const n = uv.length; if (n <= 4) return { uv, ids, chains: new Map() };
  const keep = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const a = uv[(i + n - 1) % n], b = uv[i], c = uv[(i + 1) % n];
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const along = (b[0] - a[0]) * (c[0] - a[0]) + (b[1] - a[1]) * (c[1] - a[1]);
    if (Math.abs(cr) <= Math.max(eps, 1e-12) * l && along > 0 && along < l * l) keep[i] = 0;
  }
  // a dropped point must have kept neighbours on a straight line through it: re-check runs against their kept ends
  let kept = 0; for (let i = 0; i < n; i++) kept += keep[i];
  if (kept < 3) return { uv, ids, chains: new Map() };
  const first = keep.indexOf(1); const outUV = [], outIds = [], chains = new Map();
  let i = first;
  do {
    outUV.push(uv[i]); outIds.push(ids[i]);
    let j = (i + 1) % n; const mid = [];
    while (!keep[j]) { mid.push(j); j = (j + 1) % n; }
    if (mid.length) {
      const a = uv[i], b = uv[j], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const straight = mid.every(m => Math.abs((uv[m][0] - a[0]) * (b[1] - a[1]) - (uv[m][1] - a[1]) * (b[0] - a[0])) <= Math.max(eps, 1e-12) * l * 4);
      if (straight) chains.set(ids[i] + '>' + ids[j], mid.map(m => ids[m]));
      else for (const m of mid) { outUV.push(uv[m]); outIds.push(ids[m]); }
    }
    i = j;
  } while (i !== first);
  return { uv: outUV, ids: outIds, chains };
}
function expandChains(tris, chains) {
  if (!chains.size) return tris;
  const out = [], stack = [];
  for (let t = 0; t < tris.length; t += 3) stack.push([tris[t], tris[t + 1], tris[t + 2]]);
  while (stack.length) {
    const tr = stack.pop(); let done = true;
    for (let k = 0; k < 3; k++) {
      const a = tr[k], b = tr[(k + 1) % 3], c = tr[(k + 2) % 3];
      let mid = chains.get(a + '>' + b);
      if (!mid) { const r = chains.get(b + '>' + a); if (r) mid = r.slice().reverse(); }
      if (!mid) continue;
      const seq = [a, ...mid, b];
      for (let q = 0; q + 1 < seq.length; q++) stack.push([seq[q], seq[q + 1], c]);
      done = false; break;
    }
    if (done) out.push(tr[0], tr[1], tr[2]);
  }
  return out;
}

// earcut drops collinear / duplicate boundary points. Put them back by splitting the triangle on that
// boundary edge into a fan, so the cap shares every boundary vertex with the surrounding surface.
function restoreDropped(tris, rings) {
  const used = new Set(tris);
  let missing = false;
  for (const r of rings) for (const v of r) if (!used.has(v)) { missing = true; break; }
  if (!missing) return tris;
  const T = tris.slice();
  const edgeTri = new Map();
  const reindex = () => { edgeTri.clear(); for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) edgeTri.set(T[t * 3 + k] + '>' + T[t * 3 + (k + 1) % 3], t); };
  reindex();
  for (const r of rings) {
    const n = r.length; let start = -1;
    for (let i = 0; i < n; i++) if (used.has(r[i])) { start = i; break; }
    if (start < 0) continue;
    let i = start;
    do {
      let j = (i + 1) % n; const mids = [];
      while (!used.has(r[j])) { mids.push(r[j]); j = (j + 1) % n; }
      if (mids.length) {
        const a = r[i], b = r[j];
        let t = edgeTri.get(a + '>' + b), chain = [a, ...mids, b];
        if (t === undefined) { t = edgeTri.get(b + '>' + a); chain = [b, ...mids.slice().reverse(), a]; }
        if (t !== undefined) {
          const tv = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
          const k = tv.findIndex((v, q) => v === chain[0] && tv[(q + 1) % 3] === chain[chain.length - 1]);
          const c = tv[(k + 2) % 3];
          T[t * 3] = chain[0]; T[t * 3 + 1] = chain[1]; T[t * 3 + 2] = c;
          for (let q = 1; q + 1 < chain.length; q++) T.push(chain[q], chain[q + 1], c);
          for (const v of mids) used.add(v);
          reindex();
        }
      }
      i = j;
    } while (i !== start);
  }
  return T;
}

// A cap triangle edge that runs straight through boundary vertices (collinear holes) leaves T-junctions.
// Split such triangles so every boundary vertex is a real triangle corner.
function fixTJunctions(tris, rings, uvOf, eps) {
  const T = tris.slice();
  const ringEdge = new Set(); const ringVerts = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; ringEdge.add(a + ',' + b); ringEdge.add(b + ',' + a); ringVerts.push(a); }
  const uv = new Map(); for (const v of ringVerts) uv.set(v, uvOf(v));
  for (let pass = 0; pass < 12; pass++) {
    const dir = new Set(); for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) dir.add(T[t * 3 + k] + ',' + T[t * 3 + (k + 1) % 3]);
    let changed = false;
    const nt = T.length / 3;
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const a = T[t * 3 + k], b = T[t * 3 + (k + 1) % 3], c = T[t * 3 + (k + 2) % 3];
        if (dir.has(b + ',' + a) || ringEdge.has(a + ',' + b)) continue;
        const A = uv.get(a) || uvOf(a), B = uv.get(b) || uvOf(b);
        const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy; if (!l2) continue;
        const on = [];
        for (const v of ringVerts) {
          if (v === a || v === b || v === c) continue;
          const p = uv.get(v); const s = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / l2;
          if (s <= 1e-9 || s >= 1 - 1e-9) continue;
          const cr = Math.abs((p[0] - A[0]) * dy - (p[1] - A[1]) * dx) / Math.sqrt(l2);
          if (cr <= Math.max(eps, Math.sqrt(l2) * 1e-9)) on.push([s, v]);
        }
        if (!on.length) continue;
        on.sort((x, y) => x[0] - y[0]);
        const chain = [a, ...[...new Set(on.map(o => o[1]))], b];
        T[t * 3] = chain[0]; T[t * 3 + 1] = chain[1]; T[t * 3 + 2] = c;
        for (let q = 1; q + 1 < chain.length; q++) T.push(chain[q], chain[q + 1], c);
        changed = true; break;
      }
    }
    if (!changed) break;
  }
  return T;
}

// ---------------------------------------------------------------- 2D polygon helpers (loops = arrays of [u,v])
function loopArea(L) { let s = 0; for (let i = 0, j = L.length - 1; i < L.length; j = i++) s += L[j][0] * L[i][1] - L[i][0] * L[j][1]; return s / 2; }
function pointInLoops(pt, loops) { // even-odd
  let inside = false; const x = pt[0], y = pt[1];
  for (const L of loops) for (let i = 0, j = L.length - 1; i < L.length; j = i++) {
    const a = L[i], b = L[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function distToLoops(pt, loops) {
  let best = Infinity; const x = pt[0], y = pt[1];
  for (const L of loops) for (let i = 0, j = L.length - 1; i < L.length; j = i++) {
    const ax = L[j][0], ay = L[j][1], bx = L[i][0], by = L[i][1];
    const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - x, ey = ay + t * dy - y; const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
function loopsBBox(loops) {
  const mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  for (const L of loops) for (const p of L) { if (p[0] < mn[0]) mn[0] = p[0]; if (p[1] < mn[1]) mn[1] = p[1]; if (p[0] > mx[0]) mx[0] = p[0]; if (p[1] > mx[1]) mx[1] = p[1]; }
  return { mn, mx };
}
// point inside region farthest from its boundary (grid search + refinement)
function poleOfInaccessibility(loops, steps = 28) {
  let { mn, mx } = loopsBBox(loops);
  let best = null, bestD = -1;
  let cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, w = mx[0] - mn[0], h = mx[1] - mn[1];
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
      const p = [cx - w / 2 + w * i / steps, cy - h / 2 + h * j / steps];
      if (!pointInLoops(p, loops)) continue;
      const d = distToLoops(p, loops);
      if (d > bestD) { bestD = d; best = p; }
    }
    if (!best) break;
    cx = best[0]; cy = best[1]; w = w * 3 / steps; h = h * 3 / steps;
  }
  return best ? { p: best, d: bestD } : null;
}
function circlePoly(c, r, n) { const out = [], ph = ((c[0] * 12.9898 + c[1] * 78.233) % 1 + 1) % 1 * 2 * Math.PI / n; for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n + ph; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); } return out; }
function rectPoly(c, w, h) { return [[c[0] - w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] + h / 2], [c[0] - w / 2, c[1] + h / 2]]; }

// ---------------------------------------------------------------- 3x5 dot font (digits + letters)
const FONT = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'], 'A': ['111', '101', '111', '101', '101'], 'B': ['110', '101', '110', '101', '110'],
  'C': ['111', '100', '100', '100', '111'], 'D': ['110', '101', '101', '101', '110'], 'E': ['111', '100', '110', '100', '111'],
  'F': ['111', '100', '110', '100', '100'], 'G': ['111', '100', '101', '101', '111'], 'H': ['101', '101', '111', '101', '101'],
  'I': ['111', '010', '010', '010', '111'], 'J': ['001', '001', '001', '101', '111'], 'K': ['101', '101', '110', '101', '101'],
  'L': ['100', '100', '100', '100', '111'], 'M': ['101', '111', '111', '101', '101'], 'N': ['110', '101', '101', '101', '101'],
  'O': ['111', '101', '101', '101', '111'], 'P': ['111', '101', '111', '100', '100'], 'Q': ['111', '101', '101', '111', '001'],
  'R': ['110', '101', '110', '101', '101'], 'S': ['111', '100', '111', '001', '111'], 'T': ['111', '010', '010', '010', '010'],
  'U': ['101', '101', '101', '101', '111'], 'V': ['101', '101', '101', '101', '010'], 'W': ['101', '101', '111', '111', '101'],
  'X': ['101', '101', '010', '101', '101'], 'Y': ['101', '101', '010', '010', '010'], 'Z': ['111', '001', '010', '100', '111'],
  '-': ['000', '000', '111', '000', '000'],
};
// dot centres (unit pitch) for text, centred on origin; mirrored if requested
function textDots(text, mirror) {
  const chars = String(text).toUpperCase().split('').filter(c => FONT[c]);
  const cols = chars.length * 4 - 1, dots = [];
  chars.forEach((ch, ci) => FONT[ch].forEach((row, r) => row.split('').forEach((b, c) => {
    if (b === '1') { let x = ci * 4 + c - (cols - 1) / 2; if (mirror) x = -x; dots.push([x, 2 - r]); }
  })));
  return { dots, w: cols, h: 5 };
}

// ---------------------------------------------------------------- slicing / cross-sections
// Returns loops (uv) of the cross-section of mesh m with plane n·x = d. Assumes d already perturbed off vertices.
function sectionLoops(m, basis, d) {
  const { n, e1, e2 } = basis, P = m.P, T = m.T, nv = vertCount(m);
  const W = new Float64Array(nv);
  for (let i = 0; i < nv; i++) W[i] = P[i * 3] * n[0] + P[i * 3 + 1] * n[1] + P[i * 3 + 2] * n[2] - d;
  const ptCache = new Map(); const pts = [];
  const ip = (a, b) => {
    const key = a < b ? a * nv + b : b * nv + a;
    let id = ptCache.get(key);
    if (id === undefined) {
      const t = W[a] / (W[a] - W[b]);
      const x = P[a * 3] + (P[b * 3] - P[a * 3]) * t, y = P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, z = P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t;
      id = pts.length; ptCache.set(key, id); pts.push([x * e1[0] + y * e1[1] + z * e1[2], x * e2[0] + y * e2[1] + z * e2[2]]);
    }
    return id;
  };
  const next = new Map();
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]], s = v.map(i => W[i] > 0);
    if (s[0] === s[1] && s[1] === s[2]) continue;
    let k = 0; while (!(s[k] !== s[(k + 1) % 3] && s[k] !== s[(k + 2) % 3])) k++;
    const v0 = v[k], v1 = v[(k + 1) % 3], v2 = v[(k + 2) % 3];
    const p01 = ip(v0, v1), p02 = ip(v0, v2);
    if (s[k]) next.set(p01, p02); else next.set(p02, p01);
  }
  return chainLoops(next, pts).loops.map(l => l.map(i => pts[i]));
}

function chainLoops(next, pts) {
  const used = new Set(), loops = []; let open = 0;
  for (const [s] of next) {
    if (used.has(s)) continue;
    const loop = [s]; used.add(s); let cur = next.get(s), ok = true;
    while (cur !== s) { if (cur === undefined || used.has(cur)) { ok = false; break; } loop.push(cur); used.add(cur); cur = next.get(cur); }
    if (ok && loop.length >= 3) loops.push(loop); else open++;
  }
  return { loops, open };
}

// group loops into islands: each positive-area loop with the negative loops directly inside it
function groupIslands(loopsUV) {
  const info = loopsUV.map((L, i) => ({ i, L, a: loopArea(L) }));
  const outers = info.filter(o => o.a > 0).sort((x, y) => x.a - y.a);
  const holes = info.filter(o => o.a < 0);
  const islands = outers.map(o => ({ outer: o.i, holes: [], area: o.a }));
  for (const h of holes) {
    const p = h.L[0];
    const isl = islands.find(is => pointInLoops(p, [loopsUV[is.outer]]));
    if (isl) { isl.holes.push(h.i); isl.area += h.a; }
  }
  return islands;
}

// net cross-section area for many plane offsets in one pass (seam scoring)
function sectionAreas(m, basis, ds) {
  const { n, e1, e2 } = basis, P = m.P, T = m.T, nv = vertCount(m);
  const W = new Float64Array(nv), U = new Float64Array(nv), V = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    W[i] = x * n[0] + y * n[1] + z * n[2]; U[i] = x * e1[0] + y * e1[1] + z * e1[2]; V[i] = x * e2[0] + y * e2[1] + z * e2[2];
  }
  const out = new Float64Array(ds.length), cnt = new Int32Array(ds.length);
  for (let t = 0; t < T.length; t += 3) {
    const vs = [T[t], T[t + 1], T[t + 2]];
    const lo = Math.min(W[vs[0]], W[vs[1]], W[vs[2]]), hi = Math.max(W[vs[0]], W[vs[1]], W[vs[2]]);
    for (let q = 0; q < ds.length; q++) {
      const d = ds[q]; if (d <= lo || d >= hi) continue;
      const sd = [W[vs[0]] > d, W[vs[1]] > d, W[vs[2]] > d];
      let k = 0; while (!(sd[k] !== sd[(k + 1) % 3] && sd[k] !== sd[(k + 2) % 3])) k++;
      const v0 = vs[k], v1 = vs[(k + 1) % 3], v2 = vs[(k + 2) % 3];
      const s1 = (d - W[v0]) / (W[v1] - W[v0]), s2 = (d - W[v0]) / (W[v2] - W[v0]);
      let p = [U[v0] + (U[v1] - U[v0]) * s1, V[v0] + (V[v1] - V[v0]) * s1], r = [U[v0] + (U[v2] - U[v0]) * s2, V[v0] + (V[v2] - V[v0]) * s2];
      if (!sd[k]) { const x = p; p = r; r = x; }
      out[q] += (p[0] * r[1] - r[0] * p[1]) / 2; cnt[q]++;
    }
  }
  return { areas: out, counts: cnt };
}

// ---------------------------------------------------------------- the cut
/*
 cutMesh(mesh, {n, d}, opts) -> { below, above, cutInfo } or { error }
 opts: {
   cutId, localPoint (3D, optional: cut only the cross-section island at this spot),
   connector: { type: 'dowel'|'peg'|'magnet'|'none', diameter(mm or 0=auto), depth, tolerance, magnetD, magnetH },
   label: true/false, wall
 }
 "below" = side where n·x < d. Its cap faces +n.
*/
function cutMeshOnce(mesh, plane, opts = {}) {
  const basis = basisFor(plane.n); const { n, e1, e2 } = basis;
  const P = mesh.P, T = mesh.T, nv = vertCount(mesh), nt = T.length / 3;
  const bb = bbox(mesh); const scale = len(bb.size) || 1;
  let d = plane.d;
  const W = new Float64Array(nv);
  const eps = scale * 1e-7;
  for (let attempt = 0; attempt < 20; attempt++) {
    let bad = false;
    for (let i = 0; i < nv; i++) { W[i] = P[i * 3] * n[0] + P[i * 3 + 1] * n[1] + P[i * 3 + 2] * n[2] - d; if (Math.abs(W[i]) < eps) bad = true; }
    if (!bad) break;
    d += eps * 7.3 * (attempt + 1);
  }
  // intersection points
  const newP = []; const ptCache = new Map();
  const ip = (a, b) => {
    const key = a < b ? a * nv + b : b * nv + a;
    let id = ptCache.get(key);
    if (id === undefined) {
      const t = W[a] / (W[a] - W[b]);
      id = nv + newP.length / 3; ptCache.set(key, id);
      newP.push(P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t);
    }
    return id;
  };
  const posOf = i => i < nv ? [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]] : [newP[(i - nv) * 3], newP[(i - nv) * 3 + 1], newP[(i - nv) * 3 + 2]];
  const uvOf = i => { const p = posOf(i); return [dot(p, e1), dot(p, e2)]; };

  // pass 1: segments of crossing triangles
  const crossTri = []; // {t, k, p01, p02, from, to}
  const next = new Map(); const segOfStart = new Map();
  for (let t = 0; t < nt; t++) {
    const v = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]], s = [W[v[0]] > 0, W[v[1]] > 0, W[v[2]] > 0];
    if (s[0] === s[1] && s[1] === s[2]) continue;
    let k = 0; while (!(s[k] !== s[(k + 1) % 3] && s[k] !== s[(k + 2) % 3])) k++;
    const v0 = v[k], v1 = v[(k + 1) % 3], v2 = v[(k + 2) % 3];
    const p01 = ip(v0, v1), p02 = ip(v0, v2);
    // orientation from winding alone (works for zero-area triangles too): isolated vertex above -> p01 to p02
    const fwd = s[k];
    const from = fwd ? p01 : p02, to = fwd ? p02 : p01;
    if (next.has(from)) return { error: 'The model surface is not clean where it would be cut (overlapping or self-intersecting faces).' };
    next.set(from, to); segOfStart.set(from, crossTri.length);
    crossTri.push({ t, v0, v1, v2, p01, p02, iso: s[k] });
  }
  if (!crossTri.length) return { error: 'The cut plane misses the model.' };
  const { loops, open } = chainLoops(next);
  if (open) return { error: 'The model has holes where it would be cut. Try "Repair" or move the cut.' };
  const loopsUV = loops.map(l => l.map(uvOf));
  const islands = groupIslands(loopsUV);
  if (!islands.length) return { error: 'Could not build a cap for this cut.' };

  // choose islands (local cut) or all
  let chosen = islands;
  if (opts.localPoint) {
    const lp = [dot(opts.localPoint, e1), dot(opts.localPoint, e2)];
    const containing = islands.filter(is => pointInLoops(lp, [loopsUV[is.outer]]));
    if (containing.length) chosen = [containing.sort((a, b) => a.area - b.area)[0]];
    else {
      let best = null, bd = Infinity;
      for (const is of islands) { const dd = distToLoops(lp, [loopsUV[is.outer]]); if (dd < bd) { bd = dd; best = is; } }
      chosen = [best];
    }
    // a part attached at several spots (handle, arm on a hip): also cut every island along the joint
    if (opts.localSpots && opts.localSpots.length) {
      const tol = opts.localTol || 2;
      for (const sp of opts.localSpots) {
        const q = [dot(sp, e1), dot(sp, e2)];
        for (const is of islands) {
          if (chosen.includes(is)) continue;
          const L = [loopsUV[is.outer]];
          if (pointInLoops(q, L) || distToLoops(q, L) <= tol) chosen.push(is);
        }
      }
    }
  }
  const chosenLoops = new Set(); for (const is of chosen) { chosenLoops.add(is.outer); for (const h of is.holes) chosenLoops.add(h); }
  const cutStarts = new Set(); // segment start ids that are cut
  loops.forEach((l, li) => { if (chosenLoops.has(li)) for (const s of l) cutStarts.add(s); });

  // pass 2: build triangles with side labels
  const outT = [], outG = [], side = []; // side: 0 below, 1 above, -1 unknown
  const crossSet = new Map(); for (const c of crossTri) crossSet.set(c.t, c);
  const barrier = new Set();
  const ekey = (a, b) => a < b ? a + ',' + b : b + ',' + a;
  for (let t = 0; t < nt; t++) {
    const c = crossSet.get(t);
    const g = mesh.G[t];
    if (c && (cutStarts.has(c.p01) || cutStarts.has(c.p02))) {
      const isoSide = c.iso ? 1 : 0;
      outT.push(c.v0, c.p01, c.p02); outG.push(g); side.push(isoSide);
      outT.push(c.p01, c.v1, c.v2); outG.push(g); side.push(1 - isoSide);
      outT.push(c.p01, c.v2, c.p02); outG.push(g); side.push(1 - isoSide);
      barrier.add(ekey(c.p01, c.p02));
    } else {
      const v = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
      outT.push(v[0], v[1], v[2]); outG.push(g);
      if (!opts.localPoint) side.push((W[v[0]] + W[v[1]] + W[v[2]]) > 0 ? 1 : 0);
      else side.push(-1);
    }
  }
  if (opts.localPoint) {
    // flood fill sides across the surface, never crossing the cut loop
    const ntt = outT.length / 3; const edgeMap = new Map();
    for (let t = 0; t < ntt; t++) for (let k = 0; k < 3; k++) {
      const key = ekey(outT[t * 3 + k], outT[t * 3 + (k + 1) % 3]);
      if (barrier.has(key)) continue;
      let l = edgeMap.get(key); if (!l) { l = []; edgeMap.set(key, l); } l.push(t);
    }
    const stack = []; for (let t = 0; t < ntt; t++) if (side[t] >= 0) stack.push(t);
    while (stack.length) {
      const t = stack.pop();
      for (let k = 0; k < 3; k++) {
        const l = edgeMap.get(ekey(outT[t * 3 + k], outT[t * 3 + (k + 1) % 3])); if (!l) continue;
        for (const o of l) {
          if (o === t) continue;
          if (side[o] === -1) { side[o] = side[t]; stack.push(o); }
          else if (side[o] !== side[t]) return { error: 'This cut does not separate the model into two pieces at that spot.' };
        }
      }
    }
    // Regions not reached across edges (joined only at a single touching vertex, or separate shells)
    // follow the side of a neighbour sharing a vertex; anything still left stays whole on its majority side.
    let left = 0; for (let t = 0; t < ntt; t++) if (side[t] === -1) left++;
    if (left) {
      const vt = new Map();
      for (let t = 0; t < ntt; t++) for (let k = 0; k < 3; k++) { const v = outT[t * 3 + k]; let l = vt.get(v); if (!l) { l = []; vt.set(v, l); } l.push(t); }
      const q = []; for (let t = 0; t < ntt; t++) if (side[t] >= 0) q.push(t);
      const spread = () => {
        while (q.length) {
          const t = q.pop();
          for (let k = 0; k < 3; k++) {
            // across edges first (same region), then across shared vertices
            const l = edgeMap.get(ekey(outT[t * 3 + k], outT[t * 3 + (k + 1) % 3]));
            if (l) for (const o of l) if (side[o] === -1) { side[o] = side[t]; q.push(o); }
            for (const o of vt.get(outT[t * 3 + k])) if (side[o] === -1) { side[o] = side[t]; q.push(o); }
          }
        }
      };
      spread();
      for (let t0 = 0; t0 < ntt; t0++) if (side[t0] === -1) {
        // separate shell: collect it, put it all on its majority side
        const reg = [t0], seen = new Set([t0]);
        for (let i = 0; i < reg.length; i++) { const t = reg[i]; for (let k = 0; k < 3; k++) for (const o of vt.get(outT[t * 3 + k])) if (side[o] === -1 && !seen.has(o)) { seen.add(o); reg.push(o); } }
        let up = 0; for (const t of reg) { const v = [outT[t * 3], outT[t * 3 + 1], outT[t * 3 + 2]].map(posOf); up += (dot(v[0], n) + dot(v[1], n) + dot(v[2], n)) / 3 - d > 0 ? 1 : -1; }
        for (const t of reg) side[t] = up > 0 ? 1 : 0;
      }
    }
  }

  // ---- caps, connectors, labels
  const allP = Array.from(P).concat(newP); // working vertex array
  const addV = (u, v, w) => { const id = allP.length / 3; allP.push(e1[0] * u + e2[0] * v + n[0] * (w + d), e1[1] * u + e2[1] * v + n[1] * (w + d), e1[2] * u + e2[2] * v + n[2] * (w + d)); return id; };
  const capTris = [[], []]; // per side
  const cutId = opts.cutId || 0;
  const conn = opts.connector || { type: 'none' };
  const wall = opts.wall || 1.6;
  const report = { cutId, islands: chosen.length, connectors: 0, dowels: [], magnets: 0, labeled: 0, notes: [], plane: { n, d }, area: 0 };
  const depthSlices = {};
  const sliceAt = off => { const k = off.toFixed(4); if (!depthSlices[k]) depthSlices[k] = sectionLoops(mesh, basis, d + off); return depthSlices[k]; };
  // sample the whole hole depth (1.5 mm steps) so a new hole never breaks into an old one or the surface
  const depthSteps = (a, b) => { const out = [], n = Math.max(2, Math.ceil((b - a) / 1.5)); for (let i = 0; i <= n; i++) { const o = a + (b - a) * i / n; out.push(Math.abs(o) < 0.05 ? (o < 0 ? -0.05 : 0.05) : o); } return out; };
  const materialOK = (pt, r, offs) => offs.every(off => { const L = sliceAt(off); return pointInLoops(pt, L) && distToLoops(pt, L) >= r; });

  for (const is of chosen) {
    const isLoops = [is.outer, ...is.holes].map(i => loopsUV[i]);
    report.area += is.area;
    // features per side: list of {poly(uv, CCW), w1 (end offset), kind}
    const feats = [[], []];
    const placed = []; // [centre, radius] keep-outs
    if (conn.type !== 'none') {
      const pole = poleOfInaccessibility(isLoops);
      let D = conn.type === 'magnet' ? conn.magnetD : conn.diameter;
      let depth = conn.type === 'magnet' ? conn.magnetH : conn.depth;
      const tol = conn.tolerance;
      if (pole) {
        if (!D) D = Math.max(3, Math.min(10, Math.round((pole.d - wall) * 0.9)));
        if (!depth) depth = Math.max(4, Math.min(15, D * 1.5));
        const r = D / 2, rHole = r + tol;
        const need = rHole + wall;
        const centers = [];
        if (pole.d >= need) {
          centers.push(pole.p);
          // second connector to stop rotation: farthest feasible point from the first
          const { mn, mx } = loopsBBox(isLoops); let best = null, bd = 0; const st = 18;
          for (let i = 0; i <= st; i++) for (let j = 0; j <= st; j++) {
            const p = [mn[0] + (mx[0] - mn[0]) * i / st, mn[1] + (mx[1] - mn[1]) * j / st];
            const dd = Math.hypot(p[0] - pole.p[0], p[1] - pole.p[1]);
            if (dd < rHole * 2 + wall * 2 || dd <= bd) continue;
            if (!pointInLoops(p, isLoops) || distToLoops(p, isLoops) < Math.max(need * 1.5, need + 3)) continue;
            best = p; bd = dd;
          }
          if (best) centers.push(best);
        }
        let any = false;
        for (const cpt of centers) {
          const segs = Math.max(16, Math.min(40, Math.round(D * 3)));
          if (conn.type === 'peg') {
            // peg grows from below piece; hole in above piece
            if (!materialOK(cpt, rHole + wall * 0.75, depthSteps(0, depth + 0.4 + tol))) continue;
            feats[0].push({ poly: circlePoly(cpt, r, segs), w1: depth, kind: 'peg' });
            feats[1].push({ poly: circlePoly(cpt, rHole, segs), w1: depth + 0.4 + tol, kind: 'pocket' });
          } else {
            const hd = conn.type === 'magnet' ? depth + tol : depth + 0.5;
            if (!materialOK(cpt, rHole + wall * 0.75, depthSteps(-hd, hd))) continue;
            feats[0].push({ poly: circlePoly(cpt, rHole, segs), w1: -hd, kind: 'pocket' });
            feats[1].push({ poly: circlePoly(cpt, rHole, segs), w1: hd, kind: 'pocket' });
            if (conn.type === 'dowel') report.dowels.push({ d: D, len: 2 * depth });
            else report.magnets += 2;
          }
          placed.push([cpt, rHole]); report.connectors++; any = true;
        }
        if (!any) report.notes.push(`Cut ${cutId}: too thin for ${conn.type === 'magnet' ? 'magnets' : 'connectors'} — glue or add a brace.`);
      }
    }
    // engraved label (dot-matrix cut number) on both faces, mirrored on the upper face so it reads correctly
    if (opts.label && cutId) {
      const txt = String(cutId);
      const { dots, w, h } = textDots(txt, false);
      const { mn, mx } = loopsBBox(isLoops);
      let done = false;
      for (const pitch of [3, 2.4, 1.9, 1.5, 1.2]) {
        const dotS = pitch * 0.62, margin = wall * 0.6 + dotS;
        const tw = w * pitch, th = h * pitch;
        if (tw > mx[0] - mn[0] || th > mx[1] - mn[1]) continue;
        const st = 14; let spot = null, bestScore = -Infinity;
        for (let i = 0; i <= st && !done; i++) for (let j = 0; j <= st; j++) {
          const c = [mn[0] + tw / 2 + (mx[0] - mn[0] - tw) * i / st, mn[1] + th / 2 + (mx[1] - mn[1] - th) * j / st];
          let ok = true, minD = Infinity;
          for (const dt of dots) {
            for (const mir of [false, true]) {
              const p = [c[0] + (mir ? -dt[0] : dt[0]) * pitch, c[1] + dt[1] * pitch];
              if (!pointInLoops(p, isLoops)) { ok = false; break; }
              const dd = distToLoops(p, isLoops); if (dd < margin) { ok = false; break; }
              for (const [pc, pr] of placed) if (Math.hypot(p[0] - pc[0], p[1] - pc[1]) < pr + dotS + 1) { ok = false; break; }
              if (!ok) break; minD = Math.min(minD, dd);
            }
            if (!ok) break;
          }
          if (ok && minD > bestScore) { bestScore = minD; spot = c; }
        }
        if (spot) {
          const depthE = 0.6;
          for (let sd = 0; sd < 2; sd++) {
            for (const dt of dots) {
              const x = sd === 1 ? -dt[0] : dt[0];
              const jig = 0.021 * pitch * (((dt[0] * 7 + dt[1] * 3) % 5 + 5) % 5) / 4; // breaks exact collinearity between dots
              feats[sd].push({ poly: rectPoly([spot[0] + x * pitch + jig * 0.6, spot[1] + dt[1] * pitch + jig], dotS, dotS), w1: sd === 0 ? -depthE : depthE, kind: 'pocket' });
            }
          }
          report.labeled++; done = true; break;
        }
      }
      if (!done) report.notes.push(`Cut ${cutId}: face too small for an engraved number.`);
    }
    // triangulate cap per side, with feature holes
    for (let sd = 0; sd < 2; sd++) {
      const ringIds = [];
      const flat = [], ids = [], holeIdx = [];
      const chains = new Map(); // simplified edge "a>b" -> straight-run vertices dropped between a and b
      const pushLoop = (uvL, idL) => { for (let k = 0; k < uvL.length; k++) { flat.push(uvL[k][0], uvL[k][1]); ids.push(idL[k]); } };
      const pushSimplified = (uvL, idL) => { const r = simplifyRing(uvL, idL, scale * 1e-9); for (const [k, v] of r.chains) chains.set(k, v); pushLoop(r.uv, r.ids); };
      pushSimplified(loopsUV[is.outer], loops[is.outer]);
      for (const h of is.holes) { holeIdx.push(ids.length); pushSimplified(loopsUV[h], loops[h]); }
      for (const f of feats[sd]) {
        const ring = f.poly.map(p => addV(p[0], p[1], 0));
        ringIds.push(ring);
        holeIdx.push(ids.length); pushLoop(f.poly, ring);
      }
      const tri = earcut(flat, holeIdx);
      const capT = expandChains(Array.from(tri, k => ids[k]), chains);
      const rings = [loops[is.outer], ...is.holes.map(h => loops[h]), ...ringIds];
      const uvAny = id => { const i = id * 3; return [allP[i] * e1[0] + allP[i + 1] * e1[1] + allP[i + 2] * e1[2], allP[i] * e2[0] + allP[i + 1] * e2[1] + allP[i + 2] * e2[2]]; };
      for (const x of fixTJunctions(restoreDropped(capT, rings), rings, uvAny, scale * 1e-9)) capTris[sd].push(x);
      // feature prisms
      feats[sd].forEach((f, fi) => {
        const ring0 = ringIds[fi], ring1 = f.poly.map(p => addV(p[0], p[1], f.w1));
        const m = ring0.length;
        for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; capTris[sd].push(ring0[k], ring0[k2], ring1[k2], ring0[k], ring1[k2], ring1[k]); }
        const ft = []; for (const p of f.poly) ft.push(p[0], p[1]);
        const et = earcut(ft, null); for (let k = 0; k < et.length; k += 3) capTris[sd].push(ring1[et[k]], ring1[et[k + 1]], ring1[et[k + 2]]);
      });
    }
  }

  // assemble the two sides
  const build = sd => {
    const Ts = [], Gs = [];
    for (let t = 0; t < side.length; t++) if (side[t] === sd) { Ts.push(outT[t * 3], outT[t * 3 + 1], outT[t * 3 + 2]); Gs.push(outG[t]); }
    for (let k = 0; k < capTris[sd].length; k += 3) { Ts.push(capTris[sd][k], capTris[sd][k + 1], capTris[sd][k + 2]); Gs.push(cutId || -1); }
    const full = { P: Float64Array.from(allP), T: Uint32Array.from(Ts), G: Int32Array.from(Gs) };
    const tris = []; for (let t = 0; t < Ts.length / 3; t++) tris.push(t);
    return orientMesh(subMesh(full, tris));
  };
  const below = build(0), above = build(1);
  if (!below.T.length || !above.T.length) return { error: 'The cut is at the very edge of the model.' };
  report.d = d;
  return { below, above, report };
}

// Every cut is verified: both halves must be closed. If a rare triangulation case leaks, retry a hair
// to either side, then without connectors, so a leaky STL never reaches the printer.
function cutMesh(mesh, plane, opts = {}) {
  const tight = r => !r.error && edgeStats(r.below).watertight && edgeStats(r.above).watertight;
  let first = null;
  const tries = [0, 0.31, -0.47, 0.83, -1.13];
  for (const conn of [opts.connector, { type: 'none' }]) {
    if (conn !== opts.connector && (!opts.connector || opts.connector.type === 'none')) break;
    for (const off of tries) {
      const r = cutMeshOnce(mesh, { n: plane.n, d: plane.d + off }, { ...opts, connector: conn });
      if (!first) first = r;
      if (r.error && off === 0 && conn === opts.connector) return r; // geometry problem: let the caller try another spot
      if (tight(r)) {
        if (conn !== opts.connector) r.report.notes.push(`Cut ${opts.cutId}: connectors left out here so the faces stay solid. Glue this joint.`);
        return r;
      }
    }
  }
  return first && first.error ? first : { error: 'This cut could not be made cleanly. Move it a little.' };
}

// ---------------------------------------------------------------- auto split to fit the printer
/*
 settings: {
   bed: [x,y,z] mm, margin, mode: 'seams'|'even', connector:{...}, label: bool, wall, maxPieces
 }
*/
function fitsBed(m, bed, margin) {
  const s = bbox(m).size.slice().sort((a, b) => b - a);
  const b = bed.map(v => v - margin * 2).sort((a, b) => b - a);
  return s[0] <= b[0] && s[1] <= b[1] && s[2] <= b[2];
}

function chooseCut(m, settings, avoid) {
  const bb = bbox(m), size = bb.size;
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  const bed = settings.bed.map(v => v - settings.margin * 2).sort((a, b) => b - a);
  let rank = -1;
  for (let r = 0; r < 3; r++) if (size[order[r]] > bed[r] + 1e-9) { rank = r; break; }
  if (rank < 0) return null;
  const axis = order[rank], target = bed[rank], L = size[axis], lo = bb.min[axis];
  const k = Math.ceil(L / target);
  const nrm = [0, 0, 0]; nrm[axis] = 1;
  // sample the whole length, then pick a set of cuts (every gap <= target) with the smallest total seam
  const N = Math.max(60, Math.min(240, Math.ceil(L / 2))), ds = [];
  for (let i = 0; i < N; i++) ds.push(lo + L * (0.03 + 0.94 * (i + 0.5) / N));
  const { areas } = sectionAreas(m, basisFor(nrm), ds);
  const maxA = Math.max(...areas.map(Math.abs)) || 1;
  const cost = ds.map((d, i) => {
    let s = Math.abs(areas[i]) / maxA;
    if (settings.mode === 'even') { const f = (d - lo) / (L / k); s = 0.05 * s + 4 * Math.abs(f - Math.round(f)); }
    for (const a of avoid) if (a.axis === axis && Math.abs(a.d - d) < (a.r || 12)) s += 1.5;
    if (Math.abs(areas[i]) < 1e-6) s += 10;
    return s;
  });
  const perCut = settings.mode === 'even' ? 3 : 0.45; // discourages extra pieces
  // DP: best[i] = cheapest plan whose last cut is at ds[i] (all previous gaps fit)
  const best = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (ds[i] - lo <= target) best[i] = cost[i] + perCut;
    for (let j = 0; j < i; j++) if (best[j] < Infinity && ds[i] - ds[j] <= target && best[j] + cost[i] + perCut < best[i]) { best[i] = best[j] + cost[i] + perCut; prev[i] = j; }
  }
  let end = -1, bc = Infinity;
  for (let i = 0; i < N; i++) if (lo + L - ds[i] <= target && best[i] < bc) { bc = best[i]; end = i; }
  const plan = [];
  for (let i = end; i >= 0; i = prev[i]) plan.unshift(i);
  // execute the cheapest cut of the plan first (usually a natural narrow point); keep the rest as fallbacks
  const ordered = plan.slice().sort((a, b) => cost[a] - cost[b]);
  const rest = ds.map((_, i) => i).filter(i => !plan.includes(i)).sort((a, b) => cost[a] - cost[b]);
  return ordered.concat(rest).map(i => ({ d: ds[i], s: cost[i], axis, n: nrm }));
}

function autoSplit(pieces, settings, progress) {
  // pieces: [{mesh, name?, cuts:[...] }]
  let cutCounter = settings.startCutId || 0;
  const done = [], queue = pieces.slice(), reports = [], notes = [];
  const maxPieces = settings.maxPieces || 250;
  const conn = settings.connector;
  const avoidR = (conn && conn.type !== 'none' ? (conn.depth || 12) + 4 : 6);
  let guard = 0;
  while (queue.length) {
    if (++guard > 400) { notes.push('Stopped early: too many cuts.'); done.push(...queue); break; }
    const pc = queue.shift();
    if (fitsBed(pc.mesh, settings.bed, settings.margin) || done.length + queue.length + 1 >= maxPieces) { done.push(pc); continue; }
    const cands = chooseCut(pc.mesh, settings, pc.avoid || []);
    if (!cands) { done.push(pc); continue; }
    let ok = false;
    for (let ci = 0; ci < Math.min(8, cands.length); ci++) {
      const c = cands[ci];
      const id = cutCounter + 1;
      const r = cutMesh(pc.mesh, { n: c.n, d: c.d }, { cutId: id, connector: conn, label: settings.label, wall: settings.wall });
      if (r.error) continue;
      if (settings.onCut) settings.onCut(pc.mesh, c, r);
      cutCounter = id; reports.push(r.report); ok = true;
      const av = (pc.avoid || []).concat([{ axis: c.axis, d: r.report.d, r: avoidR }]);
      for (const half of [r.below, r.above]) for (const comp of components(half)) {
        if (comp.T.length < 12) continue;
        queue.push({ mesh: comp, avoid: av });
      }
      if (progress) progress({ cuts: cutCounter, pieces: done.length + queue.length });
      break;
    }
    if (!ok) { notes.push('One piece could not be cut automatically and may not fit the bed.'); done.push(pc); }
  }
  return { pieces: done, reports, notes, lastCutId: cutCounter };
}

// ---------------------------------------------------------------- guided anatomical cuts (from a segmented model, e.g. Tripo)
// segParts: [{mesh, name}] in any coordinate frame; original: mesh. Returns plane proposals.
function alignSegmentation(original, segParts) {
  const seg = mergeMeshes(segParts.map(p => p.mesh));
  const labels = []; segParts.forEach((p, i) => { for (let k = 0; k < p.mesh.P.length / 3; k++) labels.push(i); });
  const ob = bbox(original);
  const rots = [];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms) for (let sg = 0; sg < 8; sg++) {
    const R = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) R[r * 3 + p[r]] = (sg >> r) & 1 ? -1 : 1;
    rots.push(R);
  }
  const sample = []; const nvO = original.P.length / 3; const stepO = Math.max(1, Math.floor(nvO / 1500));
  for (let i = 0; i < nvO; i += stepO) sample.push([original.P[i * 3], original.P[i * 3 + 1], original.P[i * 3 + 2]]);
  let best = null;
  for (const R of rots) {
    let m = rotateMesh(seg, R); const b = bbox(m);
    const s = len(ob.size) / (len(b.size) || 1);
    if (!isFinite(s) || s <= 0) continue;
    const sc = [0, 1, 2].map(a => (b.size[a] * s) / (ob.size[a] || 1));
    if (sc.some(v => v < 0.8 || v > 1.25)) continue;
    m = translateMesh(scaleMesh(m, s, b.center), sub(ob.center, b.center));
    const grid = buildGrid(m.P, len(ob.size) / 40);
    let err = 0; for (const p of sample) err += nearestInGrid(grid, m.P, p).d;
    if (!best || err < best.err) best = { err, mesh: m };
  }
  if (!best) return null;
  return { P: best.mesh.P, labels };
}
function buildGrid(P, cell) {
  const g = new Map();
  for (let i = 0; i < P.length / 3; i++) {
    const k = Math.floor(P[i * 3] / cell) + ',' + Math.floor(P[i * 3 + 1] / cell) + ',' + Math.floor(P[i * 3 + 2] / cell);
    let l = g.get(k); if (!l) { l = []; g.set(k, l); } l.push(i);
  }
  return { g, cell };
}
function nearestInGrid(grid, P, p) {
  const { g, cell } = grid; const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
  let best = -1, bd = Infinity;
  for (let r = 0; r < 4 && best < 0; r++) for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
    const l = g.get(x + ',' + y + ',' + z); if (!l) continue;
    for (const i of l) { const d = (P[i * 3] - p[0]) ** 2 + (P[i * 3 + 1] - p[1]) ** 2 + (P[i * 3 + 2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } }
  }
  return { i: best, d: best < 0 ? cell * 4 : Math.sqrt(bd) };
}
function proposeGuidedCuts(original, segParts) {
  const al = alignSegmentation(original, segParts);
  if (!al) return { error: 'Could not line the segmented model up with your file.' };
  const ob = bbox(original);
  const grid = buildGrid(al.P, len(ob.size) / 60);
  const nv = original.P.length / 3, lab = new Int32Array(nv);
  for (let i = 0; i < nv; i++) { const q = nearestInGrid(grid, al.P, [original.P[i * 3], original.P[i * 3 + 1], original.P[i * 3 + 2]]); lab[i] = q.i >= 0 ? al.labels[q.i] : -1; }
  const groups = new Map(); const T = original.T;
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = T[t + k], b = T[t + (k + 1) % 3];
    if (lab[a] === lab[b] || lab[a] < 0 || lab[b] < 0) continue;
    const key = Math.min(lab[a], lab[b]) + '-' + Math.max(lab[a], lab[b]);
    let l = groups.get(key); if (!l) { l = []; groups.set(key, l); }
    l.push([(original.P[a * 3] + original.P[b * 3]) / 2, (original.P[a * 3 + 1] + original.P[b * 3 + 1]) / 2, (original.P[a * 3 + 2] + original.P[b * 3 + 2]) / 2]);
  }
  const cuts = [];
  for (const [key, pts] of groups) {
    if (pts.length < 10) continue;
    const { c, n } = fitPlane(pts);
    const [i, j] = key.split('-').map(Number);
    // spots: boundary points near the plane, thinned, so separate contact areas of one joint are all known
    const spots = []; const dmax = len(ob.size) * 0.004;
    const near = pts.filter(p => Math.abs(dot(n, p) - dot(n, c)) <= Math.max(dmax * 6, 1e-9));
    const step = Math.max(1, Math.floor(near.length / 40));
    for (let k = 0; k < near.length; k += step) spots.push(near[k]);
    cuts.push({ key, a: segParts[i].name || 'part ' + (i + 1), b: segParts[j].name || 'part ' + (j + 1), c, n, d: dot(n, c), size: pts.length, spots });
  }
  cuts.sort((x, y) => y.size - x.size);
  return { cuts, labels: lab };
}

function applyGuidedCuts(pieces, cuts, settings) {
  let cutId = settings.startCutId || 0; const reports = [], notes = [];
  let list = pieces.slice();
  for (const c of cuts) {
    // find piece whose surface is closest to the cut centre
    let bestI = -1, bd = Infinity;
    list.forEach((pc, i) => {
      const b = bbox(pc.mesh);
      if (c.c.some((v, a) => v < b.min[a] - 1 || v > b.max[a] + 1)) return;
      const step = Math.max(1, Math.floor(pc.mesh.P.length / 3 / 4000));
      for (let k = 0; k < pc.mesh.P.length / 3; k += step) { const dd = Math.hypot(pc.mesh.P[k * 3] - c.c[0], pc.mesh.P[k * 3 + 1] - c.c[1], pc.mesh.P[k * 3 + 2] - c.c[2]); if (dd < bd) { bd = dd; bestI = i; } }
    });
    if (bestI < 0) { notes.push(`Skipped ${c.a} / ${c.b}: not found.`); continue; }
    const base = { cutId: cutId + 1, localPoint: c.c, connector: settings.connector, label: settings.label, wall: settings.wall };
    let r = cutMesh(list[bestI].mesh, { n: c.n, d: c.d }, base);
    if (r.error && /does not separate/.test(r.error) && c.spots && c.spots.length) {
      const b = bbox(list[bestI].mesh);
      r = cutMesh(list[bestI].mesh, { n: c.n, d: c.d }, { ...base, localSpots: c.spots, localTol: len(b.size) * 0.01 });
    }
    if (r.error) { notes.push(`Skipped ${c.a} / ${c.b}: ${r.error}`); continue; }
    cutId++; r.report.joint = c.a + ' / ' + c.b; reports.push(r.report);
    const rest = list.filter((_, i) => i !== bestI);
    for (const half of [r.below, r.above]) for (const comp of components(half)) if (comp.T.length >= 12) rest.push({ mesh: comp, avoid: [] });
    list = rest;
  }
  return { pieces: list, reports, notes, lastCutId: cutId };
}

// ---------------------------------------------------------------- merge overlapping parts into one solid
/*
 AI part generators (PartCrafter, Tripo parts) return closed parts that overlap each other.
 voxelUnion fills each part (ray parity along X, Y and Z, majority vote, so small holes don't leak),
 ORs them, softens the voxels and extracts one watertight surface with marching tetrahedra.
 res = voxels along the longest side.
*/
function solidGrid(meshes, res, progress) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) { const b = bbox(m); for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], b.min[a]); mx[a] = Math.max(mx[a], b.max[a]); } }
  const size = sub(mx, mn), L = Math.max(...size) || 1, h = L / res, pad = 3;
  const dims = size.map(s => Math.ceil(s / h) + 2 * pad);
  const [nx, ny, nz] = dims, N = nx * ny * nz;
  const org = mn.map(v => v - pad * h);
  const solid = new Uint8Array(N), tmp = new Uint8Array(N);
  const id = (i, j, k) => i + nx * (j + ny * k);
  meshes.forEach((m, mi) => {
    if (progress) progress({ stage: 'fill', part: mi + 1, of: meshes.length });
    const b = bbox(m);
    const lo = [0, 1, 2].map(a => Math.max(0, Math.floor((b.min[a] - org[a]) / h) - 1)), hi = [0, 1, 2].map(a => Math.min(dims[a] - 1, Math.ceil((b.max[a] - org[a]) / h) + 1));
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) tmp.fill(0, id(lo[0], j, k), id(hi[0], j, k) + 1);
    for (let a = 0; a < 3; a++) {
      const bA = (a + 1) % 3, cA = (a + 2) % 3, nb = dims[bA], nc = dims[cA];
      const hits = new Array(nb * nc);
      const jit = [1.37e-4, 2.91e-4, 4.13e-4];
      const P = m.P, T = m.T;
      for (let t = 0; t < T.length; t += 3) {
        const v0 = T[t] * 3, v1 = T[t + 1] * 3, v2 = T[t + 2] * 3;
        const xb = [P[v0 + bA], P[v1 + bA], P[v2 + bA]], xc = [P[v0 + cA], P[v1 + cA], P[v2 + cA]], xa = [P[v0 + a], P[v1 + a], P[v2 + a]];
        const ub = xb.map(v => (v - org[bA]) / h - 0.5 - jit[a]), uc = xc.map(v => (v - org[cA]) / h - 0.5 - jit[(a + 1) % 3]);
        const i0 = Math.max(0, Math.ceil(Math.min(...ub))), i1 = Math.min(nb - 1, Math.floor(Math.max(...ub)));
        const j0 = Math.max(0, Math.ceil(Math.min(...uc))), j1 = Math.min(nc - 1, Math.floor(Math.max(...uc)));
        if (i0 > i1 || j0 > j1) continue;
        const d = (ub[1] - ub[0]) * (uc[2] - uc[0]) - (ub[2] - ub[0]) * (uc[1] - uc[0]);
        if (d === 0) continue;
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const w1 = ((i - ub[0]) * (uc[2] - uc[0]) - (ub[2] - ub[0]) * (j - uc[0])) / d;
          const w2 = ((ub[1] - ub[0]) * (j - uc[0]) - (i - ub[0]) * (uc[1] - uc[0])) / d;
          const w0 = 1 - w1 - w2;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * xa[0] + w1 * xa[1] + w2 * xa[2];
          const c = i + nb * j; (hits[c] || (hits[c] = [])).push(z);
        }
      }
      const bit = 1 << a, cell = [0, 0, 0];
      for (let c = 0; c < hits.length; c++) {
        const hz = hits[c]; if (!hz || hz.length < 2) continue;
        hz.sort((x, y) => x - y);
        cell[bA] = c % nb; cell[cA] = Math.floor(c / nb);
        for (let q = 0; q + 1 < hz.length; q += 2) {
          const k0 = Math.max(0, Math.ceil((hz[q] - org[a]) / h - 0.5)), k1 = Math.min(dims[a] - 1, Math.floor((hz[q + 1] - org[a]) / h - 0.5));
          for (let k = k0; k <= k1; k++) { cell[a] = k; tmp[id(cell[0], cell[1], cell[2])] |= bit; }
        }
      }
    }
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const v = tmp[id(i, j, k)]; if (((v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1)) >= 2) solid[id(i, j, k)] = 1;
    }
  });
  return { solid, dims, org, h, nx, ny, nz, N, id };
}

function voxelUnion(meshes, res = 192, smoothIters = 6, progress) {
  const G = solidGrid(meshes, res, progress);
  const { solid, dims, org, h, nx, ny, nz, N, id } = G;
  if (progress) progress({ stage: 'surface' });
  // soften: 3x3x3 neighbour count (0..27) at each grid point, iso 13.5
  const F = new Uint8Array(N);
  { // separable box sum
    const A = new Uint8Array(N), B = new Uint8Array(N);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const p = id(i, j, k); A[p] = solid[p] + (i > 0 ? solid[p - 1] : 0) + (i < nx - 1 ? solid[p + 1] : 0); }
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const p = id(i, j, k); B[p] = A[p] + (j > 0 ? A[p - nx] : 0) + (j < ny - 1 ? A[p + nx] : 0); }
    const s = nx * ny;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const p = id(i, j, k); F[p] = B[p] + (k > 0 ? B[p - s] : 0) + (k < nz - 1 ? B[p + s] : 0); }
  }
  const iso = 13.5;
  // marching tetrahedra on the Kuhn split of each cube (consistent across faces, always watertight)
  const CO = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const TETS = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
  const vmap = new Map(), Pout = [], Tout = [];
  const gp = (g) => { const i = g % nx, r = Math.floor(g / nx), j = r % ny, k = Math.floor(r / ny); return [i, j, k]; };
  const ev = (ga, gb) => {
    const key = ga < gb ? ga * N + gb : gb * N + ga;
    let v = vmap.get(key);
    if (v === undefined) {
      const fa = F[ga], fb = F[gb], t = (iso - fa) / (fb - fa); const A = gp(ga), B = gp(gb);
      v = Pout.length / 3; vmap.set(key, v);
      for (let q = 0; q < 3; q++) Pout.push(org[q] + h * (A[q] + (B[q] - A[q]) * t + 0.5));
    }
    return v;
  };
  const pos = v => [Pout[v * 3], Pout[v * 3 + 1], Pout[v * 3 + 2]];
  const emit = (a, b, c, insideG, outsideG) => {
    const pa = pos(a), pb = pos(b), pc = pos(c);
    const nn = cross(sub(pb, pa), sub(pc, pa));
    const gi = gp(insideG), go = gp(outsideG); const dir = sub(go, gi);
    if (dot(nn, dir) < 0) Tout.push(a, c, b); else Tout.push(a, b, c);
  };
  const g = new Array(8), f = new Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let anyIn = false, anyOut = false;
    for (let c = 0; c < 8; c++) { g[c] = id(i + CO[c][0], j + CO[c][1], k + CO[c][2]); f[c] = F[g[c]] > iso; if (f[c]) anyIn = true; else anyOut = true; }
    if (!anyIn || !anyOut) continue;
    for (const tt of TETS) {
      const ins = [], outs = [];
      for (const c of tt) (f[c] ? ins : outs).push(g[c]);
      if (ins.length === 0 || ins.length === 4) continue;
      if (ins.length === 1) emit(ev(ins[0], outs[0]), ev(ins[0], outs[1]), ev(ins[0], outs[2]), ins[0], outs[0]);
      else if (ins.length === 3) emit(ev(outs[0], ins[0]), ev(outs[0], ins[1]), ev(outs[0], ins[2]), ins[0], outs[0]);
      else {
        const a = ev(ins[0], outs[0]), b = ev(ins[0], outs[1]), c = ev(ins[1], outs[1]), d = ev(ins[1], outs[0]);
        emit(a, b, c, ins[0], outs[0]); emit(a, c, d, ins[0], outs[0]);
      }
    }
  }
  let out = makeMesh(Pout, Tout);
  // drop degenerate zero-area triangles (vertex snapped to a grid point twice is impossible, but guard anyway)
  out = orientMesh(out);
  if (smoothIters > 0) out = taubin(out, smoothIters);
  // keep the biggest connected solids only (drop voxel dust)
  const comps = components(out).map(c => ({ c, v: Math.abs(volume(c)) })).sort((x, y) => y.v - x.v);
  const keep = comps.filter(o => o.v > comps[0].v * 0.002).map(o => o.c);
  return { mesh: keep.length === 1 ? keep[0] : mergeMeshes(keep), voxel: h };
}

function taubin(m, iters, lambda = 0.5, mu = -0.53) {
  const nv = m.P.length / 3, T = m.T;
  const deg = new Uint32Array(nv + 1);
  const edges = new Set();
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = T[t + k], b = T[t + (k + 1) % 3]; const key = a < b ? a * nv + b : b * nv + a;
    if (!edges.has(key)) { edges.add(key); deg[a]++; deg[b]++; }
  }
  const start = new Uint32Array(nv + 1); for (let i = 0; i < nv; i++) start[i + 1] = start[i] + deg[i];
  const nb = new Uint32Array(start[nv]), fill = start.slice(0, nv);
  for (const key of edges) { const a = Math.floor(key / nv), b = key % nv; nb[fill[a]++] = b; nb[fill[b]++] = a; }
  let P = new Float64Array(m.P), Q = new Float64Array(P.length);
  for (let it = 0; it < iters * 2; it++) {
    const f = it % 2 ? mu : lambda;
    for (let i = 0; i < nv; i++) {
      const s = start[i], e = start[i + 1], n = e - s;
      if (!n) { Q[i * 3] = P[i * 3]; Q[i * 3 + 1] = P[i * 3 + 1]; Q[i * 3 + 2] = P[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0; for (let q = s; q < e; q++) { const j = nb[q] * 3; x += P[j]; y += P[j + 1]; z += P[j + 2]; }
      Q[i * 3] = P[i * 3] + f * (x / n - P[i * 3]); Q[i * 3 + 1] = P[i * 3 + 1] + f * (y / n - P[i * 3 + 1]); Q[i * 3 + 2] = P[i * 3 + 2] + f * (z / n - P[i * 3 + 2]);
    }
    const sw = P; P = Q; Q = sw;
  }
  return { P, T: m.T, G: m.G };
}

// ---------------------------------------------------------------- built-in anatomical joints (no AI)
/*
 findBodyJoints(mesh, {res, secondary, up}) finds where limbs, head and tail join the body:
 1. fill the model on a voxel grid and measure each voxel's distance to the surface (thickness)
 2. the thickest voxel is the core (chest / pelvis); walk outward along the middle of the shape
 3. tips that stick out far (head, hands, feet, tail, horns) are the farthest points from the core
 4. along each tip's path the thickness jumps where the limb meets the body: cut at that narrowing
    (neck, shoulder, hip), across the limb's direction. With secondary, also at elbows and knees.
 Returns cuts in the same shape as proposeGuidedCuts.
*/
function findBodyJoints(mesh, opts = {}) {
  const res = opts.res || 96, up = opts.up || [0, 0, 1];
  const G = solidGrid([mesh], res);
  const { dims, org, h, nx, ny, nz, N, id } = G;
  // solid := everything not reachable from outside (fills internal voids so hollow parts still count)
  const solid = G.solid, outside = new Uint8Array(N);
  { const st = []; const push = p => { if (!outside[p] && !solid[p]) { outside[p] = 1; st.push(p); } };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { push(id(0, j, k)); push(id(nx - 1, j, k)); }
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { push(id(i, 0, k)); push(id(i, ny - 1, k)); }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { push(id(i, j, 0)); push(id(i, j, nz - 1)); }
    while (st.length) { const p = st.pop(); const i = p % nx, j = Math.floor(p / nx) % ny, k = Math.floor(p / (nx * ny));
      if (i > 0) push(p - 1); if (i < nx - 1) push(p + 1); if (j > 0) push(p - nx); if (j < ny - 1) push(p + nx); if (k > 0) push(p - nx * ny); if (k < nz - 1) push(p + nx * ny); } }
  for (let p = 0; p < N; p++) solid[p] = outside[p] ? 0 : 1;
  // 26-neighbour offsets and lengths
  const NB = []; for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj || dk) NB.push([di, dj, dk, Math.hypot(di, dj, dk)]);
  // distance to surface (two-pass chamfer, voxel units)
  const DT = new Float32Array(N); for (let p = 0; p < N; p++) DT[p] = solid[p] ? 1e9 : 0;
  const fwd = NB.filter(([di, dj, dk]) => dk < 0 || (dk === 0 && (dj < 0 || (dj === 0 && di < 0))));
  const bwd = NB.filter(o => !fwd.includes(o));
  const pass = (list, dir) => {
    const k0 = dir > 0 ? 0 : nz - 1, k1 = dir > 0 ? nz : -1, j0 = dir > 0 ? 0 : ny - 1, j1 = dir > 0 ? ny : -1, i0 = dir > 0 ? 0 : nx - 1, i1 = dir > 0 ? nx : -1;
    for (let k = k0; k !== k1; k += dir) for (let j = j0; j !== j1; j += dir) for (let i = i0; i !== i1; i += dir) {
      const p = id(i, j, k); if (!solid[p]) continue; let v = DT[p];
      for (const [di, dj, dk, l] of list) { const a = i + di, b = j + dj, c = k + dk; if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) { v = Math.min(v, l); continue; } const q = DT[id(a, b, c)] + l; if (q < v) v = q; }
      DT[p] = v;
    }
  };
  pass(fwd, 1); pass(bwd, -1);
  // core = a thick voxel near the centre of mass (so a big stylised head isn't taken for the body)
  let maxDT = 0, cx = 0, cy = 0, cz = 0, cnt = 0;
  for (let p = 0; p < N; p++) if (solid[p]) { if (DT[p] > maxDT) maxDT = DT[p]; cx += p % nx; cy += Math.floor(p / nx) % ny; cz += Math.floor(p / (nx * ny)); cnt++; }
  if (!cnt || maxDT < 1.5) return { cuts: [], note: 'The model is too thin to find body parts at this detail.' };
  cx /= cnt; cy /= cnt; cz /= cnt;
  let core = -1, best = -Infinity; const Lv = Math.max(nx, ny, nz);
  for (let p = 0; p < N; p++) if (solid[p] && DT[p] >= 0.45 * maxDT) {
    const i = p % nx, j = Math.floor(p / nx) % ny, k = Math.floor(p / (nx * ny));
    const sc = DT[p] / maxDT - Math.hypot(i - cx, j - cy, k - cz) / (0.18 * Lv);
    if (sc > best) { best = sc; core = p; }
  }
  const R = DT[core];
  const xyz = p => [p % nx, Math.floor(p / nx) % ny, Math.floor(p / (nx * ny))];
  const world = p => { const [i, j, k] = xyz(p); return [org[0] + (i + 0.5) * h, org[1] + (j + 0.5) * h, org[2] + (k + 0.5) * h]; };
  // Dijkstra over solid voxels; weight favours the middle of the shape so paths follow the limb's centre
  // Dijkstra over solid voxels (indexed binary heap); centred weights keep paths in the middle of the limb
  const dijkstra = (sources, centred) => {
    const dist = new Float32Array(N).fill(Infinity), par = new Int32Array(N).fill(-1);
    const heap = new Int32Array(N), pos = new Int32Array(N).fill(-1); let hn = 0;
    const less = (x, y) => dist[heap[x]] < dist[heap[y]];
    const swap = (x, y) => { const t = heap[x]; heap[x] = heap[y]; heap[y] = t; pos[heap[x]] = x; pos[heap[y]] = y; };
    const upH = c => { while (c) { const pa = (c - 1) >> 1; if (!less(c, pa)) break; swap(c, pa); c = pa; } };
    const downH = c => { for (;;) { const l = 2 * c + 1, r2 = l + 1; let m = c; if (l < hn && less(l, m)) m = l; if (r2 < hn && less(r2, m)) m = r2; if (m === c) break; swap(m, c); c = m; } };
    const pushOrDec = q => { if (pos[q] < 0) { heap[hn] = q; pos[q] = hn; hn++; } upH(pos[q]); };
    for (const s0 of sources) { dist[s0] = 0; pushOrDec(s0); }
    const sx = 1, sy = nx, sz = nx * ny;
    while (hn) {
      const p = heap[0]; hn--; if (hn) { heap[0] = heap[hn]; pos[heap[0]] = 0; downH(0); } pos[p] = -2;
      const i = p % nx, j = Math.floor(p / nx) % ny, k = Math.floor(p / sz), d = dist[p];
      for (let t = 0; t < 26; t++) {
        const o = NB[t], a2 = i + o[0], b2 = j + o[1], c2 = k + o[2];
        if (a2 < 0 || b2 < 0 || c2 < 0 || a2 >= nx || b2 >= ny || c2 >= nz) continue;
        const q = p + o[0] * sx + o[1] * sy + o[2] * sz; if (!solid[q] || pos[q] === -2) continue;
        const w = centred ? o[3] * (1 + 4 / (DT[q] + 0.5)) : o[3];
        if (d + w < dist[q]) { dist[q] = d + w; par[q] = p; pushOrDec(q); }
      }
    }
    return { dist, par };
  };
  // tips: farthest-point sampling by distance inside the shape
  const tips = [], minLen = Math.max(3 * R, res * 0.12);
  let D = dijkstra([core], false).dist;
  for (let t = 0; t < 10; t++) {
    let best = -1, bd = 0; for (let p = 0; p < N; p++) if (solid[p] && D[p] < Infinity && D[p] > bd) { bd = D[p]; best = p; }
    if (best < 0 || bd < minLen) break;
    tips.push(best);
    const Dn = dijkstra([best], false).dist; for (let p = 0; p < N; p++) if (Dn[p] < D[p]) D[p] = Dn[p];
  }
  const { par } = dijkstra([core], true);
  const coreW = world(core), upn = norm(up);
  const cuts = [], used = [];
  const dirAt = (path, s, k = 3) => { const a = world(path[Math.max(0, s - k)]), b = world(path[Math.min(path.length - 1, s + k)]); return norm(sub(a, b)); }; // toward the tip
  const addCut = (path, s, kind, tip) => {
    const c = world(path[s]); const n = dirAt(path, s);
    for (const u of used) if (len(sub(u, c)) < Math.max(2.5 * h, DT[path[s]] * h * 1.2)) return false;
    used.push(c);
    cuts.push({ kind, tip, c, n, d: dot(n, c), r: DT[path[s]] * h, size: Math.round(DT[path[s]] * 10), spots: [c] });
    return true;
  };
  // centre paths from every tip to the core share voxels where limbs branch off the body
  const paths = tips.map(tip => { const path = []; for (let p = tip; p >= 0; p = par[p]) { path.push(p); if (p === core) break; } return path[path.length - 1] === core ? path : null; });
  const stepLen = (pa, s) => len(sub(world(pa[s]), world(pa[s + 1]))) / h;
  // a tip is a real limb if its path runs a good way out from where it branches and is clearly thinner than the body there
  const analyse = (live) => {
    const pts = {}; for (const ti of live) pts[ti] = paths[ti].map(p => xyz(p));
    const out = {};
    for (const ti of live) {
      const path = paths[ti], r = path.map(p => DT[p]);
      // branch: first point (from the tip) that comes close to another limb's path or reaches the core
      let sb = path.length - 1;
      outer: for (let s2 = 0; s2 < path.length; s2++) {
        const a = pts[ti][s2], lim = Math.max(1.5, 0.6 * r[s2]);
        for (const tj of live) { if (tj === ti) continue; for (const b of pts[tj]) if (Math.abs(a[0] - b[0]) <= lim && Math.abs(a[1] - b[1]) <= lim && Math.abs(a[2] - b[2]) <= lim && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= lim) { sb = s2; break outer; } }
      }
      const Rb = Math.max(r[sb], ...r.slice(sb, Math.min(r.length, sb + 6)));
      const along = new Float32Array(sb + 1); for (let s2 = sb - 1; s2 >= 0; s2--) along[s2] = along[s2 + 1] + stepLen(path, s2);
      let thin = 0; for (let s2 = 0; s2 < sb; s2++) if (r[s2] <= 0.75 * Rb) thin += stepLen(path, s2);
      // or a clear neck: a narrowing with a bulb (head, hand, paw) beyond it
      let neck = false;
      for (let s2 = 1; s2 < sb && !neck; s2++) {
        if (r[s2] > 0.7 * Rb || along[s2] < 0.5 * Rb) continue;
        let bulb = 0; for (let q = 0; q < s2; q++) bulb = Math.max(bulb, r[q]);
        if (bulb >= 1.4 * r[s2] && along[0] - along[s2] >= 1.5 * r[s2]) neck = true;
      }
      out[ti] = { path, r, sb, Rb, along, limbLen: along[0], ok: along[0] >= Math.max(1.6 * Rb, 4) && (thin >= Math.max(1.2 * Rb, 3) || neck) };
    }
    return out;
  };
  let live = paths.map((p, i) => (p && p.length >= 6 ? i : -1)).filter(i => i >= 0), info = analyse(live);
  const all = live.slice();
  for (let it = 0; it < 6; it++) { const keep = live.filter(ti => info[ti].ok); if (keep.length === live.length) break; live = keep; info = analyse(live); }
  // tips dropped early (their branch was thrown off by bumps) get a second look against the real limbs
  for (const ti of all) if (!live.includes(ti)) { const one = analyse(live.concat([ti]))[ti]; if (one.ok) { info[ti] = one; live.push(ti); } }
  live.forEach(ti => {
    const { path, r, sb, Rb, along, limbLen, ok } = info[ti];
    if (!ok) return;
    // the limb starts where it becomes clearly thinner than the body; cut at its narrowest point just past that
    let start = -1; for (let s2 = sb; s2 >= 0; s2--) if (r[s2] <= 0.8 * Rb) { start = s2; break; }
    if (start < 0) return;
    const reach = along[start] + Math.max(2 * r[start], 0.15 * limbLen);
    let sMin = start;
    for (let s2 = start; s2 >= 0; s2--) {
      if (along[s2] > Math.min(reach, 0.7 * limbLen)) break;
      if (r[s2] < r[sMin]) sMin = s2;
    }
    // refine on the real surface: the smallest true cross-section of this limb near the body
    if (opts.refine !== false) {
      const lo = Math.max(0.3 * Rb, 1), hi = Math.min(0.75 * limbLen, along[start] + 3 * Rb);
      const cand = []; for (let s2 = sb; s2 >= 0; s2--) { if (along[s2] < lo) continue; if (along[s2] > hi) break; cand.push(s2); }
      if (cand.length) {
        // only triangles near this stretch of the limb
        const pts3 = cand.map(s2 => world(path[s2])), rad = (Rb + 2) * h * 2.2;
        const bmn = [0, 1, 2].map(a => Math.min(...pts3.map(q => q[a])) - rad), bmx = [0, 1, 2].map(a => Math.max(...pts3.map(q => q[a])) + rad);
        const P = mesh.P, T = mesh.T, keep = [];
        for (let t = 0; t < T.length; t += 3) {
          let inside = false;
          for (let k = 0; k < 3 && !inside; k++) { const v = T[t + k] * 3; if (P[v] >= bmn[0] && P[v] <= bmx[0] && P[v + 1] >= bmn[1] && P[v + 1] <= bmx[1] && P[v + 2] >= bmn[2] && P[v + 2] <= bmx[2]) inside = true; }
          if (inside) keep.push(t / 3);
        }
        const sub0 = subMesh(mesh, keep);
        let bestS = -1, bestScore = Infinity;
        for (let q = 0; q < cand.length; q += cand.length > 24 ? 2 : 1) {
          const s2 = cand[q], c = world(path[s2]), n = dirAt(path, s2, 4), B = basisFor(n);
          const loopsQ = sectionLoops(sub0, B, dot(B.n, c) + h * 1e-3);
          if (!loopsQ.length) continue;
          const lp = [dot(c, B.e1), dot(c, B.e2)];
          const isl = groupIslands(loopsQ).filter(is => pointInLoops(lp, [loopsQ[is.outer]])).sort((a, b) => a.area - b.area)[0];
          if (!isl) continue;
          const score = Math.abs(isl.area) * (1 + 0.12 * along[s2] / Rb);
          if (score < bestScore) { bestScore = score; bestS = s2; }
        }
        if (bestS >= 0) sMin = bestS;
      }
    }
    if (!addCut(path, sMin, 'junction', ti)) return;
    const isHead = (() => { const v = sub(world(path[0]), coreW); return dot(v, norm(up)) > 0 && Math.abs(dot(v, norm(up))) > 0.8 * len(v); })();
    if (opts.secondary && !isHead) {
      // elbows / knees: clear narrowings between the cut and the tip
      const lim = r.slice(0, sMin);
      for (let s2 = Math.ceil(2 * r[sMin]) + 2; s2 < sMin - Math.ceil(1.5 * r[sMin]); s2++) {
        const w2 = Math.ceil(Math.max(3, lim[s2] * 2.5));
        let a2 = 0, b2 = 0, isMin = true;
        for (let q = Math.max(0, s2 - w2); q <= Math.min(sMin - 1, s2 + w2); q++) { if (lim[q] < lim[s2]) { isMin = false; break; } if (q < s2) a2 = Math.max(a2, lim[q]); if (q > s2) b2 = Math.max(b2, lim[q]); }
        if (isMin && lim[s2] <= 0.85 * Math.min(a2, b2) && lim[s2] >= 1) { addCut(path, s2, 'mid', ti); s2 += w2; }
      }
    }
  });
  // name the parts from where they sit relative to the core (up axis, left/right across it)
  const side = (() => { const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].filter(a => Math.abs(dot(a, upn)) < 0.5); return ax[0] || [1, 0, 0]; })();
  const tipInfo = tips.map(t => { const v = sub(world(t), coreW); return { up: dot(v, upn), side: dot(v, side), tip: t }; });
  const juncs = cuts.filter(c => c.kind === 'junction');
  const headTip = juncs.length ? juncs.reduce((b, c) => (tipInfo[c.tip].up > tipInfo[b.tip].up ? c : b)).tip : -1;
  const label = c => {
    const ti = tipInfo[c.tip], jv = sub(c.c, coreW), lr = Math.abs(ti.side) < R * h * 0.5 ? '' : (ti.side > 0 ? 'left ' : 'right ');
    if (c.tip === headTip && ti.up > 0 && Math.abs(ti.side) < Math.abs(ti.up)) return 'head';
    if (dot(jv, upn) > -R * h * 0.3 && ti.up > -Math.abs(ti.side) * 3) return lr + 'arm';
    if (ti.up < 0 && Math.abs(ti.side) < Math.abs(ti.up) * 0.6 && lr === '') return 'tail or base';
    return lr + 'leg';
  };
  for (const c of cuts) {
    const base = label(c);
    if (c.kind === 'junction') { c.a = base; c.b = 'body'; }
    else { const joint = /arm/.test(base) ? 'elbow' : /leg/.test(base) ? 'knee' : 'joint'; c.a = base.replace(/(arm|leg)$/, '') + joint; c.b = base; }
    c.key = c.a + '|' + c.b;
  }
  return { cuts: cuts.map(({ tip, kind, ...rest }) => ({ ...rest, kind })), core: coreW, tips: tips.map(world), voxel: h };
}

// ---------------------------------------------------------------- parts that join at each cut
function assemblyMap(pieces) {
  const joins = new Map();
  pieces.forEach((pc, i) => { const s = new Set(pc.mesh.G); for (const g of s) if (g > 0) { let l = joins.get(g); if (!l) { l = []; joins.set(g, l); } l.push(i); } });
  return joins;
}

// ---------------------------------------------------------------- print orientation
// Rotate so the biggest flat cut face sits on the bed (z=0), centred on x/y = 0.
function rotationTo(from, to) { // 3x3 row-major rotating unit vector 'from' onto 'to'
  const v = cross(from, to), c = dot(from, to);
  if (c < -0.999999) { const ax = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const k = norm(cross(from, ax)); return [2 * k[0] * k[0] - 1, 2 * k[0] * k[1], 2 * k[0] * k[2], 2 * k[1] * k[0], 2 * k[1] * k[1] - 1, 2 * k[1] * k[2], 2 * k[2] * k[0], 2 * k[2] * k[1], 2 * k[2] * k[2] - 1]; }
  const f = 1 / (1 + c);
  return [1 - f * (v[1] * v[1] + v[2] * v[2]), -v[2] + f * v[0] * v[1], v[1] + f * v[0] * v[2],
    v[2] + f * v[0] * v[1], 1 - f * (v[0] * v[0] + v[2] * v[2]), -v[0] + f * v[1] * v[2],
    -v[1] + f * v[0] * v[2], v[0] + f * v[1] * v[2], 1 - f * (v[0] * v[0] + v[1] * v[1])];
}
function layFlat(m, avoidCuts) {
  const faces = new Map();
  for (let t = 0; t < m.T.length / 3; t++) {
    const g = m.G[t]; if (g <= 0) continue;
    const v = [0, 1, 2].map(k => [m.P[m.T[t * 3 + k] * 3], m.P[m.T[t * 3 + k] * 3 + 1], m.P[m.T[t * 3 + k] * 3 + 2]]);
    const c = cross(sub(v[1], v[0]), sub(v[2], v[0])); const a = len(c) / 2; if (!a) continue;
    const nn = norm(c); const key = g + ':' + nn.map(x => Math.round(x * 50)).join(',');
    let f = faces.get(key); if (!f) { f = { a: 0, n: nn, g }; faces.set(key, f); } f.a += a;
  }
  let best = null; for (const f of faces.values()) if ((!avoidCuts || !avoidCuts.has(f.g)) && (!best || f.a > best.a)) best = f;
  let out = m;
  if (best) out = rotateMesh(m, rotationTo(best.n, [0, 0, -1]));
  const b = bbox(out);
  return translateMesh(out, [-b.center[0], -b.center[1], -b.min[2]]);
}

// ---------------------------------------------------------------- simple primitives (dowel pins)
function cylinderMesh(r, h, segs = 32) {
  const P = [], T = [];
  for (let i = 0; i < segs; i++) { const a = 2 * Math.PI * i / segs; P.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h); }
  const cb = P.length / 3; P.push(0, 0, 0); const ct = P.length / 3; P.push(0, 0, h);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs, a0 = i * 2, a1 = i * 2 + 1, b0 = j * 2, b1 = j * 2 + 1;
    T.push(a0, b0, b1, a0, b1, a1, cb, b0, a0, ct, a1, b1);
  }
  return orientMesh(makeMesh(P, T));
}
// slightly chamfered pin, easier to insert
function dowelMesh(dia, length) { return cylinderMesh(dia / 2, length, 36); }

// ---------------------------------------------------------------- file parsing
function parseSTL(buf) {
  const dv = new DataView(buf);
  const isBinary = () => {
    if (buf.byteLength < 84) return false;
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) return true;
    const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(256, buf.byteLength)));
    return !/^\s*solid[\s\S]*facet/i.test(head);
  };
  if (isBinary()) {
    const n = dv.getUint32(80, true); const soup = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) soup[i * 9 + k] = dv.getFloat32(o + k * 4, true); }
    return weldSoup(soup);
  }
  const txt = new TextDecoder().decode(new Uint8Array(buf));
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g; const v = []; let mm;
  while ((mm = re.exec(txt))) v.push(+mm[1], +mm[2], +mm[3]);
  return weldSoup(Float32Array.from(v.slice(0, Math.floor(v.length / 9) * 9)));
}
function parseOBJ(buf) {
  const txt = new TextDecoder().decode(new Uint8Array(buf)); const V = [], soup = [];
  for (const line of txt.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') V.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'f') {
      const idx = p.slice(1).map(s => { const i = parseInt(s.split('/')[0], 10); return i < 0 ? V.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) soup.push(...V[i]);
    }
  }
  return weldSoup(Float32Array.from(soup));
}
// GLB: returns [{name, mesh}] one per glTF mesh primitive group (node), converted Y-up -> Z-up
function parseGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB file');
  let off = 12, json = null, bin = null;
  while (off < buf.byteLength) {
    const l = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, l)));
    else if (type === 0x004E4942) bin = buf.slice(off + 8, off + 8 + l);
    off += 8 + l;
  }
  const acc = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const Ctor = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const stride = bv.byteStride || comps * Ctor.BYTES_PER_ELEMENT; const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float64Array(a.count * comps); const v = new DataView(bin);
    const rd = { 5126: o => v.getFloat32(o, true), 5125: o => v.getUint32(o, true), 5123: o => v.getUint16(o, true), 5121: o => v.getUint8(o) }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < comps; c++) out[k * comps + c] = rd(base + k * stride + c * Ctor.BYTES_PER_ELEMENT);
    return out;
  };
  const matMul = (A, B) => { const C = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) C[j * 4 + i] += A[k * 4 + i] * B[j * 4 + k]; return C; };
  const nodeMat = nd => {
    if (nd.matrix) return nd.matrix.slice();
    const t = nd.translation || [0, 0, 0], r = nd.rotation || [0, 0, 0, 1], s = nd.scale || [1, 1, 1];
    const [x, y, z, w] = r;
    return [(1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
      (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
      (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, t[0], t[1], t[2], 1];
  };
  const parts = [];
  const visit = (ni, parent) => {
    const nd = json.nodes[ni]; const M = matMul(parent, nodeMat(nd));
    if (nd.mesh !== undefined) {
      const me = json.meshes[nd.mesh]; const soup = [];
      for (const pr of me.primitives) {
        if (pr.mode !== undefined && pr.mode !== 4) continue;
        const pos = acc(pr.attributes.POSITION); const ind = pr.indices !== undefined ? acc(pr.indices) : null;
        const cnt = ind ? ind.length : pos.length / 3;
        for (let k = 0; k < cnt; k++) {
          const i = ind ? ind[k] : k; const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14];
          soup.push(X, -Z, Y); // Y-up -> Z-up
        }
      }
      if (soup.length) parts.push({ name: nd.name || me.name || 'part ' + (parts.length + 1), mesh: weldSoup(Float32Array.from(soup)) });
    }
    for (const c of nd.children || []) visit(c, M);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes ? json.scenes[json.scene || 0] : { nodes: json.nodes.map((_, i) => i) };
  for (const ni of scene.nodes) visit(ni, I);
  return parts;
}

// ---------------------------------------------------------------- exports
function stlBinary(m, name) {
  const nt = m.T.length / 3; const buf = new ArrayBuffer(84 + nt * 50); const dv = new DataView(buf);
  const hdr = ('Seamline ' + (name || '')).slice(0, 79); for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i) & 127);
  dv.setUint32(80, nt, true);
  for (let t = 0; t < nt; t++) {
    const o = 84 + t * 50; const v = [0, 1, 2].map(k => [m.P[m.T[t * 3 + k] * 3], m.P[m.T[t * 3 + k] * 3 + 1], m.P[m.T[t * 3 + k] * 3 + 2]]);
    const nn = norm(cross(sub(v[1], v[0]), sub(v[2], v[0])));
    for (let a = 0; a < 3; a++) dv.setFloat32(o + a * 4, nn[a], true);
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) dv.setFloat32(o + 12 + k * 12 + a * 4, v[k][a], true);
  }
  return new Uint8Array(buf);
}
function threeMF(parts) { // parts: [{name, mesh, color:'#rrggbb'}]
  const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let objs = '', items = '', mats = '';
  parts.forEach((p, i) => { mats += `<base name="${esc(p.name)}" displaycolor="${(p.color || '#cccccc').toUpperCase()}FF"/>`; });
  parts.forEach((p, i) => {
    const m = p.mesh; let vs = '', ts = '';
    for (let k = 0; k < m.P.length; k += 3) vs += `<vertex x="${m.P[k].toFixed(4)}" y="${m.P[k + 1].toFixed(4)}" z="${m.P[k + 2].toFixed(4)}"/>`;
    for (let k = 0; k < m.T.length; k += 3) ts += `<triangle v1="${m.T[k]}" v2="${m.T[k + 1]}" v3="${m.T[k + 2]}"/>`;
    objs += `<object id="${i + 2}" name="${esc(p.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${vs}</vertices><triangles>${ts}</triangles></mesh></object>`;
    items += `<item objectid="${i + 2}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><basematerials id="1">${mats}</basematerials>${objs}</resources><build>${items}</build></model>`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const enc = new TextEncoder();
  return zipStore([{ name: '[Content_Types].xml', data: enc.encode(ct) }, { name: '_rels/.rels', data: enc.encode(rels) }, { name: '3D/3dmodel.model', data: enc.encode(model) }]);
}
let CRC_T = null;
function crc32(d) {
  if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) { // [{name, data:Uint8Array}] -> Uint8Array (no compression)
  const enc = new TextEncoder(); const chunks = []; const central = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + sz;
  }
  let cl = 0; for (const c of central) cl += c.length;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cl, true); e.setUint32(16, off, true);
  const all = chunks.concat(central, [new Uint8Array(e.buffer)]);
  let total = 0; for (const a of all) total += a.length;
  const out = new Uint8Array(total); let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

// render buffers: flat-shaded, non-indexed; per-triangle flag for cut faces
function renderData(m) {
  const nt = m.T.length / 3; const pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9), cut = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const v = [0, 1, 2].map(k => [m.P[m.T[t * 3 + k] * 3], m.P[m.T[t * 3 + k] * 3 + 1], m.P[m.T[t * 3 + k] * 3 + 2]]);
    const nn = norm(cross(sub(v[1], v[0]), sub(v[2], v[0])));
    for (let k = 0; k < 3; k++) { pos.set(v[k], t * 9 + k * 3); nrm.set(nn, t * 9 + k * 3); cut[t * 3 + k] = m.G[t] !== 0 ? 1 : 0; }
  }
  return { pos, nrm, cut };
}

const api = {
  makeMesh, bbox, volume, weldSoup, weldIndexed, subMesh, translateMesh, scaleMesh, rotateMesh, mergeMeshes, components, edgeStats, orientMesh, fillHoles,
  basisFor, fitPlane, earcut, loopArea, pointInLoops, distToLoops, poleOfInaccessibility, sectionLoops, groupIslands, sectionAreas,
  cutMesh, fitsBed, layFlat, rotationTo, voxelUnion, taubin, findBodyJoints, solidGrid, chooseCut, autoSplit, proposeGuidedCuts, applyGuidedCuts, assemblyMap, cylinderMesh, dowelMesh,
  parseSTL, parseOBJ, parseGLB, stlBinary, threeMF, zipStore, crc32, renderData, textDots,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Seam = api;
})(typeof self !== 'undefined' ? self : this);
