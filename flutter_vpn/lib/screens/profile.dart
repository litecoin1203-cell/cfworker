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
import 'check.dart';
import 'login.dart';
import 'plans.dart';
import 'store_kit.dart';
import 'wallet.dart';
import 'states.dart';

/// Profile, opened from the avatar or the name on Home. From the top: who
/// the person is (Telegram first, required; Gmail second, optional), what
/// is left on the plan (animated), every package they've had, then the
/// account rows. Sign out clears the tokens and returns to Login.
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
      final app = AppScope.read(context);
      app.loadPackages();
      if (app.photo == null) app.loadPhoto();
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
            onRefresh: () => Future.wait([
              app.loadMe(),
              app.loadPackages(),
              app.loadPhoto(),
            ]),
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
                                _Chip('VERIFIED', color: PColors.safe),
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
                _UsageCard(app: app),
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
                const SizedBox(height: 16),
                Center(
                  child: Text(
                    [
                      'Pleat 1.2',
                      app.tunnelAvailable == true
                          ? 'tunnel engine on'
                          : 'no tunnel engine in this build',
                    ].join('  ·  '),
                    style: PType.meta(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
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
// Identity, usage and packages

const _gib = 1073741824; // the Worker counts plans in GiB: "50 GB" is 50 × 2^30

String _gb(int bytes) {
  final v = bytes / _gib;
  return v >= 100 ? v.toStringAsFixed(0) : v.toStringAsFixed(1);
}

const _months = [
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

String _day(DateTime d, {bool year = true}) {
  final l = d.toLocal();
  return '${_months[l.month - 1]} ${l.day}${year ? ', ${l.year}' : ''}';
}

/// The person's picture: the Pleat character they picked, else their
/// Telegram photo through the Worker, else the initial. [nudge] puts a blue dot on it while Telegram isn't
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
    final photo = app.photo;
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
            child: art != null
                ? AvatarArt(art, size: size)
                : photo != null
                ? Image.memory(
                    photo,
                    width: size,
                    height: size,
                    fit: BoxFit.cover,
                    gaplessPlayback: true,
                    errorBuilder: (_, _, _) => _initial(),
                  )
                : _initial(),
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

class _Chip extends StatelessWidget {
  const _Chip(this.text, {Color? color}) : _color = color;
  final String text;
  final Color? _color;
  Color get color => _color ?? PColors.blue;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(PRadius.pill),
    ),
    child: Text(text, style: PType.tab(color: color)),
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

/// Pick one of the Pleat characters, or go back to the Telegram photo or
/// the initial. Saved on the account, so every phone shows the same one.
Future<void> _avatarSheet(BuildContext context) async {
  final app = AppScope.read(context);
  final current = app.avatarId;
  var chosen = current.isEmpty ? pleatAvatars.first.id : current;
  String? error;
  var busy = false;
  final saved = await showModalBottomSheet<String>(
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
            Navigator.of(context).pop(id.isEmpty ? 'cleared' : 'saved');
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
              LayoutBuilder(
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
                          onTap: busy
                              ? null
                              : () => setSheet(() => chosen = a.id),
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
              if (current.isNotEmpty) ...[
                const SizedBox(height: 10),
                PillButton(
                  label: app.photo != null
                      ? 'Use my Telegram photo'
                      : 'Use my initial',
                  color: PColors.field,
                  textColor: PColors.accentInk,
                  onTap: busy ? null : () => save(''),
                ),
              ],
            ],
          ),
        );
      },
    ),
  );
  if (saved != null && context.mounted) {
    showNote(context, saved == 'cleared' ? 'Avatar removed.' : 'Avatar saved.');
  }
}

