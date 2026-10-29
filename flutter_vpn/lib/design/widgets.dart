import 'dart:ui';

import 'package:flutter/material.dart';

import 'icons.dart';
import 'tokens.dart';

/// Press feedback for everything tappable: scale to 0.985, the shadow
/// tightens, then a springy return. No ripple, no splash.
class Pressable extends StatefulWidget {
  const Pressable({
    super.key,
    required this.child,
    this.onTap,
    this.label,
    this.radius = PRadius.card,
    this.color,
    this.shadow = false,
    this.padding,
    this.selected,
  });

  final Widget child;
  final VoidCallback? onTap;
  final String? label;
  final double radius;
  final Color? color;
  final bool shadow;
  final EdgeInsetsGeometry? padding;
  final bool? selected;

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _down = false;

  void _set(bool v) {
    if (widget.onTap == null) return;
    setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    final reduced = PMotion.reduced(context);
    return Semantics(
      button: true,
      selected: widget.selected,
      label: widget.label,
      enabled: widget.onTap != null,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _set(true),
        onTapUp: (_) => _set(false),
        onTapCancel: () => _set(false),
        onTap: widget.onTap,
        child: AnimatedScale(
          scale: _down ? 0.985 : 1,
          duration: reduced
              ? Duration.zero
              : (_down ? PMotion.press : const Duration(milliseconds: 280)),
          curve: _down ? Curves.easeOut : Curves.easeOutBack,
          child: AnimatedContainer(
            duration: PMotion.press,
            padding: widget.padding,
            decoration: widget.color == null && !widget.shadow
                ? null
                : BoxDecoration(
                    color: widget.color,
                    borderRadius: BorderRadius.circular(widget.radius),
                    boxShadow: widget.shadow
                        ? PShadow.soft(pressed: _down)
                        : null,
                  ),
            child: widget.child,
          ),
        ),
      ),
    );
  }
}

/// White surface card, radius 30, soft shadow, no border.
class SurfaceCard extends StatelessWidget {
  const SurfaceCard({
    super.key,
    required this.child,
    this.onTap,
    this.label,
    this.padding = const EdgeInsets.all(20),
    this.color = PColors.surface,
    this.radius = PRadius.card,
  });

  final Widget child;
  final VoidCallback? onTap;
  final String? label;
  final EdgeInsetsGeometry padding;
  final Color color;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final body = ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: Padding(padding: padding, child: child),
    );
    if (onTap == null) {
      return DecoratedBox(
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(radius),
          boxShadow: PShadow.soft(),
        ),
        child: body,
      );
    }
    return Pressable(
      onTap: onTap,
      label: label,
      color: color,
      radius: radius,
      shadow: true,
      child: body,
    );
  }
}

/// Pill primary button. Label is set upper-case at 13/700/0.08em.
class PillButton extends StatelessWidget {
  const PillButton({
    super.key,
    required this.label,
    required this.onTap,
    this.icon,
    this.color = PColors.blue,
    this.textColor = Colors.white,
    this.height = 54,
    this.expand = true,
  });

