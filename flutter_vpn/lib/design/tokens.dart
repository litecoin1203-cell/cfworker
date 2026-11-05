import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// One full set of colour roles. Every Pleat screen reads its colours from
/// the active palette through [PColors], so switching Day and Night is a
/// matter of swapping this object and rebuilding.
///
/// The role names are kept from the first palette (navy, blue, ice, mist)
/// so they read as roles, not hues: navy = the deep plane, blue = the
/// accent fill, ice and mist = the two light tints of the accent.
class PPalette {
  const PPalette({
    required this.name,
    required this.brightness,
    required this.ground,
    required this.surface,
    required this.field,
    required this.navy,
    required this.blue,
    required this.ice,
    required this.mist,
    required this.ink,
    required this.muted,
    required this.pressed,
    required this.accentInk,
    required this.onAccent,
    required this.onDeep,
    this.safe = const Color(0xFF1F9D55),
    this.alert = const Color(0xFFE5484D),
    this.hue,
  });

  /// The accent's hue, when the palette is built from one colour. Painted
  /// art (city skies, skylines) is turned to it so it sits in the palette.
  final double? hue;

  /// [c] moved onto this palette's hue; the sky palette keeps art as drawn.
  Color tone(Color c) {
    if (hue == null) return c;
    final h = HSLColor.fromColor(c);
    final l = isDark ? h.lightness * 0.82 : h.lightness;
    return h
        .withHue(hue!)
        .withSaturation((h.saturation * 0.62).clamp(0.0, 1.0))
        .withLightness(l.clamp(0.0, 1.0))
        .toColor()
        .withValues(alpha: c.a);
  }

  final String name;
  final Brightness brightness;
  final Color ground, surface, field;
  final Color navy, blue, ice, mist;
  final Color ink, muted, pressed;

  /// The accent when it is text or an icon on a surface; it keeps 4.5:1.
  final Color accentInk;

  /// Text and icons on an accent fill, and on the deep plane.
  final Color onAccent, onDeep;
  final Color safe, alert;

  bool get isDark => brightness == Brightness.dark;

  /// The original studio-blue palette (Pleat 1.0 to 1.2.13).
  static const sky = PPalette(
    name: 'sky',
    brightness: Brightness.light,
    ground: Color(0xFFE7F1FA),
    surface: Color(0xFFFFFFFF),
    field: Color(0xFFF2F6FB),
    navy: Color(0xFF14284B),
    blue: Color(0xFF2F89F5),
    ice: Color(0xFFA9D4F5),
    mist: Color(0xFFD7E9FA),
    ink: Color(0xFF16181D),
    muted: Color(0xFF8B93A7),
    pressed: Color(0xFF1E74DB),
    accentInk: Color(0xFF1E74DB),
    onAccent: Color(0xFFFFFFFF),
    onDeep: Color(0xFFFFFFFF),
  );

  /// Day: white paper, gold accent. Every tint is the gold mixed into
  /// white; every shade is the gold taken toward black. [deepGold] picks
  /// whether the big planes are a dark bronze (false) or the gold itself.
  factory PPalette.day(
    Color gold, {
    Color white = const Color(0xFFFFFFFF),
    String name = 'day',
    double groundTint = 0.09,
    bool deepGold = false,
  }) {
    Color tint(double t) => Color.lerp(white, gold, t)!;
    Color shade(double t) => Color.lerp(gold, const Color(0xFF000000), t)!;
    return PPalette(
      name: name,
      hue: HSLColor.fromColor(gold).hue,
      brightness: Brightness.light,
      ground: tint(groundTint),
      surface: white,
      field: tint(0.07),
      navy: deepGold ? gold : shade(0.74),
      blue: deepGold ? shade(0.38) : gold,
      ice: tint(0.42),
      mist: tint(0.17),
      ink: shade(0.86),
      muted: Color.lerp(shade(0.55), white, 0.22)!,
      pressed: shade(deepGold ? 0.5 : 0.14),
      accentInk: shade(0.45),
      onAccent: deepGold ? white : shade(0.86),
      onDeep: deepGold ? shade(0.86) : white,
    );
  }

  /// Night: the same gold and white on a ground made from the gold taken
  /// almost to black. Tints become dark golds; text is the warm white.
  factory PPalette.night(
    Color gold, {
    Color white = const Color(0xFFFFFFFF),
    String name = 'night',
    double groundShade = 0.90,
    bool deepGold = false,
  }) {
    Color tint(double t) => Color.lerp(white, gold, t)!;
    Color shade(double t) => Color.lerp(gold, const Color(0xFF000000), t)!;
    return PPalette(
      name: name,
      hue: HSLColor.fromColor(gold).hue,
      brightness: Brightness.dark,
      ground: shade(groundShade),
      surface: shade(groundShade - 0.065),
      field: shade(groundShade - 0.12),
      navy: deepGold ? shade(0.28) : shade(0.42),
      blue: gold,
      ice: shade(0.58),
      mist: shade(0.78),
      ink: tint(0.06),
      muted: Color.lerp(tint(0.30), shade(0.9), 0.42)!,
      pressed: tint(0.18),
      accentInk: Color.lerp(gold, white, 0.12)!,
      onAccent: shade(0.88),
      onDeep: deepGold ? shade(0.88) : tint(0.06),
    );
  }
}

/// The two looks the user picks between in Profile.
abstract final class PThemes {
  static const gold = Color(0xFFD4A537);
  static PPalette day = PPalette.day(gold);
  static PPalette night = PPalette.night(gold);

