import 'dart:math' as math;
import 'dart:ui';

/// A closed polygon with every corner rounded by up to [radius].
Path roundedPolygon(List<Offset> pts, double radius) {
  final path = Path();
  final n = pts.length;
  for (var i = 0; i < n; i++) {
    final prev = pts[(i - 1 + n) % n];
    final cur = pts[i];
    final next = pts[(i + 1) % n];
    final inDir = cur - prev;
    final outDir = next - cur;
    final r = math.min(radius, math.min(inDir.distance, outDir.distance) / 2);
    final a = cur - inDir / inDir.distance * r;
    final b = cur + outDir / outDir.distance * r;
    if (i == 0) {
      path.moveTo(a.dx, a.dy);
    } else {
      path.lineTo(a.dx, a.dy);
    }
    path.quadraticBezierTo(cur.dx, cur.dy, b.dx, b.dy);
  }
  path.close();
  return path;
}

/// The reference shard: horizontal top and bottom, sides leaning "/".
/// [slant] is the horizontal run of a side per unit of height.
Path shardPath(Offset c, double w, double h, double slant, {double? radius}) {
  final run = h * slant;
  final r = radius ?? math.min(36.0, math.min(w, h) * 0.2);
  return roundedPolygon([
    Offset(c.dx - w / 2 + run / 2, c.dy - h / 2),
    Offset(c.dx + w / 2 + run / 2, c.dy - h / 2),
    Offset(c.dx + w / 2 - run / 2, c.dy + h / 2),
    Offset(c.dx - w / 2 - run / 2, c.dy + h / 2),
  ], r);
}

double lerpD(double a, double b, double t) => a + (b - a) * t;
