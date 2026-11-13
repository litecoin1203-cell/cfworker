// Colour defaults come from the live palette, so they are nullable
// parameters stored in private fields; this lint cannot apply to those.
// ignore_for_file: prefer_initializing_formals

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../design/avatars.dart';
import '../design/backdrop.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/mark.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'avatar_gate.dart';
import 'check.dart';
import 'login.dart';
import 'checkout.dart';
import 'plan_usage.dart';
import 'store_kit.dart';
import 'wallet.dart';
import 'states.dart';

/// Profile, opened from the avatar or the name on Home. From the top: who
/// the person is (Telegram first, required; Gmail second, optional), the
/// Plans shelf (the running plan and the plans on sale), then the account
/// rows. Data, days and packages live in Activity. Sign out clears the tokens and returns to Login.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // the Plans shelf shows the store's current prices
      AppScope.read(context).loadPublic();
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final me = app.me.value;
    final tgVerified = me?.telegramVerified ?? false;
    final handle = tgVerified
        ? (me!.telegramUsername.isNotEmpty
              ? '@${me.telegramUsername}'
              : 'Telegram ID ${me.telegramId}')
        : app.login;
    return Scaffold(
      backgroundColor: PColors.ground,
      body: ShardBackdrop(
        layout: Layouts.profile,
        child: SafeArea(
          child: RefreshIndicator(
            color: PColors.accentInk,
            onRefresh: () => Future.wait([app.loadMe(), app.loadPublic()]),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                Row(
                  children: [
                    RoundIcon(
                      PIcon.back,
                      onTap: () => Navigator.of(context).pop(),
                      label: 'Back',
                    ),
                    const Spacer(),
                    const PleatMark(size: 30),
                    const SizedBox(width: 12),
                  ],
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Pressable(
                      onTap: () => _avatarSheet(context),
                      label: 'Choose your avatar',
                      radius: PRadius.pill,
                      child: Stack(
                        clipBehavior: Clip.none,
                        children: [
                          Avatar(app: app, size: 72, ring: 4),
                          Positioned(
                            right: -2,
                            bottom: -2,
                            child: Container(
                              width: 26,
                              height: 26,
                              decoration: BoxDecoration(
                                color: PColors.blue,
                                shape: BoxShape.circle,
                                border: Border.all(
                                  color: PColors.surface,
                                  width: 2.5,
                                ),
                              ),
                              alignment: Alignment.center,
                              child: PIconView(
                                PIcon.grid,
                                size: 12,
                                color: PColors.onAccent,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            app.firstName,
                            style: PType.h2(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 4),
                          Row(
                            children: [
                              Flexible(
                                child: FitLine(handle, style: PType.small()),
                              ),
                              if (tgVerified) ...[
                                const SizedBox(width: 8),
                                SoftChip('VERIFIED', color: PColors.safe),
                              ],
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 22),
                _Identity(app: app),
                const SizedBox(height: 14),
                // The version lives in the footer; this card shows only
                // while a new Pleat is waiting.
                if (app.appUpdate != null) ...[
                  SurfaceCard(
                    padding: const EdgeInsets.fromLTRB(20, 8, 10, 8),
                    child: _Row(
                      icon: PIcon.download,
                      title: 'Pleat ${app.appUpdate!.version} is ready',
                      body:
                          'You have ${app.updater.version}. Update in a minute.',
                      trailing: _RowAction('UPDATE', onTap: app.openUpdate),
                    ),
                  ),
                  const SizedBox(height: 14),
                ],
                _PlansShelf(app: app),
                const SizedBox(height: 14),
                SurfaceCard(
                  padding: const EdgeInsets.fromLTRB(20, 8, 10, 8),
                  child: Column(
                    children: [
                      _Row(
                        icon: PIcon.ticket,
                        title: 'Wallet',
                        body: toman(app.me.value?.wallet ?? 0),
                        trailing: _RowAction(
                          'OPEN',
                          onTap: () => Navigator.of(context).push(
                            FadeRoute(builder: (_) => const WalletScreen()),
                          ),
                        ),
                      ),
                      _Row(
                        icon: PIcon.chart,
                        title: 'Payments',
                        body: 'Orders, receipts and their status.',
                        trailing: _RowAction(
                          'OPEN',
                          onTap: () => Navigator.of(context).push(
                            FadeRoute(builder: (_) => const OrdersScreen()),
                          ),
                        ),
                      ),
                      _Row(
                        icon: PIcon.user,
                        title: 'Invite friends',
                        body: app.config.referralPercent > 0
                            ? 'Earn ${app.config.referralPercent}% of what they buy.'
                            : 'Share your invite code.',
                        trailing: _RowAction(
                          'INVITE',
                          onTap: () => Navigator.of(context).push(
                            FadeRoute(builder: (_) => const InviteScreen()),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                SurfaceCard(
                  padding: const EdgeInsets.fromLTRB(20, 8, 10, 8),
                  child: Column(
                    children: [
                      _Row(
                        icon: PIcon.route,
                        title: 'Connection check',
                        body: 'Test each step, for support.',
                        trailing: _RowAction(
                          'RUN',
                          onTap: () => Navigator.of(context).push(
                            FadeRoute(builder: (_) => const CheckScreen()),
                          ),
                        ),
                      ),
                      _Appearance(app: app),
                      _Row(
                        icon: PIcon.pulse,
                        title: 'Reduce motion',
                        body: 'Shards and orbits hold still. States still change.',
                        trailing: PToggle(
                          value: app.reduceMotion,
                          onChanged: (v) =>
                              app.update((s) => s.reduceMotion = v),
                          label: 'Reduce motion',
                        ),
                      ),
                      _Row(
                        icon: PIcon.chart,
                        title: 'Send diagnostics',
                        body: 'Problems reach support on their own. Never your configs or browsing.',
                        trailing: PToggle(
                          value: app.sendDiagnostics,
                          onChanged: app.setSendDiagnostics,
                          label: 'Send diagnostics',
                        ),
                      ),
                      _Row(
                        icon: PIcon.lock,
                        title: 'Change password',
                        body: 'Other phones are signed out.',
                        trailing: _RowAction(
                          'CHANGE',
                          onTap: () => _changePassword(context),
                        ),
                      ),
                      if (app.config.supportUrl.isNotEmpty)
                        _Row(
                          icon: PIcon.mail,
                          title: 'Support',
                          body: 'Message the team.',
                          trailing: _RowAction(
                            'OPEN',
                            onTap: () async {
                              final ok = await app.tunnel.openUrl(
                                app.config.supportUrl,
                              );
                              if (!ok && context.mounted) {
                                _copy(
                                  context,
                                  app.config.supportUrl,
                                  'Support link copied.',
                                );
                              }
                            },
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                _Devices(app: app),
                const SizedBox(height: 14),
                SurfaceCard(
                  padding: const EdgeInsets.fromLTRB(20, 8, 10, 8),
                  child: _Row(
                    icon: PIcon.logout,
                    title: 'Sign out everywhere',
                    body: 'Ends every session of this account.',
                    trailing: _RowAction(
                      'END',
                      onTap: () async {
                        final err = await app.signOutEverywhere();
                        if (!context.mounted) return;
                        if (err != null) return showNote(context, err);
                        Navigator.of(context).pushAndRemoveUntil(
                          FadeRoute(builder: (_) => const LoginScreen()),
                          (_) => false,
                        );
                      },
                    ),
                  ),
                ),
                const SizedBox(height: 22),
                PillButton(
                  label: 'Sign out',
                  icon: PIcon.logout,
                  color: PColors.surface,
                  textColor: PColors.ink,
                  onTap: () async {
                    await app.signOut();
                    if (!context.mounted) return;
                    Navigator.of(context).pushAndRemoveUntil(
                      FadeRoute(builder: (_) => const LoginScreen()),
                      (_) => false,
                    );
                  },
                ),
                const SizedBox(height: 28),
                _VersionFooter(app: app),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The signature at the end of Profile: the mark, which Pleat this is,
/// whether it is up to date, and a button that asks the store again.
class _VersionFooter extends StatefulWidget {
  const _VersionFooter({required this.app});
  final AppState app;

  @override
  State<_VersionFooter> createState() => _VersionFooterState();
}

class _VersionFooterState extends State<_VersionFooter> {
  bool _checking = false;

  Future<void> _check() async {
    final app = widget.app;
    if (app.appUpdate != null) return app.openUpdate();
    setState(() => _checking = true);
    await app.loadConfig();
    if (!mounted) return;
    setState(() => _checking = false);
    if (app.appUpdate != null) {
      app.openUpdate();
    } else {
      showNote(context, 'You have the latest Pleat.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    final v = app.updater.version;
    final has = app.appUpdate != null;
    final at = app.updateCheckedAt;
    final when = at == null
        ? ''
        : '  ·  checked ${TimeOfDay.fromDateTime(at).format(context)}';
    return Column(
      children: [
        const PleatMark(size: 34),
        const SizedBox(height: 10),
        // A long press sends a test health report, to see one reach support.
        GestureDetector(
          onLongPress: () async {
            final ok = await app.sendTestReport();
            if (!context.mounted) return;
            showNote(
              context,
              ok
                  ? 'Test report sent.'
                  : (app.sendDiagnostics
                        ? 'Couldn’t send it now. It goes with the next report.'
                        : 'Turn on Send diagnostics first.'),
            );
          },
          child: Text(v.isEmpty ? 'Pleat' : 'Pleat $v', style: PType.h3()),
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: has ? PColors.blue : PColors.safe,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                has
                    ? '${app.appUpdate!.version} is ready'
                    : (_checking ? 'Checking…' : 'Up to date$when'),
                style: PType.meta(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Pressable(
          onTap: _checking ? null : _check,
          label: has ? 'Update' : 'Check for updates',
          radius: PRadius.pill,
          color: PColors.mist,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            child: Text(
              has ? 'UPDATE' : 'CHECK FOR UPDATES',
              style: PType.button(color: PColors.accentInk),
            ),
          ),
        ),
      ],
    );
  }
}

/// One switch: on = night look, off = day look. Until the user flips it
/// the app follows the phone. Saved on this phone; the whole app changes
/// in place, this screen included.
class _Appearance extends StatelessWidget {
  const _Appearance({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final night = PColors.current.isDark;
    return _Row(
      icon: night ? PIcon.moon : PIcon.sun,
      title: 'Night mode',
      body: app.theme == 'auto'
          ? 'Follows your phone until you switch.'
          : (night
                ? 'Dark look, on this phone.'
                : 'Light look, on this phone.'),
      trailing: PToggle(
        value: night,
        onChanged: (v) => app.update((s) => s.theme = v ? 'night' : 'day'),
        label: 'Night mode',
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.title,
    required this.body,
    required this.trailing,
    this.fitTitle = false,
  });
  final PIcon icon;
  final String title, body;
  final Widget trailing;

  /// One line that always fits the width (an email address).
  final bool fitTitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          PIconView(icon, color: PColors.accentInk),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                fitTitle
                    ? FitLine(title, style: PType.h3().copyWith(fontSize: 15))
                    : Text(title, style: PType.h3().copyWith(fontSize: 15)),
                const SizedBox(height: 2),
                Text(body, style: PType.small()),
              ],
            ),
          ),
          const SizedBox(width: 8),
          trailing,
        ],
      ),
    );
  }
}

/// One line of text that fits its width on any screen: it first shrinks
/// (down to 80%), and an address still too long loses the middle of its
/// name, never the domain: "averyveryl…name@gmail.com".
class FitLine extends StatelessWidget {
  const FitLine(this.text, {super.key, required this.style});
  final String text;
  final TextStyle style;

  static double _width(String t, TextStyle st, TextScaler scaler) {
    final p = TextPainter(
      text: TextSpan(text: t, style: st),
      textDirection: TextDirection.ltr,
      textScaler: scaler,
      maxLines: 1,
    )..layout();
    return p.width;
  }

  @override
  Widget build(BuildContext context) {
    final scaler = MediaQuery.textScalerOf(context);
    return LayoutBuilder(
      builder: (context, box) {
        final max = box.maxWidth;
        final base = style.fontSize ?? 15;
        var st = style;
        // shrink in small steps until it fits, at most to 80%
        for (var f = 1.0; f >= 0.8; f -= 0.05) {
          st = style.copyWith(fontSize: base * f);
          if (_width(text, st, scaler) <= max) {
            return Text(text, style: st, maxLines: 1, softWrap: false);
          }
        }
        // still too long: cut the middle of the name, keep the domain
        final at = text.lastIndexOf('@');
        final tail = at > 0 ? text.substring(at) : '';
        final head = at > 0 ? text.substring(0, at) : text;
        var keep = head.length;
        String cut(int k) {
          final front = (k * 0.6).ceil(), back = k - front;
          return '${head.substring(0, front)}…'
              '${head.substring(head.length - back)}$tail';
        }

        while (keep > 2 && _width(cut(keep), st, scaler) > max) {
          keep--;
        }
        return Text(
          cut(keep),
          style: st,
          maxLines: 1,
          softWrap: false,
          overflow: TextOverflow.ellipsis,
          semanticsLabel: text,
        );
      },
    );
  }
}

class _RowAction extends StatelessWidget {
  const _RowAction(this.text, {required this.onTap});
  final String text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    label: text.toLowerCase(),
    radius: PRadius.pill,
    color: onTap == null ? PColors.field : PColors.mist,
    child: SizedBox(
      height: 40,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Center(
          child: Text(
            text,
            style: PType.button(
              color: onTap == null ? PColors.muted : PColors.accentInk,
            ),
          ),
        ),
      ),
    ),
  );
}

void _copy(BuildContext context, String text, String done) {
  Clipboard.setData(ClipboardData(text: text));
  showNote(context, done);
}

/// Devices from `GET /devices`; Remove calls `DELETE /devices/:id`.
class _Devices extends StatefulWidget {
  const _Devices({required this.app});
  final AppState app;

  @override
  State<_Devices> createState() => _DevicesState();
}

class _DevicesState extends State<_Devices> {
  int? _removing;

  String _seen(DateTime? d) {
    if (d == null) return 'Never seen';
    final ago = DateTime.now().difference(d);
    if (ago.inMinutes < 2) return 'Active now';
    if (ago.inHours < 1) return '${ago.inMinutes} min ago';
    if (ago.inDays < 1) return '${ago.inHours} h ago';
    return '${ago.inDays} days ago';
  }

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    final list = app.devices.value ?? const <Device>[];
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 16, 10, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text('Devices', style: PType.h3())),
              if (app.subscription != null)
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Text(
                    '${list.length} of ${app.subscription!.deviceLimit}',
                    style: PType.meta(),
                  ),
                ),
            ],
          ),
          if (list.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Text(
                app.devices.loading
                    ? 'Loading devices…'
                    : (app.devices.error ?? 'No devices yet.'),
                style: PType.small(),
              ),
            ),
          for (final d in list)
            _Row(
              icon: PIcon.device,
              title: d.current ? '${d.model} (this phone)' : d.model,
              body: _seen(d.lastSeen),
              trailing: _RowAction(
                _removing == d.id ? '…' : 'REMOVE',
                onTap: d.current || _removing != null
                    ? null
                    : () async {
                        setState(() => _removing = d.id);
                        final err = await app.removeDevice(d);
                        if (!mounted) return;
                        setState(() => _removing = null);
                        showNote(this.context, err ?? 'Device removed.');
                      },
              ),
            ),
        ],
      ),
    );
  }
}

Future<void> _changePassword(BuildContext context) async {
  final app = AppScope.read(context);
  final current = TextEditingController();
  final next = TextEditingController();
  String? error;
  var busy = false;
  final changed = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: Colors.transparent,
    barrierColor: PColors.scrim,
    isScrollControlled: true,
    builder: (context) => StatefulBuilder(
      builder: (context, setSheet) {
        Widget field(TextEditingController c, String hint) => Container(
          height: 56,
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.symmetric(horizontal: 22),
          decoration: BoxDecoration(
            color: PColors.field,
            borderRadius: BorderRadius.circular(PRadius.pill),
          ),
          alignment: Alignment.centerLeft,
          child: TextField(
            controller: c,
            obscureText: true,
            style: PType.body().copyWith(fontWeight: FontWeight.w700),
            decoration: InputDecoration(
              isCollapsed: true,
              border: InputBorder.none,
              hintText: hint,
              hintStyle: PType.body(color: PColors.muted),
            ),
          ),
        );
        return Container(
          decoration: BoxDecoration(
            color: PColors.surface,
            borderRadius: BorderRadius.vertical(
              top: Radius.circular(PRadius.sheet),
            ),
          ),
          padding: EdgeInsets.fromLTRB(
            24,
            22,
            24,
            24 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Change password', style: PType.h2()),
              const SizedBox(height: 16),
              field(current, 'Current password'),
              field(next, 'New password, at least 8 characters'),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(left: 18, bottom: 10),
                  child: Text(error!, style: PType.small(color: PColors.ink)),
                ),
              PillButton(
                label: busy ? 'Saving…' : 'Save',
                onTap: busy
                    ? null
                    : () async {
                        if (next.text.length < 8) {
                          setSheet(
                            () =>
                                error = 'Passwords have at least 8 characters.',
                          );
                          return;
                        }
                        setSheet(() => busy = true);
                        final err = await app.changePassword(
                          current.text,
                          next.text,
                        );
                        if (!context.mounted) return;
                        if (err == null) {
                          Navigator.of(context).pop(true);
                        } else {
                          setSheet(() {
                            busy = false;
                            error = err;
                          });
                        }
                      },
              ),
            ],
          ),
        );
      },
    ),
  );
  current.dispose();
  next.dispose();
  if (changed == true && context.mounted) {
    showNote(context, 'Password changed.');
  }
}

// ---------------------------------------------------------------------------
// Identity

/// The person's picture: the Pleat character they picked (the Telegram
/// photo is never used), else the initial. [nudge] puts a blue dot on it while Telegram isn't
/// verified yet (Home shows it, so the step isn't missed).
class Avatar extends StatelessWidget {
  const Avatar({
    super.key,
    required this.app,
    this.size = 56,
    this.ring = 3,
    this.nudge = false,
  });
  final AppState app;
  final double size, ring;
  final bool nudge;

  @override
  Widget build(BuildContext context) {
    final art = avatarById(app.avatarId);
    final verified = app.me.value?.telegramVerified ?? true;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: PColors.navy,
              border: Border.all(color: PColors.surface, width: ring),
              boxShadow: PShadow.soft(),
            ),
            clipBehavior: Clip.antiAlias,
            alignment: Alignment.center,
            child: art != null ? AvatarArt(art, size: size) : _initial(),
          ),
          if (nudge && !verified)
            Positioned(
              right: 0,
              top: 0,
              child: Container(
                width: size * 0.26,
                height: size * 0.26,
                decoration: BoxDecoration(
                  color: PColors.blue,
                  shape: BoxShape.circle,
                  border: Border.all(color: PColors.surface, width: 2),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _initial() => Text(
    app.firstName.substring(0, 1),
    style: size >= 64
        ? PType.h1(color: PColors.onDeep)
        : PType.h2(color: PColors.onDeep),
  );
}

/// 1. Telegram (required, verified with the bot's 6-digit code).
/// 2. Gmail (optional backup login).
class _Identity extends StatelessWidget {
  const _Identity({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final me = app.me.value;
    final verified = me?.telegramVerified ?? false;
    final email = me?.email ?? '';
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 8, 10, 8),
      child: Column(
        children: [
          _Row(
            icon: PIcon.user,
            title: verified
                ? (me!.telegramUsername.isNotEmpty
                      ? 'Telegram  @${me.telegramUsername}'
                      : 'Telegram')
                : 'Verify your Telegram',
            body: verified ? 'Verified · ID ${me!.telegramId}' : 'Required. Get a 6-digit code from our bot. Your Telegram then logs you in too.',
            trailing: verified
                ? Padding(
                    padding: EdgeInsets.only(right: 8),
                    child: PIconView(PIcon.check, color: PColors.safe),
                  )
                : _RowAction(
                    'VERIFY',
                    onTap: () async {
                      final done = await Navigator.of(context).push<bool>(
                        FadeRoute(
                          builder: (_) => const TelegramLoginScreen(link: true),
                        ),
                      );
                      if (done == true && context.mounted) {
                        showNote(context, 'Telegram verified.');
                      }
                    },
                  ),
          ),
          _Row(
            icon: PIcon.mail,
            title: email.isEmpty ? 'Add your Gmail' : email,
            fitTitle: email.isNotEmpty,
            body: email.isEmpty
                ? 'Optional. A second way to log in if Telegram is blocked.'
                : (verified ? 'Backup login · optional' : 'Your login'),
            trailing: _RowAction(
              email.isEmpty ? 'ADD' : 'CHANGE',
              onTap: () => _emailSheet(context, email, canRemove: verified),
            ),
          ),
        ],
      ),
    );
  }
}

Future<void> _emailSheet(
  BuildContext context,
  String current, {
  required bool canRemove,
}) async {
  final app = AppScope.read(context);
  final email = TextEditingController(text: current);
  final password = TextEditingController();
  String? error;
  var busy = false;
  final saved = await showModalBottomSheet<String>(
    context: context,
    backgroundColor: Colors.transparent,
    barrierColor: PColors.scrim,
    isScrollControlled: true,
    builder: (context) => StatefulBuilder(
      builder: (context, setSheet) {
        Widget field(
          TextEditingController c,
          String hint, {
          bool secret = false,
        }) => Container(
          height: 56,
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.symmetric(horizontal: 22),
          decoration: BoxDecoration(
            color: PColors.field,
            borderRadius: BorderRadius.circular(PRadius.pill),
          ),
          alignment: Alignment.centerLeft,
          child: TextField(
            controller: c,
            obscureText: secret,
            autocorrect: false,
            keyboardType: secret ? null : TextInputType.emailAddress,
            autofillHints: secret
                ? const [AutofillHints.password]
                : const [AutofillHints.email],
            style: PType.body().copyWith(fontWeight: FontWeight.w700),
            decoration: InputDecoration(
              isCollapsed: true,
              border: InputBorder.none,
              hintText: hint,
              hintStyle: PType.body(color: PColors.muted),
            ),
          ),
        );
        Future<void> submit(String value) async {
          if (password.text.isEmpty) {
            setSheet(() => error = 'Type your app password to confirm.');
            return;
          }
          setSheet(() {
            busy = true;
            error = null;
          });
          final err = await app.setEmail(value, password.text);
          if (!context.mounted) return;
          if (err == null) {
            Navigator.of(context).pop(value.isEmpty ? 'removed' : 'saved');
          } else {
            setSheet(() {
              busy = false;
              error = err;
            });
          }
        }

        return Container(
          decoration: BoxDecoration(
            color: PColors.surface,
            borderRadius: BorderRadius.vertical(
              top: Radius.circular(PRadius.sheet),
            ),
          ),
          padding: EdgeInsets.fromLTRB(
            24,
            22,
            24,
            24 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                current.isEmpty ? 'Add your Gmail' : 'Change email',
                style: PType.h2(),
              ),
              const SizedBox(height: 6),
              Text(
                'Use an address you really own. You can log in with it and your app password.',
                style: PType.small(),
              ),
              const SizedBox(height: 16),
              field(email, 'name@gmail.com'),
              field(password, 'App password', secret: true),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(left: 18, bottom: 10),
                  child: Text(error!, style: PType.small(color: PColors.ink)),
                ),
              PillButton(
                label: busy ? 'Saving…' : 'Save',
                onTap: busy
                    ? null
                    : () {
                        final v = email.text.trim();
                        if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
                            .hasMatch(v)) {
                          setSheet(() => error = 'Enter a real email address.');
                          return;
                        }
                        submit(v);
                      },
              ),
              if (canRemove && current.isNotEmpty) ...[
                const SizedBox(height: 10),
                PillButton(
                  label: 'Remove email',
                  color: PColors.field,
                  textColor: PColors.ink,
                  onTap: busy ? null : () => submit(''),
                ),
              ],
            ],
          ),
        );
      },
    ),
  );
  email.dispose();
  password.dispose();
  if (saved != null && context.mounted) {
    showNote(context, saved == 'removed' ? 'Email removed.' : 'Email saved.');
  }
}

/// Change the Pleat character. Saved on the account, so every phone shows
/// the same one. (The first pick is the required [AvatarGate].)
Future<void> _avatarSheet(BuildContext context) async {
  final app = AppScope.read(context);
  final current = app.avatarId;
  var chosen = current.isEmpty ? pleatAvatars.first.id : current;
  String? error;
  var busy = false;
  final saved = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: Colors.transparent,
    barrierColor: PColors.scrim,
    isScrollControlled: true,
    builder: (context) => StatefulBuilder(
      builder: (context, setSheet) {
        Future<void> save(String id) async {
          setSheet(() {
            busy = true;
            error = null;
          });
          final err = await app.setAvatar(id);
          if (!context.mounted) return;
          if (err == null) {
            Navigator.of(context).pop(true);
          } else {
            setSheet(() {
              busy = false;
              error = err;
            });
          }
        }

        final pick = avatarById(chosen)!;
        return Container(
          decoration: BoxDecoration(
            color: PColors.surface,
            borderRadius: BorderRadius.vertical(
              top: Radius.circular(PRadius.sheet),
            ),
          ),
          padding: EdgeInsets.fromLTRB(
            24,
            22,
            24,
            24 + MediaQuery.paddingOf(context).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Choose your avatar', style: PType.h2()),
              const SizedBox(height: 6),
              Text('Shown on Home and in your profile.', style: PType.small()),
              const SizedBox(height: 18),
              AvatarGrid(
                chosen: chosen,
                onPick: busy ? null : (id) => setSheet(() => chosen = id),
              ),
              const SizedBox(height: 20),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(left: 18, bottom: 10),
                  child: Text(error!, style: PType.small(color: PColors.ink)),
                ),
              PillButton(
                label: busy ? 'Saving…' : 'Use ${pick.name}',
                onTap: busy || chosen == current ? null : () => save(chosen),
              ),
            ],
          ),
        );
      },
    ),
  );
  if (saved == true && context.mounted) showNote(context, 'Avatar saved.');
}

/// 3. Plans (Ali's pick B, "shop shelf"): the running plan first, in navy,
/// then every plan on sale side by side, each with its own button. Data,
/// days and packages moved to Activity.
class _PlansShelf extends StatelessWidget {
  const _PlansShelf({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final sub = app.subscription;
    final me = app.me.value;
    final running = runningPlanInfo(app);
    final others = [
      for (final p in app.plans.value ?? const <PlanInfo>[])
        if (sub == null || p.name != sub.planName) p,
    ];
    final cards = <Widget>[
      if (sub != null)
        _ShelfCard(
          deep: true,
          name: sub.planName.isEmpty ? 'Your plan' : sub.planName,
          badge: sub.active ? null : sub.statusLine.toUpperCase(),
          // the plan's own size ("50 GB") when it is on sale, else what
          // the panel counts
          big: running != null
              ? planBig(running)
              : (sub.unlimitedData ? '∞' : gbText(sub.dataLimitBytes)),
          unit: sub.unlimitedData ? 'no cap' : 'GB',
          line: sub.unlimitedTime || (sub.periodDays ?? 0) <= 0
              ? 'No end date'
              : '${sub.periodDays} days',
          devices: sub.deviceLimit,
          price: running == null ? null : _short(running.priceToman),
          action: sub.active ? 'YOURS' : 'RENEW',
          done: sub.active,
          onTap: sub.active ? null : () => renewPlan(context, app),
        ),
      for (final p in others)
        () {
          final trial = p.trialDays > 0 && (me?.trialAvailable ?? false);
          return _ShelfCard(
            deep: false,
            name: p.name,
            badge: p.savePercent > 0
                ? 'SAVE ${p.savePercent}%'
                : (p.badge.isEmpty ? null : p.badge.toUpperCase()),
            big: planBig(p),
            unit: p.dataLimitGb > 0 ? 'GB' : 'no cap',
            line:
                '${trial ? p.trialDays : p.durationDays} days${trial ? ' free' : ''}',
            devices: p.deviceLimit,
            price: trial ? 'Free trial' : _short(p.priceToman),
            action: trial ? 'TRY' : 'BUY',
            onTap: me == null
                ? null
                : trial
                ? () => openPlans(context)
                : () => openCheckout(context, plan: p),
          );
        }(),
    ];
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 16, 0, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Row(
              children: [
                Expanded(child: Text('Plans', style: PType.h3())),
                Pressable(
                  onTap: () => openPlans(context),
                  label: 'All plans',
                  radius: PRadius.pill,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 6,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'All plans',
                          style: PType.small(color: PColors.accentInk)
                              .copyWith(fontWeight: FontWeight.w800),
                        ),
                        PIconView(
                          PIcon.chevron,
                          size: 16,
                          color: PColors.accentInk,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          if (cards.isEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 20, bottom: 4),
              child: Text(
                app.plans.loading
                    ? 'Loading plans…'
                    : (app.plans.error ?? 'No plans on sale right now.'),
                style: PType.small(),
              ),
            )
          else
            SizedBox(
              height: 204,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.only(right: 20),
                itemCount: cards.length,
                separatorBuilder: (_, _) => const SizedBox(width: 10),
                itemBuilder: (_, i) => cards[i],
              ),
            ),
        ],
      ),
    );
  }

  /// 189000 → "189,000 T": the card is narrow, the full word is on checkout.
  static String _short(int v) => '${grouped(v)} T';
}

class _ShelfCard extends StatelessWidget {
  const _ShelfCard({
    required this.deep,
    required this.name,
    required this.badge,
    required this.big,
    required this.unit,
    required this.line,
    required this.devices,
    required this.price,
    required this.action,
    required this.onTap,
    this.done = false,
  });
  final bool deep, done;
  final String name, big, unit, line, action;
  final int devices;
  final String? badge, price;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ink = deep ? PColors.onDeep : PColors.ink;
    final soft = deep ? PColors.onDeep.withValues(alpha: 0.82) : PColors.muted;
    return Container(
      // narrow enough that the third card peeks: the shelf scrolls
      width: 138,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: deep ? PColors.navy : PColors.field,
        borderRadius: BorderRadius.circular(22),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            name,
            style: PType.small(color: ink)
                .copyWith(fontWeight: FontWeight.w800),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: 20,
            child: badge == null
                ? null
                : Align(
                    alignment: Alignment.centerLeft,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 7,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: deep
                            ? PColors.onDeep.withValues(alpha: 0.18)
                            : PColors.navy,
                        borderRadius: BorderRadius.circular(PRadius.pill),
                      ),
                      child: Text(
                        badge!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: PType.tab(color: PColors.onDeep),
                      ),
                    ),
                  ),
          ),
          const SizedBox(height: 2),
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: big,
                  style: PType.display(28, color: ink),
                ),
                TextSpan(
                  text: ' $unit',
                  style: PType.meta(color: soft),
                ),
              ],
            ),
            maxLines: 1,
          ),
          for (final t in [line, '$devices device${devices == 1 ? '' : 's'}'])
            Text(
              t,
              style: PType.meta(color: soft),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          const Spacer(),
          if (price != null)
            Text(
              price!,
              style: PType.small(color: ink)
                  .copyWith(fontWeight: FontWeight.w800),
              maxLines: 1,
            ),
          const SizedBox(height: 8),
          Pressable(
            onTap: onTap,
            label: '$action $name',
            radius: PRadius.pill,
            color: deep
                ? PColors.onDeep.withValues(alpha: 0.16)
                : PColors.surface,
            child: SizedBox(
              height: 36,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (done) ...[
                    PIconView(PIcon.check, size: 14, color: ink),
                    const SizedBox(width: 4),
                  ],
                  Text(
                    action,
                    style: PType.button(
                      color: deep
                          ? PColors.onDeep
                          : (onTap == null ? PColors.muted : PColors.accentInk),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