  /// 'day', 'night', or 'auto' (follow the phone).
  static PPalette resolve(String choice, Brightness phone) => switch (choice) {
    'day' => day,
    'night' => night,
    _ => phone == Brightness.dark ? night : day,
  };
}

/// Pleat design tokens, read from the active [PPalette].
abstract final class PColors {
  static PPalette current = PPalette.sky;

  static Color get ground => current.ground;
  static Color get surface => current.surface;
  static Color get field => current.field; // pill search / input fill

  static Color get navy => current.navy;
  static Color get blue => current.blue;
  static Color get ice => current.ice;
  static Color get mist => current.mist;

  static Color get ink => current.ink;
  static Color get muted => current.muted;
  static Color get pressed => current.pressed;
  static Color get accentInk => current.accentInk;
  static Color get onAccent => current.onAccent;
  static Color get onDeep => current.onDeep;

  /// Only for a protected tunnel.
  static Color get safe => current.safe;

  /// Only for a dropped tunnel or a kill switch that is off.
  static Color get alert => current.alert;

  static List<Color> get planes => [navy, blue, ice, mist];

  /// Painted art turned to the active palette's hue.
  static Color tone(Color c) => current.tone(c);
}

abstract final class PRadius {
  static const card = 30.0;
  static const sheet = 32.0;
  static const media = 28.0;
  static const pill = 999.0;
}

abstract final class PShadow {
  static List<BoxShadow> soft({bool pressed = false}) => [
    BoxShadow(
      color: PColors.navy.withValues(alpha: pressed ? 0.10 : 0.07),
      blurRadius: pressed ? 10 : 28,
      offset: Offset(0, pressed ? 4 : 12),
    ),
  ];

  static List<BoxShadow> get lift => [
    BoxShadow(
      color: PColors.blue.withValues(alpha: 0.32),
      blurRadius: 22,
      offset: const Offset(0, 10),
    ),
  ];
}

/// Motion tokens. Durations come from the ui-ux-pro-max guidance
/// (feedback ≤150ms, state changes 200–350ms, scene moves ≤600ms).
abstract final class PMotion {
  static const press = Duration(milliseconds: 110);
  static const quick = Duration(milliseconds: 220);
  static const state = Duration(milliseconds: 340);
  static const tunnel = Duration(milliseconds: 500);
  static const scene = Duration(milliseconds: 700);
  static const orbitTick = Duration(milliseconds: 900);
  static const stagger = Duration(milliseconds: 40);

  /// Connect stages; Protected waits for the tunnel, not a timer.
  static const checking = Duration(milliseconds: 450);
  static const handshake = Duration(milliseconds: 750);
  static const seal = Duration(milliseconds: 400);

  static const navDamping = 0.72;

  static bool reduced(BuildContext context) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;
}

/// Type is Plus Jakarta Sans everywhere. Tests swap the loader for a
/// locally registered family so they never touch the network.
abstract final class PType {
  static String? familyOverride;

  /// Fallback families for flag glyphs. Android finds its emoji font on
  /// its own; tests that render flags point this at a loaded one.
  static List<String>? emojiFallback;

  static TextStyle _base(
    double size,
    FontWeight weight, {
    Color? color,
    double? height,
    double tracking = 0,
  }) {
    final style = TextStyle(
      fontSize: size,
      fontWeight: weight,
      color: color ?? PColors.ink,
      height: height,
      letterSpacing: tracking,
    );
    if (familyOverride != null) {
      return style.copyWith(fontFamily: familyOverride);
    }
    return GoogleFonts.plusJakartaSans(textStyle: style);
  }

  /// The oversized instrument. Tight, semibold, tabular.
  static TextStyle display(double size, {Color? color}) => _base(
    size,
    FontWeight.w600,
    color: color,
    height: 0.92,
    tracking: -size * 0.045,
  ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]);

  static TextStyle h1({Color? color}) =>
      _base(30, FontWeight.w700, color: color, height: 1.08, tracking: -0.9);
  static TextStyle h2({Color? color}) =>
      _base(22, FontWeight.w700, color: color, height: 1.12, tracking: -0.5);
  static TextStyle h3({Color? color}) =>
      _base(17, FontWeight.w700, color: color, height: 1.2, tracking: -0.2);
  static TextStyle light(double size, {Color? color}) =>
      _base(size, FontWeight.w300, color: color, height: 1.12, tracking: -0.6);
  static TextStyle body({Color? color}) =>
      _base(15, FontWeight.w500, color: color, height: 1.45);
  static TextStyle small({Color? color}) =>
      _base(13, FontWeight.w500, color: color ?? PColors.muted, height: 1.35);
  static TextStyle meta({Color? color}) => _base(
    12,
    FontWeight.w600,
    color: color ?? PColors.muted,
    height: 1.3,
  ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]);

  /// Buttons: 13px, 700, tracking 0.08em, uppercase (callers upper-case).
  static TextStyle button({Color? color}) => _base(
    13,
    FontWeight.w700,
    color: color ?? PColors.onAccent,
    tracking: 13 * 0.08,
  );

  /// Reference category label: tiny tracked caps.
  static TextStyle tab({Color? color}) => _base(
    10.5,
    FontWeight.w700,
    color: color ?? PColors.muted,
    tracking: 10.5 * 0.08,
  );
}

/// The app can be seen: resumed, or inactive under a sheet or dialog.
/// Paused or hidden, anything that only draws or polls for the screen
/// should stop.
bool onScreen(AppLifecycleState s) =>
    s == AppLifecycleState.resumed || s == AppLifecycleState.inactive;
