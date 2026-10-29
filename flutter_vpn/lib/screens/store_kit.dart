import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/backdrop.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/shard_field.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import 'states.dart';

/// Shared parts of the store screens (checkout, payments, wallet, orders,
/// invite), in the same cards, pills and shards as the rest of Pleat.

String toman(int v) => '${grouped(v)} toman';

String grouped(int v) {
  final s = v.abs().toString();
  final b = StringBuffer(v < 0 ? '-' : '');
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return '$b';
}

String shortDate(DateTime? d) {
  if (d == null) return '';
  const m = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final l = d.toLocal();
  return '${l.day} ${m[l.month - 1]} ${l.year}';
}

/// "#RRGGBB" from the server, or [fallback].
Color hexColor(String hex, Color fallback) {
  final h = hex.replaceFirst('#', '');
  final v = int.tryParse(h.length == 6 ? 'FF$h' : h, radix: 16);
  return v == null ? fallback : Color(v);
}

void copyText(BuildContext context, String text, String done) {
  Clipboard.setData(ClipboardData(text: text));
  HapticFeedback.selectionClick();
  showNote(context, done);
}

/// A store page: backdrop, back button, title and a scrolling body.
class StorePage extends StatelessWidget {
  const StorePage({
    super.key,
    required this.title,
    this.subtitle,
    required this.children,
    this.layout = Layouts.confirm,
  });
  final String title;
  final String? subtitle;
  final List<Widget> children;
  final List<ShardSpec> layout;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: PColors.ground,
      body: ShardBackdrop(
        layout: layout,
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: RoundIcon(
                  PIcon.back,
                  onTap: () => Navigator.of(context).pop(),
                  label: 'Back',
                ),
              ),
              const SizedBox(height: 12),
              Text(title, style: PType.h1()),
              if (subtitle != null) ...[
                const SizedBox(height: 4),
                Padding(
                  padding: const EdgeInsets.only(right: 96),
                  child: Text(subtitle!, style: PType.small()),
                ),
              ],
              const SizedBox(height: 20),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

/// A pill text field, as on the sign-in screens.
class PField extends StatelessWidget {
  const PField({
    super.key,
    required this.controller,
    required this.hint,
    this.keyboard,
    this.mono = false,
    this.trailing,
    this.onChanged,
  });
  final TextEditingController controller;
  final String hint;
  final TextInputType? keyboard;
  final bool mono;
  final Widget? trailing;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 56,
      padding: EdgeInsets.only(left: 22, right: trailing == null ? 22 : 6),
      decoration: BoxDecoration(
        color: PColors.field,
        borderRadius: BorderRadius.circular(PRadius.pill),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              keyboardType: keyboard,
              autocorrect: false,
              onChanged: onChanged,
              style: PType.body().copyWith(
                fontWeight: FontWeight.w700,
                fontFamily: mono ? 'monospace' : null,
              ),
              decoration: InputDecoration(
                isCollapsed: true,
                border: InputBorder.none,
                hintText: hint,
                hintStyle: PType.body(color: PColors.muted),
              ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// One way to pay. Selected: blue ring and a filled dot.
class MethodTile extends StatelessWidget {
  const MethodTile({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    required this.selected,
    required this.onTap,
  });
  final PIcon icon;
  final String title, body;
  final bool selected;

  /// Null: can't be used now (shown dim).
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.quick;
    final on = selected && onTap != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Opacity(
        opacity: onTap == null ? 0.5 : 1,
        child: Pressable(
          onTap: onTap == null
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  onTap!();
                },
          label: title,
          radius: 26,
          color: Colors.white,
          child: AnimatedContainer(
            duration: d,
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(26),
              border: Border.all(
                color: on ? PColors.blue : PColors.mist,
                width: on ? 2 : 1,
              ),
            ),
            child: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: on ? PColors.blue : PColors.mist,
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: PIconView(
                    icon,
                    size: 20,
                    color: on ? Colors.white : PColors.blue,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: PType.h3().copyWith(fontSize: 15)),
                      const SizedBox(height: 2),
                      Text(body, style: PType.small()),
                    ],
                  ),
                ),
                AnimatedScale(
                  duration: d,
                  scale: on ? 1 : 0,
                  curve: Curves.easeOutBack,
                  child: const PIconView(PIcon.check, color: PColors.blue),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A value to copy: label above, value in a field pill with Copy.
class CopyRow extends StatelessWidget {
  const CopyRow({
    super.key,
    required this.label,
    required this.value,
    this.display,
    this.mono = true,
    this.alert = false,
  });
  final String label, value;
  final String? display;
  final bool mono, alert;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 6, bottom: 6),
          child: Text(
            label,
            style: PType.meta(color: alert ? PColors.alert : PColors.muted),
          ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(18, 6, 6, 6),
          decoration: BoxDecoration(
            color: PColors.field,
            borderRadius: BorderRadius.circular(24),
          ),
          child: Row(
            children: [
              Expanded(
                child: SelectableText(
                  display ?? value,
                  style: PType.body().copyWith(
                    fontWeight: FontWeight.w700,
                    fontFamily: mono ? 'monospace' : null,
                    fontSize: mono ? 13.5 : null,
                  ),
                ),
              ),
              RoundIcon(
                PIcon.copy,
                onTap: () => copyText(context, value, '$label copied.'),
                label: 'Copy $label',
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Numbered steps of a payment; [at] is the current one.
class PaySteps extends StatelessWidget {
  const PaySteps({super.key, required this.steps, required this.at});
  final List<String> steps;
  final int at;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < steps.length; i++) ...[
          if (i > 0)
            Expanded(
              child: Container(
                height: 2,
                margin: const EdgeInsets.only(bottom: 22),
                color: i <= at ? PColors.blue : PColors.mist,
              ),
            ),
          Column(
            children: [
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  color: i < at
                      ? PColors.blue
                      : (i == at ? Colors.white : PColors.mist),
                  shape: BoxShape.circle,
                  border: i == at
                      ? Border.all(color: PColors.blue, width: 2)
                      : null,
                ),
                alignment: Alignment.center,
                child: i < at
                    ? const PIconView(
                        PIcon.check,
                        size: 14,
                        color: Colors.white,
                      )
                    : Text(
                        '${i + 1}',
                        style: PType.meta(
                          color: i == at ? PColors.blue : PColors.muted,
                        ),
                      ),
              ),
              const SizedBox(height: 6),
              Text(
                steps[i],
                style: PType.meta(
                  color: i <= at ? PColors.navy : PColors.muted,
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}
