import 'package:flutter/material.dart';

import '../design/avatars.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';

/// The 14 Pleat characters in a grid; the pick is highlighted.
class AvatarGrid extends StatelessWidget {
  const AvatarGrid({super.key, required this.chosen, required this.onPick});
  final String chosen;

  /// Null while saving.
  final ValueChanged<String>? onPick;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, box) {
        const cols = 4;
        const gap = 14.0;
        final cell = (box.maxWidth - gap * (cols - 1)) / cols;
        final art = cell.clamp(40.0, 72.0) - 10;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final a in pleatAvatars)
              Pressable(
                selected: a.id == chosen,
                onTap: onPick == null ? null : () => onPick!(a.id),
                label: '${a.name}, ${a.kind}',
                radius: PRadius.pill,
                child: SizedBox(
                  width: cell,
                  height: art + 10,
                  child: Center(
                    child: AnimatedContainer(
                      duration: PMotion.quick,
                      padding: const EdgeInsets.all(3),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: a.id == chosen
                              ? PColors.blue
                              : Colors.transparent,
                          width: 3,
                        ),
                      ),
                      child: AvatarArt(a, size: art - 2),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// Shown instead of the app, once, right after a new account first signs
/// in (and for any account that has no character yet). There is no skip and
/// no back: the Pleat characters are the only profile picture, and Telegram
/// photos are never used. The pick is saved on the account (POST
/// /me/avatar), so it works before any panel account exists.
class AvatarGate extends StatefulWidget {
  const AvatarGate({super.key});

  @override
  State<AvatarGate> createState() => _AvatarGateState();
}

class _AvatarGateState extends State<AvatarGate> {
  String _chosen = '';
  String? _error;
  bool _busy = false;

  Future<void> _save(AppState app) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await app.setAvatar(_chosen);
    if (!mounted) return;
    // On success the gate disappears by itself (needsAvatar turns false).
    setState(() {
      _busy = false;
      _error = err;
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final pick = avatarById(_chosen);
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: PColors.ground,
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
            children: [
              Text('Pick your avatar', style: PType.h1()),
              const SizedBox(height: 8),
              Text(
                'Choose the character that will be you in Pleat. '
                'You can change it later from your profile.',
                style: PType.small(),
              ),
              const SizedBox(height: 26),
              if (pick != null)
                Center(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 22),
                    child: AvatarArt(pick, size: 112),
                  ),
                ),
              AvatarGrid(
                chosen: _chosen,
                onPick: _busy ? null : (id) => setState(() => _chosen = id),
              ),
              const SizedBox(height: 24),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(left: 18, bottom: 10),
                  child: Text(_error!, style: PType.small(color: PColors.ink)),
                ),
              PillButton(
                label: _busy
                    ? 'Saving…'
                    : pick == null
                    ? 'Choose an avatar'
                    : 'Continue as ${pick.name}',
                onTap: _busy || pick == null ? null : () => _save(app),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