  final String label;
  final VoidCallback? onTap;
  final PIcon? icon;
  final Color color;
  final Color textColor;
  final double height;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Pressable(
      onTap: onTap,
      label: label,
      radius: PRadius.pill,
      color: enabled ? color : PColors.mist,
      child: SizedBox(
        height: height,
        width: expand ? double.infinity : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 26),
          child: Row(
            mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                PIconView(
                  icon!,
                  size: 18,
                  color: enabled ? textColor : PColors.muted,
                ),
                const SizedBox(width: 10),
              ],
              Text(
                label.toUpperCase(),
                style: PType.button(color: enabled ? textColor : PColors.muted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Pill search field from the reference, with an outline glyph.
class PillSearch extends StatelessWidget {
  const PillSearch({
    super.key,
    required this.hint,
    required this.onChanged,
    this.controller,
  });
  final String hint;
  final ValueChanged<String> onChanged;
  final TextEditingController? controller;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 52,
      decoration: BoxDecoration(
        color: PColors.field,
        borderRadius: BorderRadius.circular(PRadius.pill),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 18),
      child: Row(
        children: [
          const PIconView(PIcon.search, size: 20, color: PColors.muted),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              style: PType.body(),
              cursorColor: PColors.blue,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                isCollapsed: true,
                border: InputBorder.none,
                hintText: hint,
                hintStyle: PType.body(color: PColors.muted),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Frosted slab: used once per photo, over the photo, never as a theme.
class FrostedSlab extends StatelessWidget {
  const FrostedSlab({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(18),
  });
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(24),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
        child: Container(
          padding: padding,
          color: Colors.white.withValues(alpha: 0.72),
          child: child,
        ),
      ),
    );
  }
}

/// Pill toggle. Off-red is reserved for the kill switch.
class PToggle extends StatelessWidget {
  const PToggle({
    super.key,
    required this.value,
    required this.onChanged,
    required this.label,
    this.offIsAlert = false,
    this.onDark = false,
  });

  final bool value;

  /// Null: the switch can't work in this build. It shows off, greyed, and
  /// never red.
  final ValueChanged<bool>? onChanged;
  final String label;
  final bool offIsAlert;
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.quick;
    final enabled = onChanged != null;
    final track = value && enabled
        ? PColors.blue
        : offIsAlert && enabled
        ? PColors.alert
        : (onDark ? Colors.white.withValues(alpha: 0.22) : PColors.mist);
    return Semantics(
      toggled: value && enabled,
      enabled: enabled,
      label: enabled ? label : '$label, unavailable',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? () => onChanged!(!value) : null,
        child: Opacity(
          opacity: enabled ? 1 : 0.45,
          child: SizedBox(
            width: 60,
            height: 48,
            child: Center(
              child: AnimatedContainer(
                duration: d,
                width: 52,
                height: 32,
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: track,
                  borderRadius: BorderRadius.circular(PRadius.pill),
                ),
                child: AnimatedAlign(
                  duration: d,
                  curve: Curves.easeOutBack,
                  alignment: value && enabled
                      ? Alignment.centerRight
                      : Alignment.centerLeft,
                  child: Container(
                    width: 24,
                    height: 24,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(
                          color: PColors.navy.withValues(alpha: 0.18),
                          blurRadius: 6,
                          offset: const Offset(0, 2),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Round icon button, 48dp target.
class RoundIcon extends StatelessWidget {
  const RoundIcon(
    this.icon, {
    super.key,
    required this.onTap,
    required this.label,
    this.color = PColors.ink,
    this.background,
    this.filled = false,
    this.badge = false,
  });

  final PIcon icon;
  final VoidCallback onTap;
  final String label;
  final Color color;
  final Color? background;
  final bool filled;
  final bool badge;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      label: label,
      radius: 24,
      color: background,
      child: SizedBox.square(
        dimension: 48,
        child: Stack(
          alignment: Alignment.center,
          children: [
            PIconView(icon, color: color, filled: filled),
            if (badge)
              Positioned(
                top: 12,
                right: 13,
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: PColors.blue,
                    shape: BoxShape.circle,
                    border: Border.all(color: Colors.white, width: 1.5),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// List items enter 40ms apart. Reduced motion shows them at once.
class StaggerIn extends StatefulWidget {
  const StaggerIn({super.key, required this.index, required this.child});
  final int index;
  final Widget child;

  @override
  State<StaggerIn> createState() => _StaggerInState();
}

class _StaggerInState extends State<StaggerIn>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 320),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_c.value > 0 || _c.isAnimating) return;
    if (PMotion.reduced(context)) {
      _c.value = 1;
    } else {
      Future.delayed(PMotion.stagger * widget.index.clamp(0, 12), () {
        if (mounted) _c.forward();
      });
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) {
        final t = Curves.easeOutCubic.transform(_c.value);
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, (1 - t) * 14),
            child: child,
          ),
        );
      },
      child: widget.child,
    );
  }
}

/// Section label used sparingly: sentence case, semibold.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key, this.trailing, this.onTrailing});
  final String text;
  final String? trailing;
  final VoidCallback? onTrailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: Text(text, style: PType.h3())),
        if (trailing != null)
          Pressable(
            onTap: onTrailing,
            label: trailing,
            radius: 12,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 12),
              child: Text(trailing!, style: PType.small()),
            ),
          ),
      ],
    );
  }
}

/// Horizontal fill for plan usage, 0 … 100. Navy past 80 %; red stays
/// reserved for a dropped tunnel.
class UsageBar extends StatelessWidget {
  const UsageBar({super.key, required this.percent, this.height = 6});
  final int percent;
  final double height;

  @override
  Widget build(BuildContext context) {
    final p = percent.clamp(0, 100);
    return Container(
      height: height,
      decoration: BoxDecoration(
        color: PColors.mist,
        borderRadius: BorderRadius.circular(height),
      ),
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: p / 100,
        child: Container(
          decoration: BoxDecoration(
            color: p >= 80 ? PColors.navy : PColors.blue,
            borderRadius: BorderRadius.circular(height),
          ),
        ),
      ),
    );
  }
}

/// A line that says plainly why a control can't work in this build.
class UnavailableNote extends StatelessWidget {
  const UnavailableNote(this.text, {super.key, this.onDark = false});
  final String text;
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final ink = onDark ? PColors.ice : PColors.muted;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: PIconView(PIcon.info, size: 16, color: ink),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: PType.small(color: ink)
                .copyWith(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }
}
