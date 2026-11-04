import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
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
            color: PColors.blue,
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
                    Avatar(app: app, size: 72, ring: 4),
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
                                child: Text(
                                  handle,
                                  style: PType.small(),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              if (tgVerified) ...[
                                const SizedBox(width: 8),
                                const _Chip('VERIFIED', color: PColors.safe),
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
                _Packages(app: app),
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
                  color: Colors.white,
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

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.title,
    required this.body,
    required this.trailing,
  });
  final PIcon icon;
  final String title, body;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          PIconView(icon, color: PColors.blue),
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
          const SizedBox(width: 8),
          trailing,
        ],
      ),
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
              color: onTap == null ? PColors.muted : PColors.blue,
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
    barrierColor: PColors.navy.withValues(alpha: 0.28),
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
          decoration: const BoxDecoration(
            color: Colors.white,
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

/// The person's picture: their Telegram photo through the Worker, else
/// the initial. [nudge] puts a blue dot on it while Telegram isn't
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
              border: Border.all(color: Colors.white, width: ring),
              boxShadow: PShadow.soft(),
            ),
            clipBehavior: Clip.antiAlias,
            alignment: Alignment.center,
            child: photo != null
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
                  border: Border.all(color: Colors.white, width: 2),
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
        ? PType.h1(color: Colors.white)
        : PType.h2(color: Colors.white),
  );
}

class _Chip extends StatelessWidget {
  const _Chip(this.text, {this.color = PColors.blue});
  final String text;
  final Color color;

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
                ? const Padding(
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
    barrierColor: PColors.navy.withValues(alpha: 0.28),
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
          decoration: const BoxDecoration(
            color: Colors.white,
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

/// 3. What is left on the plan: data and days, animated in when the
/// screen opens and again whenever the numbers change.
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
            const PIconView(PIcon.chevron, color: PColors.muted),
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
    final timeFrac = sub.unlimitedTime ? 1.0 : (days / period).clamp(0.0, 1.0);
    final stopped = !sub.active;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      child: Column(
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
            ],
          ),
          const SizedBox(height: 8),
          _Rings(
            dataFrac: dataFrac,
            timeFrac: timeFrac,
            leftGb: sub.unlimitedData ? null : left / _gib,
            limitGb: sub.dataLimitBytes / _gib,
            days: sub.unlimitedTime ? null : days,
            reduce: app.reduceMotion || PMotion.reduced(context),
            muted: stopped,
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        _dot(PColors.blue),
                        const SizedBox(width: 6),
                        Text('DATA', style: PType.tab()),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      sub.unlimitedData
                          ? 'No data cap'
                          : '${_gb(sub.usedBytes)} GB used',
                      style: PType.small(),
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Row(
                    children: [
                      _dot(PColors.navy),
                      const SizedBox(width: 6),
                      Text('TIME', style: PType.tab()),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    sub.unlimitedTime || sub.expiresAt == null
                        ? 'No end date'
                        : 'Ends ${_day(sub.expiresAt!)}',
                    style: PType.small(),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 14),
          PillButton(
            label: stopped ? 'Renew' : 'Plans',
            icon: PIcon.ticket,
            color: stopped ? PColors.blue : PColors.field,
            textColor: stopped ? Colors.white : PColors.ink,
            onTap: plans,
          ),
        ],
      ),
    );
  }

  static Widget _dot(Color c) => Container(
    width: 8,
    height: 8,
    decoration: BoxDecoration(color: c, shape: BoxShape.circle),
  );
}

/// Twin rings: outer = data left, inner = days left. Both sweep in from
/// zero and the numbers count up with them.
class _Rings extends StatefulWidget {
  const _Rings({
    required this.dataFrac,
    required this.timeFrac,
    required this.leftGb,
    required this.limitGb,
    required this.days,
    required this.reduce,
    required this.muted,
  });
  final double dataFrac, timeFrac, limitGb;

  /// null = no data cap / no end date.
  final double? leftGb;
  final int? days;
  final bool reduce, muted;

  @override
  State<_Rings> createState() => _RingsState();
}

class _RingsState extends State<_Rings> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1500),
  );

  @override
  void initState() {
    super.initState();
    widget.reduce ? _c.value = 1 : _c.forward();
  }

  @override
  void didUpdateWidget(_Rings old) {
    super.didUpdateWidget(old);
    if (old.dataFrac != widget.dataFrac || old.timeFrac != widget.timeFrac) {
      widget.reduce ? _c.value = 1 : _c.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final w = widget;
    final label = [
      w.leftGb == null
          ? 'No data cap'
          : '${w.leftGb!.toStringAsFixed(1)} GB left of ${w.limitGb.toStringAsFixed(0)}',
      w.days == null ? 'no end date' : '${w.days} days left',
    ].join(', ');
    return Semantics(
      label: label,
      excludeSemantics: true,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final data = Curves.easeOutCubic.transform(_c.value);
          final time = Curves.easeOutCubic.transform(
            ((_c.value - 0.15) / 0.85).clamp(0.0, 1.0),
          );
          return SizedBox(
            width: 230,
            height: 230,
            child: CustomPaint(
              painter: _RingPainter(
                data: w.dataFrac * data,
                time: w.timeFrac * time,
                muted: w.muted,
              ),
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      w.leftGb == null
                          ? '∞'
                          : (w.leftGb! * data).toStringAsFixed(1),
                      style: PType.display(44),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      w.leftGb == null
                          ? 'NO DATA CAP'
                          : 'GB LEFT OF ${w.limitGb.toStringAsFixed(0)}',
                      style: PType.tab(),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      w.days == null
                          ? 'No end date'
                          : '${(w.days! * time).round()} days left',
                      style: PType.small(color: PColors.navy)
                          .copyWith(fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.data, required this.time, required this.muted});
  final double data, time;
  final bool muted;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    void ring(double r, double stroke, Color track, Color fill, double frac) {
      final p = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeCap = StrokeCap.round;
      canvas.drawCircle(c, r, p..color = track);
      if (frac <= 0) return;
      canvas.drawArc(
        Rect.fromCircle(center: c, radius: r),
        -1.5707963,
        6.2831853 * frac.clamp(0.0, 1.0),
        false,
        p..color = fill,
      );
    }

    final r = size.shortestSide / 2;
    ring(r - 9, 16, PColors.mist, muted ? PColors.muted : PColors.blue, data);
    ring(r - 33, 11, PColors.field, muted ? PColors.ice : PColors.navy, time);
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.data != data || old.time != time || old.muted != muted;
}

/// 4. Every package, newest first: when it was bought and when it started.
class _Packages extends StatelessWidget {
  const _Packages({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final list = app.packages.value ?? const <Package>[];
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
      child: Column(
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
      ),
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
            : const Border(top: BorderSide(color: PColors.field, width: 1.2)),
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
              style: PType.meta(color: p.current ? Colors.white : PColors.blue)
                  .copyWith(fontWeight: FontWeight.w700),
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
