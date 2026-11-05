// synthetic humanoid (A-pose), 1.8 m, Z up, facing -Y: union of capsules/ellipsoids -> one STL-like mesh
const S = require('../engine.js'), sh = require('./shapes.js');
function capsule(a, b, r) { // revolve along z then rotate to a->b
  const L = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]); const prof = [];
  for (let i = 0; i <= 8; i++) { const t = Math.PI / 2 * i / 8; prof.push([i === 0 ? 0 : r * Math.sin(t), -r * Math.cos(t)]); }
  for (let i = 8; i >= 0; i--) { const t = Math.PI / 2 * i / 8; prof.push([i === 0 ? 0 : r * Math.sin(t), L + r * Math.cos(t)]); }
  let m = sh.revolve(prof.map(([x, z], i) => [x, z + (i === 0 ? 0 : 0)]), 24);
  const d = [(b[0]-a[0])/L, (b[1]-a[1])/L, (b[2]-a[2])/L];
  m = S.rotateMesh(m, S.rotationTo([0, 0, 1], d));
  return S.translateMesh(m, a);
}
function ell(c, rx, ry, rz) { let m = sh.revolve(sh.sphereProfile(1, 0, 24), 32); const P = new Float64Array(m.P); for (let i = 0; i < P.length; i += 3) { P[i] = P[i] * rx + c[0]; P[i+1] = P[i+1] * ry + c[1]; P[i+2] = P[i+2] * rz + c[2]; } return { P, T: m.T, G: m.G }; }
function human(armDown = 0.6) {
  const parts = {
    torso: ell([0, 0, 1250], 170, 110, 290),
    pelvis: ell([0, 0, 980], 165, 105, 130),
    head: ell([0, -10, 1690], 85, 100, 115),
    neck: capsule([0, 0, 1500], [0, 0, 1590], 50),
  };
  for (const sgn of [1, -1]) {
    const sh0 = [sgn * 120, 0, 1440], el = [sgn * (150 + 280 * Math.cos(armDown)), 0, 1440 - 280 * Math.sin(armDown)], wr = [sgn * (150 + 540 * Math.cos(armDown)), -20, 1440 - 540 * Math.sin(armDown)];
    parts[(sgn > 0 ? 'left' : 'right') + ' upper arm'] = capsule(sh0, el, 48);
    parts[(sgn > 0 ? 'left' : 'right') + ' forearm'] = capsule(el, wr, 38);
    parts[(sgn > 0 ? 'left' : 'right') + ' hand'] = ell([wr[0] + sgn * 50 * Math.cos(armDown), -20, wr[2] - 60 * Math.sin(armDown)], 30, 45, 70);
    parts[(sgn > 0 ? 'left' : 'right') + ' thigh'] = capsule([sgn * 95, 0, 930], [sgn * 105, 0, 520], 75);
    parts[(sgn > 0 ? 'left' : 'right') + ' shin'] = capsule([sgn * 105, 0, 520], [sgn * 110, 10, 90], 55);
    parts[(sgn > 0 ? 'left' : 'right') + ' foot'] = ell([sgn * 110, -60, 45], 50, 120, 45);
  }
  return parts;
}
module.exports = { human, capsule, ell };
if (require.main === module) {
  const parts = human(); const t0 = Date.now();
  const u = S.voxelUnion(Object.values(parts), 200, 4).mesh; console.log('humanoid tris', u.T.length / 3, 'tight', S.edgeStats(u).watertight, 'shells', S.components(u).length, Date.now() - t0, 'ms');
  require('fs').writeFileSync(process.argv[2] || '/tmp/claude-0/-home-claude/1fdf4fbd-6774-58a3-8269-9875f85121c3/scratchpad/human.stl', S.stlBinary(u));
  for (const sec of [false, true]) {
    const t1 = Date.now(); const r = S.findBodyJoints(u, { res: 96, secondary: sec });
    console.log(sec ? 'with elbows/knees' : 'main joints', Date.now() - t1, 'ms');
    for (const c of r.cuts) console.log('  ', (c.a + ' / ' + c.b).padEnd(28), 'at', c.c.map(v => v.toFixed(0)).join(','), 'n', c.n.map(v => v.toFixed(2)).join(','));
    const g = S.applyGuidedCuts([{ mesh: u }], r.cuts, { connector: { type: 'dowel', diameter: 0, depth: 0, tolerance: 0.2 }, label: true });
    console.log('   pieces', g.pieces.length, 'made', g.reports.length, '/', r.cuts.length, 'tight', g.pieces.every(p => S.edgeStats(p.mesh).watertight), g.notes);
  }
}
// stylised figure: head thicker than the torso
module.exports.chibi = () => { const p = module.exports.human(0.5); p.head = module.exports.ell([0, -10, 1720], 210, 190, 200); p.neck = module.exports.capsule([0, 0, 1480], [0, 0, 1560], 60); return p; };
