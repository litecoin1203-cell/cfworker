function makeNetGlobe(maskB64) {
  var bin = atob(maskB64), land = new Uint8Array(720 * 360);
  for (var i = 0; i < land.length; i++) land[i] = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  var isLand = function (lat, lon) {
    var r = Math.floor((90 - lat) * 2), c = Math.floor((lon + 180) * 2);
    if (r < 0) r = 0; if (r > 359) r = 359; c = ((c % 720) + 720) % 720;
    return land[r * 720 + c];
  };
  var D = Math.PI / 180;
  var toV = function (lat, lon, h) { var a = lat * D, b = lon * D; return [Math.cos(a) * Math.sin(b) * h, Math.sin(a) * h, Math.cos(a) * Math.cos(b) * h]; };
  // land dots, with a pseudo-random "city light" brightness
  var pts = [], STEP = 0.5;
  for (var lat = -84; lat <= 84; lat += STEP) {
    var n = Math.max(1, Math.round(360 * Math.cos(lat * D) / STEP));
    for (var k = 0; k < n; k++) {
      var lon = -180 + (k + 0.5) * 360 / n;
      if (!isLand(lat, lon)) continue;
      var v = toV(lat, lon, 1);
      var h = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453; h = h - Math.floor(h);
      pts.push(v[0], v[1], v[2], h);
    }
  }
  var P = new Float32Array(pts);
  // network nodes (real cities) and edges
  var C = [[52.37,4.9],[51.5,-0.1],[48.86,2.35],[52.52,13.4],[40.4,-3.7],[41.9,12.5],[59.3,18.1],[55.75,37.6],[41,28.97],[30,31.2],[6.5,3.4],[-1.3,36.8],[-26.2,28],[25.2,55.3],[35.7,51.4],[36.3,59.6],[19,72.8],[28.6,77.2],[1.35,103.8],[22.3,114.2],[35.7,139.7],[37.5,127],[39.9,116.4],[-33.9,151.2],[-31.95,115.86],[40.7,-74],[43.65,-79.4],[41.9,-87.6],[34,-118.2],[49.3,-123.1],[19.4,-99.1],[25.8,-80.2],[4.7,-74.1],[-12,-77],[-23.5,-46.6],[-34.6,-58.4],[64.1,-21.9],[50.1,8.7],[52.2,21],[60.2,24.9],[24.7,46.7],[43.2,76.9],[55,82.9],[14.6,121],[-6.2,106.8],[33.7,-7.6],[45.5,-73.6],[61.2,-149.9],[-37.8,145]];
  var nodes = C.map(function (c, i) { var r = Math.sin(i * 91.7) * 1000; r = r - Math.floor(r); return { lat: c[0], lon: c[1], h: 1.004 + (i % 2 === 0 ? 0.04 + r * 0.2 : 0), v: null }; });
  for (var xi = 0; xi < 70; xi++) {
    var pi = (Math.floor((Math.sin(xi * 17.17) * 0.5 + 0.5) * (P.length / 4))) * 4;
    var px = P[pi], py = P[pi + 1], pz = P[pi + 2];
    var rr2 = Math.sin(xi * 5.3) * 1000; rr2 -= Math.floor(rr2);
    nodes.push({ lat: Math.asin(py) / D, lon: Math.atan2(px, pz) / D, h: 1.004 + (xi % 3 === 0 ? 0.03 + rr2 * 0.15 : 0), v: null, extra: true });
  }
  nodes.forEach(function (n) { n.v = toV(n.lat, n.lon, n.h); });
  var ang = function (a, b) { var d = a.v[0] * b.v[0] + a.v[1] * b.v[1] + a.v[2] * b.v[2]; return Math.acos(Math.max(-1, Math.min(1, d / (a.h * b.h)))); };
  var E = [], seen = {};
  nodes.forEach(function (a, i) {
    var near = nodes.map(function (b, j) { return [j, i === j ? 9 : ang(a, b)]; }).sort(function (x, y) { return x[1] - y[1]; });
    for (var q = 0; q < 4; q++) {
      var j = near[q][0], key = Math.min(i, j) + '-' + Math.max(i, j);
      if (near[q][1] < 0.6 && !seen[key]) { seen[key] = 1; E.push([i, j]); }
    }
  });
  // great-circle samples for each edge, lifted toward the middle
  var EP = E.map(function (e) {
    var a = nodes[e[0]], b = nodes[e[1]], om = ang(a, b), s = [], N = 14;
    for (var t = 0; t <= N; t++) {
      var f = t / N, sa = Math.sin((1 - f) * om) / Math.sin(om), sb = Math.sin(f * om) / Math.sin(om);
      var x = sa * a.v[0] / a.h + sb * b.v[0] / b.h, y = sa * a.v[1] / a.h + sb * b.v[1] / b.h, z = sa * a.v[2] / a.h + sb * b.v[2] / b.h;
      var hh = a.h + (b.h - a.h) * f + Math.sin(f * Math.PI) * om * 0.05;
      s.push(x * hh, y * hh, z * hh);
    }
    return s;
  });
  // bokeh + specks in screen space (fractions of size)
  var bok = [];
  for (var bI = 0; bI < 70; bI++) {
    var r1 = Math.sin(bI * 12.3) * 9999; r1 -= Math.floor(r1);
    var r2 = Math.sin(bI * 7.7 + 3) * 9999; r2 -= Math.floor(r2);
    var r3 = Math.sin(bI * 3.1 + 9) * 9999; r3 -= Math.floor(r3);
    bok.push({ x: r1, y: 0.4 + r2 * 0.62, r: bI % 3 === 0 ? 3 + r3 * 7 : 0.7 + r3 * 1.4, a: bI % 3 === 0 ? 0.1 + r3 * 0.25 : 0.3 + r3 * 0.6, sp: 0.2 + r3, ph: r1 * 6.28 });
  }
  var proj = function (v, o) {
    var x = v[0] * o.cl + v[2] * o.sl, z1 = -v[0] * o.sl + v[2] * o.cl;
    var y = v[1] * o.ca - z1 * o.sa, z = v[1] * o.sa + z1 * o.ca;
    return [o.cx + x * o.R, o.cy - y * o.R, z];
  };
  return {
    nodes: nodes,
    cityIndex: function (lat, lon) { var best = 0, bd = 9; nodes.forEach(function (n, i) { var d = Math.abs(n.lat - lat) + Math.abs(n.lon - lon); if (d < bd) { bd = d; best = i; } }); return best; },
    project: function (lat, lon, o) { var lo = -o.lon * D, la = o.lat * D; var oo = { cl: Math.cos(lo), sl: Math.sin(lo), ca: Math.cos(la), sa: Math.sin(la), cx: o.cx, cy: o.cy, R: o.R }; return proj(toV(lat, lon, 1), oo); },
    draw: function (ctx, W, H, o) {
      // o: cx, cy, R (device px), lon, lat (view centre), t (seconds), power (0..1 network brightness), target (node index), packets (0..1), dpr
      var dpr = o.dpr || 1, lo = -o.lon * D, la = o.lat * D;
      var q = { cl: Math.cos(lo), sl: Math.sin(lo), ca: Math.cos(la), sa: Math.sin(la), cx: o.cx, cy: o.cy, R: o.R };
      ctx.clearRect(0, 0, W, H);
      var cx = o.cx, cy = o.cy, R = o.R, pw = o.power;
      var band = ctx.createLinearGradient(0, o.bandY, 0, cy - R * 0.9);
      band.addColorStop(0, 'rgba(10,24,42,0)'); band.addColorStop(0.08, 'rgba(10,26,46,0.85)'); band.addColorStop(1, 'rgba(18,44,74,0.9)');
      ctx.fillStyle = band; ctx.fillRect(0, o.bandY, W, cy - R * 0.9 - o.bandY);
      // haze above the horizon
      var hz = ctx.createRadialGradient(cx, cy - R, R * 0.05, cx, cy - R, R * 0.95);
      hz.addColorStop(0, 'rgba(44,88,140,' + (0.42 + 0.18 * pw) + ')'); hz.addColorStop(0.45, 'rgba(22,52,92,' + (0.28 + 0.1 * pw) + ')'); hz.addColorStop(1, 'rgba(6,16,32,0)');
      ctx.save(); ctx.translate(cx, cy - R); ctx.scale(1.25, 0.62); ctx.translate(-cx, -(cy - R));
      ctx.fillStyle = hz; ctx.beginPath(); ctx.arc(cx, cy - R, R * 0.95, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      // sphere body
      var sg = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R);
      sg.addColorStop(0, '#0a1c30'); sg.addColorStop(0.7, '#0f2a45'); sg.addColorStop(0.93, '#1a4166'); sg.addColorStop(1, '#2f5f8a');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      // land dots
      var ds = 1.0 * dpr;
      for (var i = 0; i < P.length; i += 4) {
        var x = P[i] * q.cl + P[i + 2] * q.sl, z1 = -P[i] * q.sl + P[i + 2] * q.cl;
        var y = P[i + 1] * q.ca - z1 * q.sa, z = P[i + 1] * q.sa + z1 * q.ca;
        if (z <= 0.03) continue;
        var sx = cx + x * R, sy = cy - y * R;
        if (sx < -2 || sx > W + 2 || sy < -2 || sy > H + 2) continue;
        var hv = P[i + 3], lim = 1 - z;
        var a = (0.3 + 0.45 * hv * hv + (hv > 0.9 ? 0.5 : 0)) * (0.55 + 0.45 * z) + lim * lim * 0.6;
        ctx.fillStyle = hv > 0.9 ? 'rgba(235,245,255,' + Math.min(1, a) + ')' : 'rgba(170,205,240,' + Math.min(1, a) + ')';
        ctx.fillRect(sx - ds / 2, sy - ds / 2, ds, ds);
      }
      // network edges
      var tgt = o.target;
      for (var e = 0; e < EP.length; e++) {
        var s = EP[e], hot = E[e][0] === tgt || E[e][1] === tgt;
        ctx.beginPath(); var started = false, vis = 0;
        for (var k = 0; k < s.length; k += 3) {
          var p = proj([s[k], s[k + 1], s[k + 2]], q);
          if (p[2] < -0.05) { started = false; continue; }
          vis++;
          if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
        }
        if (!vis) continue;
        ctx.strokeStyle = hot ? 'rgba(170,215,255,' + (0.35 + 0.45 * pw) + ')' : 'rgba(150,195,240,' + (0.16 + 0.22 * pw) + ')';
        ctx.lineWidth = (hot ? 1.2 : 0.8) * dpr; ctx.stroke();
      }
      // packets along edges into the target node
      if (o.packets > 0.01) {
        for (var e2 = 0; e2 < EP.length; e2++) {
          var s2 = EP[e2]; var rev = E[e2][0] === tgt; var into = rev || E[e2][1] === tgt;
          var ph = ((o.t * (into ? 0.55 : 0.28) + e2 * 0.137) % 1);
          if (!into && e2 % 3) continue;
          var f2 = rev ? 1 - ph : ph, idx = Math.min(s2.length / 3 - 2, Math.floor(f2 * (s2.length / 3 - 1))), fr = f2 * (s2.length / 3 - 1) - idx;
          var A = [s2[idx * 3], s2[idx * 3 + 1], s2[idx * 3 + 2]], B = [s2[idx * 3 + 3], s2[idx * 3 + 4], s2[idx * 3 + 5]];
          var pp = proj([A[0] + (B[0] - A[0]) * fr, A[1] + (B[1] - A[1]) * fr, A[2] + (B[2] - A[2]) * fr], q);
          if (pp[2] < 0) continue;
          var gr = ctx.createRadialGradient(pp[0], pp[1], 0, pp[0], pp[1], 5 * dpr);
          gr.addColorStop(0, 'rgba(255,255,255,' + o.packets + ')'); gr.addColorStop(1, 'rgba(140,200,255,0)');
          ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(pp[0], pp[1], 5 * dpr, 0, Math.PI * 2); ctx.fill();
        }
      }
      // nodes
      for (var nI = 0; nI < nodes.length; nI++) {
        var np = proj(nodes[nI].v, q); if (np[2] < 0.02) continue;
        var big = nodes[nI].h > 1.01, rr = (big ? 2.3 : 1.5) * dpr * (0.6 + 0.4 * np[2]);
        var g2 = ctx.createRadialGradient(np[0], np[1], 0, np[0], np[1], rr * 4.5);
        g2.addColorStop(0, 'rgba(255,255,255,' + (0.75 + 0.25 * pw) + ')'); g2.addColorStop(0.25, 'rgba(200,230,255,' + (0.4 * (0.5 + pw)) + ')'); g2.addColorStop(1, 'rgba(120,180,255,0)');
        ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(np[0], np[1], rr * 4.5, 0, Math.PI * 2); ctx.fill();
      }
      // horizon rim light
      var rimg = ctx.createLinearGradient(0, cy - R, 0, cy - R * 0.7);
      rimg.addColorStop(0, 'rgba(150,200,245,0.0)');
      ctx.strokeStyle = 'rgba(110,165,225,' + (0.18 + 0.12 * pw) + ')'; ctx.lineWidth = 14 * dpr; ctx.filter = 'blur(' + (8 * dpr) + 'px)';
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI * 1.0, Math.PI * 2.0); ctx.stroke(); ctx.filter = 'none';
      ctx.strokeStyle = 'rgba(150,200,245,' + (0.3 + 0.15 * pw) + ')'; ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath(); ctx.arc(cx, cy, R - 1 * dpr, Math.PI * 1.0, Math.PI * 2.0); ctx.stroke();
      ctx.restore();
      // bokeh and specks
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (var bI = 0; bI < bok.length; bI++) {
        var b = bok[bI];
        var bx = b.x * W + Math.sin(o.t * 0.15 * b.sp + b.ph) * 6 * dpr, by = b.y * H * 0.9 + Math.cos(o.t * 0.11 * b.sp + b.ph) * 5 * dpr;
        var br = b.r * dpr;
        if (b.r > 2.5) {
          var g3 = ctx.createRadialGradient(bx, by, 0, bx, by, br);
          g3.addColorStop(0, 'rgba(120,170,225,' + b.a + ')'); g3.addColorStop(0.7, 'rgba(110,160,220,' + b.a * 0.7 + ')'); g3.addColorStop(1, 'rgba(110,160,220,0)');
          ctx.fillStyle = g3;
        } else {
          ctx.fillStyle = 'rgba(225,238,255,' + b.a * (0.6 + 0.4 * Math.sin(o.t * 1.3 * b.sp + b.ph)) + ')';
        }
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  };
}