/// 3. The plan, in one compact card: its name and state, and one line
/// with what is left. Tapping that line opens a sheet from below with the
/// data, the days and every package, so the profile itself stays short.
class _UsageCard extends StatelessWidget {
  const _UsageCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final sub = app.subscription;
    void plans() =>
        Navigator.of(context)
            .push(FadeRoute(builder: (_) => const PlansScreen()));
    if (sub == null) {
      return SurfaceCard(
        onTap: plans,
        label: 'Plans',
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    app.me.loading ? 'Loading your plan…' : 'No plan yet',
                    style: PType.h3(),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    app.me.value?.trialAvailable ?? false
                        ? 'Free trial available'
                        : 'See plans',
                    style: PType.small(),
                  ),
                ],
              ),
            ),
            PIconView(PIcon.chevron, color: PColors.muted),
          ],
        ),
      );
    }
    final left = sub.unlimitedData
        ? 0
        : (sub.dataLimitBytes - sub.usedBytes).clamp(0, sub.dataLimitBytes);
    final dataFrac = sub.unlimitedData
        ? 1.0
        : (sub.dataLimitBytes == 0 ? 0.0 : left / sub.dataLimitBytes);
    final days = sub.daysLeft ?? 0;
    final period = (sub.periodDays ?? 0) > 0 ? sub.periodDays! : 30;
    final stopped = !sub.active;
    Widget detail() => _PleatsAndDots(
      dataFrac: dataFrac,
      leftGb: sub.unlimitedData ? null : left / _gib,
      limitGb: sub.dataLimitBytes / _gib,
      days: sub.unlimitedTime ? null : days,
      period: period,
      ends: sub.expiresAt,
      reduce: app.reduceMotion || PMotion.reduced(context),
      muted: stopped,
    );
    final summary = [
      sub.unlimitedData ? 'No data cap' : '${_gb(left)} GB left',
      sub.unlimitedTime ? 'no end date' : '$days days left',
    ].join('  ·  ');
    // Data, days and every package, in a sheet from below (Ali's pick).
    // It follows the app, so packages that arrive late still show.
    void openIt() => showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.transparent,
      barrierColor: PColors.scrim,
      isScrollControlled: true,
      builder: (context) => ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.88,
        ),
        child: Container(
          decoration: BoxDecoration(
            color: PColors.surface,
            borderRadius: BorderRadius.vertical(
              top: Radius.circular(PRadius.sheet),
            ),
          ),
          child: ListenableBuilder(
            listenable: app,
            builder: (context, _) => SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(24, 14, 24, 28),
              child: Column(
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
                  const SizedBox(height: 16),
                  Text(
                    sub.planName.isEmpty ? 'Your plan' : sub.planName,
                    style: PType.h2(),
                  ),
                  const SizedBox(height: 18),
                  detail(),
                  const SizedBox(height: 22),
                  Divider(height: 1, thickness: 1.2, color: PColors.field),
                  const SizedBox(height: 16),
                  _Packages(app: app, bare: true),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 16, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  sub.planName.isEmpty ? 'Your plan' : sub.planName,
                  style: PType.h3(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              _Chip(
                sub.statusLine.toUpperCase(),
                color: stopped ? PColors.alert : PColors.safe,
              ),
              const SizedBox(width: 8),
              _RowAction(stopped ? 'RENEW' : 'PLANS', onTap: plans),
            ],
          ),
          const SizedBox(height: 6),
          Pressable(
            onTap: openIt,
            label: 'Data and days left',
            radius: 20,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(0, 10, 8, 6),
              child: Row(
                children: [
                  PIconView(PIcon.chart, color: PColors.accentInk),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Data and days',
                          style: PType.h3().copyWith(fontSize: 15),
                        ),
                        const SizedBox(height: 2),
                        Text(summary, style: PType.small()),
                      ],
                    ),
                  ),
                  PIconView(PIcon.chevron, color: PColors.muted),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Data and days, the way Ali picked (style 4): slanted pleats rise for
/// the data left, and each day of the package is a dot (navy = still
/// ahead). Numbers count up with them; Reduce motion shows the end state.
class _PleatsAndDots extends StatefulWidget {
  const _PleatsAndDots({
    required this.dataFrac,
    required this.leftGb,
    required this.limitGb,
    required this.days,
    required this.period,
    required this.ends,
    required this.reduce,
    required this.muted,
  });
  final double dataFrac, limitGb;

  /// null = no data cap / no end date.
  final double? leftGb;
  final int? days;
  final int period;
  final DateTime? ends;
  final bool reduce, muted;

  @override
  State<_PleatsAndDots> createState() => _PleatsAndDotsState();
}

class _PleatsAndDotsState extends State<_PleatsAndDots>
    with SingleTickerProviderStateMixin {
  static const _pleats = 20;
  static const _maxDots = 60;
  late final _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );

  @override
  void initState() {
    super.initState();
    widget.reduce ? _c.value = 1 : _c.forward();
  }

  @override
  void didUpdateWidget(_PleatsAndDots old) {
    super.didUpdateWidget(old);
    if (old.dataFrac != widget.dataFrac || old.days != widget.days) {
      widget.reduce ? _c.value = 1 : _c.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// 0..1 progress of one item that starts at [start] (0..1 of the run)
  /// and takes [span] of it.
  double _at(double start, double span) =>
      ((_c.value - start) / span).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    final w = widget;
    // a long package gets one dot per few days, so the grid stays small
    final perDot = (w.period / _maxDots).ceil().clamp(1, 1 << 20);
    final dots = (w.period / perDot).ceil();
    final aheadDots = w.days == null ? dots : (w.days! / perDot).ceil();
    final lit = (w.dataFrac * _pleats).round();
    final blue = w.muted ? PColors.muted : PColors.blue;
    final deep = w.muted ? PColors.muted : PColors.pressed;
    final navy = w.muted ? PColors.ice : PColors.navy;
    return Semantics(
      label: [
        w.leftGb == null
            ? 'No data cap'
            : '${w.leftGb!.toStringAsFixed(1)} GB left of ${w.limitGb.toStringAsFixed(0)}',
        w.days == null ? 'no end date' : '${w.days} of ${w.period} days left',
      ].join(', '),
      excludeSemantics: true,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final count = Curves.easeOutCubic.transform(_at(0, 0.8));
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _bigRow(
                'DATA LEFT',
                w.leftGb == null ? '∞' : (w.leftGb! * count).toStringAsFixed(1),
                w.leftGb == null ? '' : ' GB',
                w.leftGb == null
                    ? 'No data cap'
                    : 'of ${w.limitGb.toStringAsFixed(0)} GB',
              ),
              const SizedBox(height: 14),
              SizedBox(
                height: 60,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    for (var i = 0; i < _pleats; i++) ...[
                      if (i > 0) const SizedBox(width: 5),
                      Expanded(
                        child: Transform(
                          alignment: Alignment.bottomCenter,
                          transform: Matrix4.skewX(-0.21)
                            ..scaleByDouble(
                              1,
                              i < lit
                                  ? 0.35 +
                                        0.65 *
                                            Curves.easeOutBack.transform(
                                              _at(i * 0.025, 0.3),
                                            )
                                  : 0.35,
                              1,
                              1,
                            ),
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: i < lit && _at(i * 0.025, 0.3) > 0
                                  ? (i.isOdd ? blue : deep)
                                  : PColors.mist,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const SizedBox.expand(),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 18),
              Divider(height: 1, thickness: 1.2, color: PColors.field),
              const SizedBox(height: 16),
              _bigRow(
                'DAYS LEFT',
                w.days == null ? '∞' : '${(w.days! * count).round()}',
                w.days == null ? '' : ' of ${w.period}',
                w.days == null || w.ends == null
                    ? 'No end date'
                    : 'Ends ${_day(w.ends!, year: false)}',
              ),
              const SizedBox(height: 14),
              LayoutBuilder(
                builder: (context, box) {
                  const cols = 10, gap = 7.0;
                  final size = (box.maxWidth - gap * (cols - 1)) / cols;
                  return Wrap(
                    spacing: gap,
                    runSpacing: gap,
                    children: [
                      for (var i = 0; i < dots; i++)
                        () {
                          final t = _at(0.15 + i * (0.5 / dots), 0.25);
                          final ahead = i >= dots - aheadDots;
                          return Transform.scale(
                            scale: 0.4 + 0.6 * Curves.easeOutBack.transform(t),
                            child: Container(
                              width: size,
                              height: size,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: t == 0
                                    ? PColors.field
                                    : (ahead ? navy : PColors.mist),
                              ),
                            ),
                          );
                        }(),
                    ],
                  );
                },
              ),
              if (perDot > 1) ...[
                const SizedBox(height: 8),
                Text('Each dot is $perDot days.', style: PType.meta()),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _bigRow(String label, String number, String unit, String side) => Row(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: PType.tab()),
            const SizedBox(height: 8),
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: number, style: PType.display(44)),
                  TextSpan(
                    text: unit,
                    style: PType.body(color: PColors.muted)
                        .copyWith(fontSize: 18, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      Text(side, style: PType.meta()),
    ],
  );
}

/// 4. Every package, newest first: when it was bought and when it started.
class _Packages extends StatelessWidget {
  const _Packages({required this.app, this.bare = false});
  final AppState app;

  /// Inside the Data and days sheet: no card of its own.
  final bool bare;

  @override
  Widget build(BuildContext context) {
    final list = app.packages.value ?? const <Package>[];
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text('Packages', style: PType.h3())),
            if (list.isNotEmpty) Text('${list.length}', style: PType.meta()),
          ],
        ),
        if (list.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Text(
              app.packages.loading
                  ? 'Loading your packages…'
                  : (app.packages.error ?? 'No packages yet.'),
              style: PType.small(),
            ),
          ),
        for (var i = 0; i < list.length; i++)
          StaggerIn(
            index: i,
            child: _PackageRow(p: list[i], first: i == 0),
          ),
      ],
    );
    if (bare) return body;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
      child: body,
    );
  }
}

