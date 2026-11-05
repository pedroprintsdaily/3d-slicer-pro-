// Test shapes (watertight) for engine tests
const S = require('../engine.js');

// surface of revolution around Z: profile = [[r,z],...] from bottom pole to top pole (r=0 at ends)
function revolve(profile, segs = 48) {
  const P = [], T = [];
  const rings = [];
  for (const [r, z] of profile) {
    if (r === 0) { rings.push([P.length / 3]); P.push(0, 0, z); continue; }
    const ring = [];
    for (let i = 0; i < segs; i++) { const a = 2 * Math.PI * i / segs; ring.push(P.length / 3); P.push(r * Math.cos(a), r * Math.sin(a), z); }
    rings.push(ring);
  }
  for (let k = 0; k + 1 < rings.length; k++) {
    const A = rings[k], B = rings[k + 1];
    if (A.length === 1) { for (let i = 0; i < segs; i++) T.push(A[0], B[(i + 1) % segs], B[i]); }
    else if (B.length === 1) { for (let i = 0; i < segs; i++) T.push(A[i], A[(i + 1) % segs], B[0]); }
    else for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; T.push(A[i], A[j], B[j], A[i], B[j], B[i]); }
  }
  return S.orientMesh(S.makeMesh(P, T));
}
// closed ring profile (torus-like / hollow shell): profile is closed polygon in (r,z), all r>0
function revolveClosed(profile, segs = 48) {
  const P = [], T = [], n = profile.length;
  for (const [r, z] of profile) for (let i = 0; i < segs; i++) { const a = 2 * Math.PI * i / segs; P.push(r * Math.cos(a), r * Math.sin(a), z); }
  for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; T.push(k * segs + i, k * segs + j, k2 * segs + j, k * segs + i, k2 * segs + j, k2 * segs + i); } }
  return S.orientMesh(S.makeMesh(P, T));
}
// extrude 2D polygon (CCW) along Z
function extrude(poly, h) {
  const n = poly.length, P = [], T = [];
  for (const [x, y] of poly) P.push(x, y, 0); for (const [x, y] of poly) P.push(x, y, h);
  const flat = poly.flat(); const tri = S.earcut(flat, null);
  for (let k = 0; k < tri.length; k += 3) { T.push(tri[k], tri[k + 2], tri[k + 1]); T.push(n + tri[k], n + tri[k + 1], n + tri[k + 2]); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; T.push(i, j, n + j, i, n + j, n + i); }
  return S.orientMesh(S.makeMesh(P, T));
}
const sphereProfile = (R, z0, steps = 24) => { const o = []; for (let i = 0; i <= steps; i++) { const a = Math.PI * i / steps; o.push([i === 0 || i === steps ? 0 : R * Math.sin(a), z0 - R * Math.cos(a)]); } return o; };
// dumbbell / "body": big blob, narrow neck at z=narrowZ, head
function figure(H = 600) {
  const prof = [];
  const steps = 80;
  for (let i = 0; i <= steps; i++) {
    const z = H * i / steps;
    let r;
    const t = z / H;
    if (i === 0 || i === steps) r = 0;
    else {
      // torso 0..0.7 wide, neck at 0.72 narrow, head 0.75..1
      const torso = 0.22 * H * Math.sqrt(Math.max(0, 1 - ((t - 0.35) / 0.37) ** 2));
      const head = 0.12 * H * Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2));
      r = Math.max(torso, head, 0.045 * H * (t > 0.6 && t < 0.8 ? 1 : 0));
      r = Math.max(r, 2);
    }
    prof.push([r, z]);
  }
  return revolve(prof, 64);
}
function letterH(w = 300, h = 400, t = 80, depth = 60) {
  const poly = [[0, 0], [t, 0], [t, h * 0.45], [w - t, h * 0.45], [w - t, 0], [w, 0], [w, h], [w - t, h], [w - t, h * 0.55], [t, h * 0.55], [t, h], [0, h]];
  return extrude(poly, depth);
}
module.exports = { revolve, revolveClosed, extrude, sphereProfile, figure, letterH };
