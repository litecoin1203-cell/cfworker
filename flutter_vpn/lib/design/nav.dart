import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';

import 'icons.dart';
import 'tokens.dart';

class NavItem {
  const NavItem(this.icon, this.label);
  final PIcon icon;
  final String label;
}

/// Four-item bottom nav. The active item is a blue circle that travels on
/// a spring (damping ratio 0.72) and lifts out of the bar, as in the
/// reference, rather than a tinted bar.
class PleatNav extends StatefulWidget {
  const PleatNav({
    super.key,
    required this.items,
    required this.index,
    required this.onSelect,
  });
  final List<NavItem> items;
  final int index;
  final ValueChanged<int> onSelect;

  @override
  State<PleatNav> createState() => _PleatNavState();
}

class _PleatNavState extends State<PleatNav>
    with SingleTickerProviderStateMixin {
  late final AnimationController _x = AnimationController.unbounded(
    vsync: this,
    value: widget.index.toDouble(),
  );

  static final _spring = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 280,
    ratio: PMotion.navDamping,
  );

  @override
  void didUpdateWidget(PleatNav old) {
    super.didUpdateWidget(old);
    if (old.index != widget.index) {
      if (PMotion.reduced(context)) {
        _x.value = widget.index.toDouble();
      } else {
        _x.animateWith(
          SpringSimulation(
            _spring,
            _x.value,
            widget.index.toDouble(),
            _x.velocity,
          ),
        );
      }
    }
  }

  @override
  void dispose() {
    _x.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom;
    const barH = 74.0, circle = 54.0, lift = 18.0;
    return LayoutBuilder(
      builder: (context, box) {
        final slot = box.maxWidth / widget.items.length;
        return SizedBox(
          height: barH + bottom + lift,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Positioned.fill(
                top: lift,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(PRadius.card),
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: PColors.navy.withValues(alpha: 0.08),
                        blurRadius: 24,
                        offset: const Offset(0, -6),
                      ),
                    ],
                  ),
                ),
              ),
              // Travelling collar + circle.
              AnimatedBuilder(
                animation: _x,
                builder: (context, _) {
                  final cx = slot * (_x.value + 0.5);
                  return Positioned(
                    left: cx - (circle + 14) / 2,
                    top: 0,
                    child: Container(
                      width: circle + 14,
                      height: circle + 14,
                      decoration: const BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: Container(
                        width: circle,
                        height: circle,
                        decoration: BoxDecoration(
                          color: PColors.blue,
                          shape: BoxShape.circle,
                          boxShadow: PShadow.lift,
                        ),
                        alignment: Alignment.center,
                        child: AnimatedSwitcher(
                          duration: PMotion.quick,
                          child: PIconView(
                            widget.items[widget.index].icon,
                            key: ValueKey(widget.index),
                            color: Colors.white,
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
              Positioned(
                left: 0,
                right: 0,
                top: lift,
                height: barH,
                child: Row(
                  children: [
                    for (var i = 0; i < widget.items.length; i++)
                      Expanded(child: _slot(i)),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _slot(int i) {
    final item = widget.items[i];
    final active = i == widget.index;
    return Semantics(
      button: true,
      selected: active,
      label: item.label,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => widget.onSelect(i),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const SizedBox(height: 6),
            AnimatedOpacity(
              duration: PMotion.quick,
              opacity: active ? 0 : 1,
              child: PIconView(item.icon, color: PColors.muted),
            ),
            const SizedBox(height: 5),
            AnimatedDefaultTextStyle(
              duration: PMotion.quick,
              style: PType.meta(color: active ? PColors.blue : PColors.muted)
                  .copyWith(
                    fontWeight: active ? FontWeight.w700 : FontWeight.w600,
                  ),
              child: Text(item.label, maxLines: 1),
            ),
          ],
        ),
      ),
    );
  }
}
