import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/backdrop.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../api/models.dart';
import 'shell.dart';

/// Confirm: the password step for the email from Login, in the same card,
/// and the backend's free trial in the reference's discount-card anatomy.
/// The Worker signs in by email + password; there is no code to resend.
class ConfirmScreen extends StatefulWidget {
  const ConfirmScreen({super.key, required this.address});
  final String address;

  @override
  State<ConfirmScreen> createState() => _ConfirmScreenState();
}

class _ConfirmScreenState extends State<ConfirmScreen> {
  final _password = TextEditingController();
  final _invite = TextEditingController();
  bool _create = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    _invite.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final pw = _password.text;
    if (pw.length < 8) {
      setState(() => _error = 'Passwords have at least 8 characters.');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    final app = AppScope.read(context);
    final err = await app.signIn(
      widget.address,
      pw,
      create: _create,
      invite: _create ? _invite.text.trim() : '',
    );
    if (!mounted) return;
    if (err != null) {
      setState(() {
        _busy = false;
        _error = err;
      });
      return;
    }
    Navigator.of(context).pushAndRemoveUntil(
      FadeRoute(builder: (_) => const Shell()),
      (_) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final trial = (app.plans.value ?? const <PlanInfo>[])
        .where((p) => p.trialDays > 0)
        .firstOrNull;
    return Scaffold(
      backgroundColor: PColors.ground,
      body: ShardBackdrop(
        layout: Layouts.confirm,
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: RoundIcon(
                  PIcon.back,
                  onTap: () => Navigator.of(context).pop(),
                  label: 'Back',
                ),
              ),
              const SizedBox(height: 18),
              SurfaceCard(
                padding: const EdgeInsets.fromLTRB(24, 26, 24, 22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 48,
                          height: 48,
                          decoration: const BoxDecoration(
                            color: PColors.mist,
                            shape: BoxShape.circle,
                          ),
                          alignment: Alignment.center,
                          child: const PIconView(
                            PIcon.lock,
                            color: PColors.blue,
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Text(
                            _create ? 'Create your account' : 'Your password',
                            style: PType.h2(),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text.rich(
                      TextSpan(
                        style: PType.body(color: PColors.muted),
                        children: [
                          TextSpan(
                            text: _create
                                ? 'New account for '
                                : 'Signing in as ',
                          ),
                          TextSpan(
                            text: widget.address,
                            style: PType.body().copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const TextSpan(text: '.'),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    Container(
                      height: 56,
                      padding: const EdgeInsets.symmetric(horizontal: 22),
                      decoration: BoxDecoration(
                        color: PColors.field,
                        borderRadius: BorderRadius.circular(PRadius.pill),
                      ),
                      alignment: Alignment.centerLeft,
                      child: TextField(
                        controller: _password,
                        obscureText: true,
                        autofillHints: [
                          _create
                              ? AutofillHints.newPassword
                              : AutofillHints.password,
                        ],
                        textInputAction: TextInputAction.go,
                        onSubmitted: (_) => _submit(),
                        style: PType.body().copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                        decoration: InputDecoration(
                          isCollapsed: true,
                          border: InputBorder.none,
                          hintText: _create
                              ? 'At least 8 characters'
                              : 'Password',
                          hintStyle: PType.body(color: PColors.muted),
                        ),
                      ),
                    ),
                    AnimatedSize(
                      duration: PMotion.reduced(context)
                          ? Duration.zero
                          : PMotion.quick,
                      child: !_create
                          ? const SizedBox(width: double.infinity)
                          : Container(
                              height: 56,
                              margin: const EdgeInsets.only(top: 12),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 22,
                              ),
                              decoration: BoxDecoration(
                                color: PColors.field,
                                borderRadius: BorderRadius.circular(
                                  PRadius.pill,
                                ),
                              ),
                              alignment: Alignment.centerLeft,
                              child: TextField(
                                controller: _invite,
                                textCapitalization:
                                    TextCapitalization.characters,
                                autocorrect: false,
                                style: PType.body().copyWith(
                                  fontWeight: FontWeight.w700,
                                ),
                                decoration: InputDecoration(
                                  isCollapsed: true,
                                  border: InputBorder.none,
                                  hintText: 'Invite code (optional)',
                                  hintStyle: PType.body(color: PColors.muted),
                                ),
                              ),
                            ),
                    ),
                    AnimatedSize(
                      duration: PMotion.reduced(context)
                          ? Duration.zero
                          : PMotion.quick,
                      child: _error == null
                          ? const SizedBox(width: double.infinity)
                          : Padding(
                              padding: const EdgeInsets.only(top: 10, left: 18),
                              child: Text(
                                _error!,
                                style: PType.small(color: PColors.ink),
                              ),
                            ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        const PIconView(
                          PIcon.user,
                          size: 18,
                          color: PColors.muted,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _create ? 'Have an account?' : 'New to Pleat?',
                            style: PType.small(),
                          ),
                        ),
                        Pressable(
                          onTap: _busy
                              ? null
                              : () => setState(() {
                                  _create = !_create;
                                  _error = null;
                                }),
                          label: _create ? 'Sign in instead' : 'Create account',
                          radius: 20,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 14,
                            ),
                            child: Text(
                              _create ? 'Sign in' : 'Create account',
                              style: PType.small(color: PColors.blue)
                                  .copyWith(fontWeight: FontWeight.w700),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              // The trial slab overlaps the card and leaves the column, like the
              // reference's discount card riding over the confirm sheet.
              if (trial != null)
                Transform.translate(
                  offset: const Offset(12, -10),
                  child: OfferCard(
                    title: 'Free trial',
                    big: '${trial.trialDays}',
                    unit: 'days of every exit,\nno card needed',
                    footer:
                        '${trial.name}  ·  start it in Plans after you sign in',
                  ),
                ),
              const SizedBox(height: 18),
              PillButton(
                label: _busy
                    ? (_create ? 'Creating…' : 'Signing in…')
                    : (_create ? 'Create account' : 'Sign in'),
                onTap: _busy ? null : _submit,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
