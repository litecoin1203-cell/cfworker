import 'package:flutter/material.dart';

import 'shard_field.dart';
import 'tokens.dart';

/// Studio ground with the shard field behind a standalone screen, so the
/// planes stay on stage outside the tab shell too.
class ShardBackdrop extends StatelessWidget {
  const ShardBackdrop({
    super.key,
    required this.layout,
    required this.child,
    this.lean = 0,
  });
  final List<ShardSpec> layout;
  final Widget child;
  final double lean;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: PColors.ground,
      child: Stack(
        fit: StackFit.expand,
        children: [
          ShardField(
            scene: ShardScene(layout: layout, lean: lean),
          ),
          child,
        ],
      ),
    );
  }
}
