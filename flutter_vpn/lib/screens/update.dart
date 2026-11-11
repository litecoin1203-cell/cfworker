import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/updater.dart';
import 'update_variants.dart';

/// MB with one decimal, as the sheet shows sizes.
String _mb(int bytes) => (bytes / (1024 * 1024)).toStringAsFixed(1);

bool _sheetOpen = false;

/// The update sheet: what is new, the download with its progress, and the
/// one-time "Install unknown apps" step. When the store made the update a
/// must, it can't be closed.
Future<void> showUpdateSheet(BuildContext context) async {
  final app = AppScope.read(context);
  if (_sheetOpen || app.appUpdate == null) return;
  _sheetOpen = true;
  final must = app.mustUpdate;
  try {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.transparent,
      barrierColor: PColors.scrim,
      isScrollControlled: true,
      isDismissible: !must,
      enableDrag: !must,
      builder: (context) => PopScope(canPop: !must, child: const UpdateSheet()),
    );
  } finally {
    _sheetOpen = false;
  }
}

class UpdateSheet extends StatelessWidget {
  const UpdateSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final variant = updateSheetVariant(context);
    if (variant != null) return variant;
    final app = AppScope.of(context);
    final up = app.updater;
    final u = app.appUpdate;
    final file = u?.files[up.abi];
    final must = app.mustUpdate;
    final step = up.step;
    final pct = up.total > 0 ? (100 * up.received / up.total).floor() : 0;

    final String status = switch (step) {
      UpdateStep.idle =>
        file == null ? '' : '${_mb(file.size)} MB, made for this phone.',
      UpdateStep.downloading =>
        'Downloading… ${_mb(up.received)} of ${_mb(up.total)} MB',
      UpdateStep.checking => 'Checking the file…',
      UpdateStep.ready => 'Downloaded and checked. Install it now.',
      UpdateStep.needsPermission => 'Android asks once: turn on “Allow from this source” for Pleat, then come back.',
      UpdateStep.installing => 'Android’s installer is open. Tap Update there.',
      UpdateStep.failed => up.error ?? 'The update didn’t finish. Try again.',
    };

    final Widget action = switch (step) {
      UpdateStep.downloading => PillButton(
        label: 'Stop',
        icon: PIcon.close,
        color: PColors.mist,
        textColor: PColors.accentInk,
        onTap: up.stop,
      ),
      UpdateStep.checking => const PillButton(label: 'Checking', onTap: null),
      UpdateStep.needsPermission => PillButton(
        label: 'Allow installs',
        icon: PIcon.shield,
        onTap: up.allowInstalls,
      ),
      UpdateStep.ready || UpdateStep.installing => PillButton(
        label: 'Install',
        icon: PIcon.check,
        onTap: up.install,
      ),
      UpdateStep.failed => PillButton(
        label: 'Try again',
        icon: PIcon.refresh,
        onTap: u == null ? null : () => up.start(u),
      ),
      UpdateStep.idle => PillButton(
        label: up.received > 0 ? 'Go on' : 'Update',
        icon: PIcon.refresh,
        onTap: u == null ? null : () => up.start(u),
      ),
    };

    return Container(
      decoration: BoxDecoration(
        color: PColors.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PRadius.sheet),
        ),
      ),
      padding: EdgeInsets.fromLTRB(
        24,
        14,
        24,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: PColors.mist,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(child: Text('Update Pleat', style: PType.h2())),
              if (!must)
                RoundIcon(
                  PIcon.close,
                  onTap: () => Navigator.of(context).pop(),
                  label: 'Close',
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            u == null
                ? 'You have the latest Pleat.'
                : '${up.version.isEmpty ? 'This version' : up.version}  →  ${u.version}',
            style: PType.body(),
          ),
          if (must) ...[
            const SizedBox(height: 10),
            Text(
              'This update is needed to keep using Pleat.',
              style: PType.small(color: PColors.accentInk),
            ),
          ],
          const SizedBox(height: 20),
          if (step == UpdateStep.downloading ||
              step == UpdateStep.checking) ...[
            UsageBar(percent: pct, height: 8),
            const SizedBox(height: 10),
          ],
          if (status.isNotEmpty)
            Text(
              status,
              style: PType.small(
                color: step == UpdateStep.failed ? PColors.ink : null,
              ),
            ),
          const SizedBox(height: 20),
          action,
          const SizedBox(height: 14),
          Text(
            'It downloads through Pleat’s own connection and installs over this one. Your account, plan and settings stay as they are.',
            style: PType.meta(),
          ),
        ],
      ),
    );
  }
}
