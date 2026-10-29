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

/// Profile, opened from the avatar: the account, plan and devices from the
/// backend. Sign out clears the tokens and returns to Login.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final sub = app.subscription;
    return Scaffold(
      backgroundColor: PColors.ground,
      body: ShardBackdrop(
        layout: Layouts.profile,
        child: SafeArea(
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
                  Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: PColors.navy,
                      border: Border.all(color: Colors.white, width: 4),
                      boxShadow: PShadow.soft(),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      app.firstName.substring(0, 1),
                      style: PType.h1(color: Colors.white),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(app.firstName, style: PType.h2()),
                        const SizedBox(height: 2),
                        Text(
                          app.email,
                          style: PType.small(),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 22),
              SurfaceCard(
                onTap: () =>
                    Navigator.of(context)
                        .push(FadeRoute(builder: (_) => const PlansScreen())),
                label: 'Plans',
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      decoration: const BoxDecoration(
                        color: PColors.mist,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: const PIconView(PIcon.ticket, color: PColors.blue),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            sub == null ? 'No plan yet' : sub.planName,
                            style: PType.h3(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            sub == null
                                ? (app.me.value?.trialAvailable ?? false
                                      ? 'Free trial available'
                                      : 'See plans')
                                : [
                                    sub.statusLine,
                                    if (!sub.unlimitedTime)
                                      '${sub.daysLeft ?? 0} days left',
                                    '${sub.deviceLimit} device${sub.deviceLimit == 1 ? '' : 's'}',
                                  ].join('  ·  '),
                            style: PType.small(),
                          ),
                        ],
                      ),
                    ),
                    const PIconView(PIcon.chevron, color: PColors.muted),
                  ],
                ),
              ),
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
                        onTap: () => Navigator.of(
                          context,
                        ).push(FadeRoute(builder: (_) => const WalletScreen())),
                      ),
                    ),
                    _Row(
                      icon: PIcon.chart,
                      title: 'Payments',
                      body: 'Orders, receipts and their status.',
                      trailing: _RowAction(
                        'OPEN',
                        onTap: () => Navigator.of(
                          context,
                        ).push(FadeRoute(builder: (_) => const OrdersScreen())),
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
                        onTap: () => Navigator.of(
                          context,
                        ).push(FadeRoute(builder: (_) => const InviteScreen())),
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
                        onTap: () => Navigator.of(
                          context,
                        ).push(FadeRoute(builder: (_) => const CheckScreen())),
                      ),
                    ),
                    _Row(
                      icon: PIcon.pulse,
                      title: 'Reduce motion',
                      body:
                          'Shards and orbits hold still. States still change.',
                      trailing: PToggle(
                        value: app.reduceMotion,
                        onChanged: (v) => app.update((s) => s.reduceMotion = v),
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