class _PackageRow extends StatelessWidget {
  const _PackageRow({required this.p, required this.first});
  final Package p;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final dates = [
      if (p.purchasedAt != null)
        'Bought ${_day(p.purchasedAt!, year: p.activatedAt == null)}',
      if (p.activatedAt != null) 'Activated ${_day(p.activatedAt!)}',
    ].join('  ·  ');
    final facts = [
      if (p.source != 'order') p.sourceLabel,
      p.dataLimitBytes > 0 ? '${_gb(p.dataLimitBytes)} GB' : 'No data cap',
      if (p.amountToman != null && p.amountToman! > 0) toman(p.amountToman!),
    ].join('  ·  ');
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 11),
      decoration: BoxDecoration(
        border: first
            ? null
            : Border(top: BorderSide(color: PColors.field, width: 1.2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: p.current ? PColors.blue : PColors.mist,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Text(
              p.days == null ? '∞' : '${p.days}d',
              style: PType.meta(
                color: p.current ? PColors.onAccent : PColors.accentInk,
              ).copyWith(fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        p.name,
                        style: PType.h3().copyWith(fontSize: 15),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    _Chip(
                      p.stateLabel.toUpperCase(),
                      color: p.current ? PColors.safe : PColors.muted,
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(dates, style: PType.small()),
                const SizedBox(height: 1),
                Text(facts, style: PType.meta()),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
