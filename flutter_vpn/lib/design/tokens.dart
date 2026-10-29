import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Pleat design tokens. The palette is the reference DNA and is not open
/// to reinterpretation: studio ground, white surfaces, four brand planes.
abstract final class PColors {
  static const ground = Color(0xFFE7F1FA);
  static const surface = Color(0xFFFFFFFF);
  static const field = Color(0xFFF2F6FB); // pill search / input fill

  static const navy = Color(0xFF14284B);
  static const blue = Color(0xFF2F89F5);
  static const ice = Color(0xFFA9D4F5);
  static const mist = Color(0xFFD7E9FA);

  static const ink = Color(0xFF16181D);
  static const muted = Color(0xFF8B93A7);
  static const pressed = Color(0xFF1E74DB);

  /// Only for a protected tunnel.
  static const safe = Color(0xFF1F9D55);

  /// Only for a dropped tunnel or a kill switch that is off.
  static const alert = Color(0xFFE5484D);

  static const planes = [navy, blue, ice, mist];
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

  static List<BoxShadow> lift = [
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

  /// Connect demo: Checking → Handshaking → Protected ≈ 1.6s.
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

  static TextStyle _base(
    double size,
    FontWeight weight, {
    Color color = PColors.ink,
    double? height,
    double tracking = 0,
  }) {
    final style = TextStyle(
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: tracking,
    );
    if (familyOverride != null) {
      return style.copyWith(fontFamily: familyOverride);
    }
    return GoogleFonts.plusJakartaSans(textStyle: style);
  }

  /// The oversized instrument. Tight, semibold, tabular.
  static TextStyle display(double size, {Color color = PColors.ink}) => _base(
    size,
    FontWeight.w600,
    color: color,
    height: 0.92,
    tracking: -size * 0.045,
  ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]);

  static TextStyle h1({Color color = PColors.ink}) =>
      _base(30, FontWeight.w700, color: color, height: 1.08, tracking: -0.9);
  static TextStyle h2({Color color = PColors.ink}) =>
      _base(22, FontWeight.w700, color: color, height: 1.12, tracking: -0.5);
  static TextStyle h3({Color color = PColors.ink}) =>
      _base(17, FontWeight.w700, color: color, height: 1.2, tracking: -0.2);
  static TextStyle light(double size, {Color color = PColors.ink}) =>
      _base(size, FontWeight.w300, color: color, height: 1.12, tracking: -0.6);
  static TextStyle body({Color color = PColors.ink}) =>
      _base(15, FontWeight.w500, color: color, height: 1.45);
  static TextStyle small({Color color = PColors.muted}) =>
      _base(13, FontWeight.w500, color: color, height: 1.35);
  static TextStyle meta({Color color = PColors.muted}) => _base(
    12,
    FontWeight.w600,
    color: color,
    height: 1.3,
  ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]);

  /// Buttons: 13px, 700, tracking 0.08em, uppercase (callers upper-case).
  static TextStyle button({Color color = Colors.white}) =>
      _base(13, FontWeight.w700, color: color, tracking: 13 * 0.08);

  /// Reference category label: tiny tracked caps.
  static TextStyle tab({Color color = PColors.muted}) =>
      _base(10.5, FontWeight.w700, color: color, tracking: 10.5 * 0.08);
}
