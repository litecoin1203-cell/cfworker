import 'package:flutter/material.dart';

import '../state/app_state.dart';
import '../state/seed.dart';
import 'shard_field.dart';
import 'tokens.dart';

/// Where the shards rest on each stage. Index order is draw order:
/// back plane first, front plane last. Colors come from the mix.
abstract final class Layouts {
  static const splash = [
    ShardSpec(0.30, 0.38, 0.30, 0.34, depth: 0.4),
    ShardSpec(0.74, 0.46, 0.34, 0.40, depth: 0.8),
    ShardSpec(0.20, 0.60, 0.26, 0.30, depth: 1.0),
    ShardSpec(0.84, 0.62, 0.22, 0.26, depth: 1.2),
  ];

  static const onboarding = [
    [
      ShardSpec(0.94, 0.36, 0.26, 0.22, depth: 0.4),
      ShardSpec(0.92, 0.56, 0.34, 0.34, depth: 0.8),
      ShardSpec(0.08, 0.66, 0.26, 0.28, depth: 1.0),
      ShardSpec(0.78, 0.70, 0.20, 0.20, depth: 1.2),
    ],
    [
      ShardSpec(0.04, 0.44, 0.24, 0.22, depth: 0.4),
      ShardSpec(0.06, 0.62, 0.30, 0.30, depth: 0.8),
      ShardSpec(0.94, 0.46, 0.28, 0.30, depth: 1.0),
      ShardSpec(0.30, 0.78, 0.22, 0.18, depth: 1.2),
    ],
    [
      ShardSpec(0.96, 0.36, 0.30, 0.20, depth: 0.4),
      ShardSpec(0.92, 0.62, 0.30, 0.36, depth: 0.8),
      ShardSpec(0.06, 0.50, 0.24, 0.30, depth: 1.0),
      ShardSpec(0.64, 0.78, 0.24, 0.16, depth: 1.2),
    ],
  ];

  static const home = [
    ShardSpec(0.30, 0.30, 0.24, 0.16, depth: 0.5),
    ShardSpec(0.86, 0.44, 0.40, 0.30, depth: 0.8),
    ShardSpec(0.16, 0.56, 0.30, 0.22, depth: 1.0),
    ShardSpec(0.66, 0.62, 0.22, 0.16, depth: 1.3),
  ];

  static const protect = [
    ShardSpec(0.94, 0.16, 0.26, 0.20, depth: 0.5),
    ShardSpec(0.90, 0.38, 0.34, 0.34, depth: 0.8),
    ShardSpec(0.08, 0.70, 0.26, 0.26, depth: 1.0),
    ShardSpec(0.86, 0.80, 0.20, 0.18, depth: 1.3),
  ];

  static const locations = [
    ShardSpec(0.70, 0.08, 0.30, 0.14, depth: 0.5),
    ShardSpec(1.00, 0.54, 0.26, 0.30, depth: 0.8),
    ShardSpec(0.04, 0.50, 0.24, 0.26, depth: 1.1),
    ShardSpec(0.90, 0.70, 0.20, 0.20, depth: 1.4),
  ];

  static const activity = [
    ShardSpec(0.92, 0.12, 0.24, 0.14, depth: 0.5),
    ShardSpec(1.00, 0.46, 0.26, 0.34, depth: 0.8),
    ShardSpec(0.00, 0.64, 0.20, 0.26, depth: 1.0),
    ShardSpec(0.20, 0.84, 0.22, 0.16, depth: 1.3),
  ];

  static const confirm = [
    ShardSpec(0.90, 0.10, 0.26, 0.14, depth: 0.5),
    ShardSpec(0.96, 0.46, 0.30, 0.30, depth: 0.8),
    ShardSpec(0.04, 0.64, 0.26, 0.26, depth: 1.0),
    ShardSpec(0.40, 0.90, 0.24, 0.14, depth: 1.3),
  ];

  static const profile = [
    ShardSpec(0.92, 0.08, 0.26, 0.12, depth: 0.5),
    ShardSpec(1.00, 0.58, 0.24, 0.26, depth: 0.8),
    ShardSpec(0.06, 0.80, 0.28, 0.24, depth: 1.0),
    ShardSpec(0.84, 0.88, 0.20, 0.14, depth: 1.3),
  ];

  static const tabs = [home, protect, locations, activity];
}

/// The selected category reshapes the colour mix, never the palette.
List<Color> mixFor(Category c) => switch (c) {
  Category.all => const [PColors.mist, PColors.navy, PColors.blue, PColors.ice],
  Category.nearby => const [
    PColors.mist,
    PColors.ice,
    PColors.blue,
    PColors.mist,
  ],
  Category.streaming => [
    PColors.ice,
    PColors.navy,
    Color.lerp(PColors.navy, PColors.blue, 0.5)!,
    PColors.navy,
  ],
  Category.gaming => const [
    PColors.mist,
    PColors.blue,
    PColors.navy,
    PColors.blue,
  ],
  Category.fastest => const [
    PColors.ice,
    PColors.blue,
    PColors.blue,
    PColors.ice,
  ],
  Category.recent => const [
    PColors.ice,
    PColors.navy,
    PColors.mist,
    PColors.blue,
  ],
};

/// The live scene for the signed-in app: tab layout, category mix, lean
/// toward the selected exit, handshake pull, protected rest, kill switch.
ShardScene sceneFor(AppState s) {
  final pull = switch (s.phase) {
    Phase.checking => 0.45,
    Phase.handshaking => 1.0,
    _ => 0.0,
  };
  return ShardScene(
    layout: Layouts.tabs[s.tab],
    mix: s.tab == 2 ? mixFor(s.category) : mixFor(Category.all),
    focus: const Offset(0.62, 0.50),
    lean: s.exit.bearing,
    pull: pull,
    rest: s.phase == Phase.protected ? 1 : 0,
    armed: s.killSwitch ? 1 : 0,
    alert: s.phase == Phase.dropped ? 1 : (s.killSwitch ? 0 : 0.7),
  );
}
