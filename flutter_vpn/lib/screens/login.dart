import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/icons.dart';
import '../design/mark.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'shell.dart';
import 'states.dart';

/// Sign in and Create account: one screen, two tabs on a sheet that rises
/// over the navy plane header. Under the form sit the quick sign-in tiles
/// (Telegram, Gmail).
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, this.initialTab = 0});

  /// 0 = Sign in, 1 = Create account.
  final int initialTab;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  late int _tab = widget.initialTab;
  final _login = TextEditingController();
  final _password = TextEditingController();
  final _email = TextEditingController();
  final _newPassword = TextEditingController();
  final _again = TextEditingController();
  final _invite = TextEditingController();
  final _loginFocus = FocusNode();
  final _emailFocus = FocusNode();
  bool _showInvite = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [
      _login,
      _password,
      _email,
      _newPassword,
      _again,
      _invite,
    ]) {
      c.dispose();
    }
    _loginFocus.dispose();
    _emailFocus.dispose();
    super.dispose();
  }

  /// Email, Telegram @username (with or without @) or numeric Telegram id.
  static final _loginRe = RegExp(
    r'^([^@\s]+@[^@\s]+\.[^@\s]+|@?[A-Za-z][A-Za-z0-9_]{3,31}|\d{1,20})$',
  );
  static final _emailRe = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

  void _setTab(int t) {
    if (t == _tab || _busy) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _tab = t;
      _error = null;
    });
  }

  Future<void> _submit() async {
    if (_busy) return;
    final create = _tab == 1;
    final address = (create ? _email : _login).text.trim();
    final pw = (create ? _newPassword : _password).text;
    String? problem;
    if (create && !_emailRe.hasMatch(address)) {
      problem = 'Enter a valid email address.';
    } else if (!create && !_loginRe.hasMatch(address)) {
      problem = 'Enter your email, Telegram @username or Telegram ID.';
    } else if (pw.length < 8) {
      problem = 'Passwords have at least 8 characters.';
    } else if (create && pw != _again.text) {
      problem = 'The two passwords don’t match.';
    }
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await AppScope.read(context).signIn(
      address,
      pw,
      create: create,
      invite: create ? _invite.text.trim() : '',
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

  void _telegram() {
    FocusScope.of(context).unfocus();
    Navigator.of(context)
        .push(FadeRoute(builder: (_) => const TelegramLoginScreen()));
  }

  /// Gmail: a Gmail address and password sign in like any email account.
  /// (One-tap Google sign-in needs a Google OAuth client first.)
  void _gmail() {
    final create = _tab == 1;
    (create ? _emailFocus : _loginFocus).requestFocus();
    showNote(
      context,
      create
          ? 'Type your Gmail address and pick a password.'
          : 'Type your Gmail address and your Pleat password.',
    );
  }

  Future<void> _forgot() async {
    FocusScope.of(context).unfocus();
    final telegram = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      barrierColor: PColors.scrim,
      builder: (context) => Container(
        decoration: BoxDecoration(
          color: PColors.surface,
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(PRadius.sheet),
          ),
        ),
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 28),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Center(child: _Handle()),
              Text('Forgot your password?', style: PType.h2()),
              const SizedBox(height: 10),
              Text(
                'If your account has a Telegram account, sign in with a code '
                'from our bot instead. No Telegram on your account? Message '
                'support in our Telegram bot and we’ll reset it.',
                style: PType.body(color: PColors.muted),
              ),
              const SizedBox(height: 20),
              _BrandButton(
                asset: 'telegram',
                label: 'Sign in with Telegram',
                onTap: () => Navigator.of(context).pop(true),
              ),
            ],
          ),
        ),
      ),
    );
    if (telegram == true && mounted) _telegram();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final top = MediaQuery.paddingOf(context).top;
    final reduced = PMotion.reduced(context);
    final trial = (app.plans.value ?? const <PlanInfo>[])
        .where((p) => p.trialDays > 0)
        .firstOrNull;
    final create = _tab == 1;
    const sheetTop = 196.0;
    return Scaffold(
      backgroundColor: PColors.navy,
      resizeToAvoidBottomInset: true,
      body: Stack(
        children: [
          Positioned(
            left: 0,
            right: 0,
            top: 0,
            height: top + sheetTop + 80,
            child: CustomPaint(painter: _PlaneHeader()),
          ),
          LayoutBuilder(
            builder: (context, box) => SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: box.maxHeight),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(
                      height: top + sheetTop,
                      child: Padding(
                        padding: EdgeInsets.fromLTRB(28, top + 14, 120, 0),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                PleatMark(size: 22, colors: MarkColors.onDark),
                                const SizedBox(width: 8),
                                Text(
                                  'Pleat',
                                  style: PType.h3(color: PColors.onDeep),
                                ),
                              ],
                            ),
                            const SizedBox(height: 22),
                            AnimatedSwitcher(
                              duration: reduced ? Duration.zero : PMotion.quick,
                              child: Column(
                                key: ValueKey(_tab),
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    create ? 'Join Pleat' : 'Welcome back',
                                    style: PType.h1(color: PColors.onDeep),
                                  ),
                                  const SizedBox(height: 6),
                                  Text(
                                    create
                                        ? 'One account, every exit.'
                                        : 'Sign in to reach your exits.',
                                    style: PType.small(
                                      color: PColors.onDeep.withValues(
                                        alpha: 0.78,
                                      ),
                                    ),
                                  ),
                                  if (create && trial != null) ...[
                                    const SizedBox(height: 10),
                                    _HeaderChip(
                                      '${trial.trialDays}-day free trial after sign-up',
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Container(
                      constraints: BoxConstraints(
                        minHeight: math.max(0, box.maxHeight - top - sheetTop),
                      ),
                      decoration: BoxDecoration(
                        color: PColors.surface,
                        borderRadius: BorderRadius.vertical(
                          top: Radius.circular(PRadius.sheet),
                        ),
                      ),
                      padding: EdgeInsets.fromLTRB(
                        24,
                        12,
                        24,
                        28 + MediaQuery.paddingOf(context).bottom,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Center(child: _Handle()),
                          _Segmented(
                            labels: const ['Sign in', 'Create account'],
                            index: _tab,
                            onChanged: _setTab,
                          ),
                          const SizedBox(height: 20),
                          AnimatedSwitcher(
                            duration: reduced ? Duration.zero : PMotion.quick,
                            child: create ? _createForm() : _signInForm(),
                          ),
                          if (!app.api.configured) ...[
                            const SizedBox(height: 16),
                            Text(
                              'This build has no server address, so sign-in can’t reach anyone.',
                              style: PType.small(),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _errorLine() => _ErrorLine(_error);

  Widget _signInForm() => Column(
    key: const ValueKey('signin'),
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      AuthField(
        controller: _login,
        focusNode: _loginFocus,
        icon: PIcon.user,
        hint: 'Email, @username or Telegram ID',
        keyboard: TextInputType.emailAddress,
        autofill: const [AutofillHints.username],
      ),
      const SizedBox(height: 12),
      AuthField(
        controller: _password,
        icon: PIcon.lock,
        hint: 'Password',
        secret: true,
        autofill: const [AutofillHints.password],
        onDone: _submit,
      ),
      Align(
        alignment: Alignment.centerRight,
        child: _TextLink('Forgot password?', _busy ? null : _forgot),
      ),
      _errorLine(),
      const SizedBox(height: 6),
      PillButton(
        label: _busy ? 'Signing in…' : 'Sign in',
        onTap: _busy ? null : _submit,
      ),
      const _OrLine('or sign in with'),
      Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _BrandTile(asset: 'telegram', label: 'Telegram', onTap: _telegram),
          const SizedBox(width: 22),
          _BrandTile(asset: 'gmail', label: 'Gmail', onTap: _gmail),
        ],
      ),
    ],
  );

  Widget _createForm() => Column(
    key: const ValueKey('create'),
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        children: [
          Expanded(
            child: _BrandButton(
              asset: 'telegram',
              label: 'Telegram',
              onTap: _telegram,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _BrandButton(asset: 'gmail', label: 'Gmail', onTap: _gmail),
          ),
        ],
      ),
      const _OrLine('or with email', top: 18, bottom: 14),
      AuthField(
        controller: _email,
        focusNode: _emailFocus,
        icon: PIcon.mail,
        hint: 'Email',
        keyboard: TextInputType.emailAddress,
        autofill: const [AutofillHints.email],
      ),
      const SizedBox(height: 12),
      AuthField(
        controller: _newPassword,
        icon: PIcon.lock,
        hint: 'Password (8+ characters)',
        secret: true,
        autofill: const [AutofillHints.newPassword],
      ),
      const SizedBox(height: 12),
      AuthField(
        controller: _again,
        icon: PIcon.lock,
        hint: 'Password again',
        secret: true,
        autofill: const [AutofillHints.newPassword],
        onDone: _showInvite ? null : _submit,
      ),
      if (_showInvite) ...[
        const SizedBox(height: 12),
        AuthField(
          controller: _invite,
          icon: PIcon.ticket,
          hint: 'Invite code (optional)',
          caps: true,
          onDone: _submit,
        ),
      ] else
        Align(
          alignment: Alignment.centerLeft,
          child: _TextLink(
            '+ I have an invite code',
            () => setState(() => _showInvite = true),
          ),
        ),
      _errorLine(),
      const SizedBox(height: 10),
      PillButton(
        label: _busy ? 'Creating…' : 'Create account',
        onTap: _busy ? null : _submit,
      ),
    ],
  );
}

/// Sign in or sign up with Telegram: the bot sends a 6-digit code to the
/// Telegram account that opens the link, the code goes in the six boxes
/// (typed, pasted, or filled from a code copied in Telegram), the boxes
/// turn green one by one, and a new account then sets its app password.
///
/// With [link] it verifies the Telegram account of a signed-in email
/// account instead (from Profile): same bot and code, then it pops with
/// true.
class TelegramLoginScreen extends StatefulWidget {
  const TelegramLoginScreen({super.key, this.link = false});
  final bool link;

  @override
  State<TelegramLoginScreen> createState() => _TelegramLoginScreenState();
}

class _TelegramLoginScreenState extends State<TelegramLoginScreen>
    with WidgetsBindingObserver, SingleTickerProviderStateMixin {
  static const _resendAfter = 30;

  final _code = TextEditingController();
  final _codeFocus = FocusNode();
  final _password = TextEditingController();
  final _again = TextEditingController();
  final _invite = TextEditingController();
  late final AnimationController _wave = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );
  TelegramStart? _link;
  TelegramSignup? _signup;
  bool _verified = false;
  bool _passwordStep = false;
  bool _busy = false;
  bool _wrong = false;
  String? _error;
  String? _clip;
  int _wait = 0;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _code.addListener(_onCode);
    WidgetsBinding.instance.addPostFrameCallback((_) => _newLink());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tick?.cancel();
    _wave.dispose();
    _code.dispose();
    _codeFocus.dispose();
    _password.dispose();
    _again.dispose();
    _invite.dispose();
    super.dispose();
  }

  /// Back from Telegram: offer the code if one was copied there.
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _checkClipboard();
  }

  static final _codeRe = RegExp(r'(?<!\d)(\d{3})\s?(\d{3})(?!\d)');

  Future<void> _checkClipboard() async {
    if (_verified || _link == null) return;
    try {
      final data = await Clipboard.getData(Clipboard.kTextPlain);
      final m = _codeRe.firstMatch(data?.text ?? '');
      final code = m == null ? null : '${m[1]}${m[2]}';
      if (!mounted) return;
      setState(() => _clip = code == _code.text ? null : code);
    } catch (_) {}
  }

  void _fill() {
    final c = _clip;
    if (c == null) return;
    _code.text = c;
    setState(() => _clip = null);
  }

  String _lastCode = '';
  void _onCode() {
    final digits = _code.text.replaceAll(RegExp(r'\D'), '');
    if (digits != _code.text) {
      _code.value = TextEditingValue(
        text: digits,
        selection: TextSelection.collapsed(offset: digits.length),
      );
      return;
    }
    if (digits == _lastCode) return;
    _lastCode = digits;
    setState(() {
      _wrong = false;
      if (_error != null && digits.length < 6) _error = null;
    });
    if (digits.length == 6) _verify();
  }

  void _startCountdown() {
    _tick?.cancel();
    setState(() => _wait = _resendAfter);
    _tick = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _wait = math.max(0, _wait - 1));
      if (_wait == 0) t.cancel();
    });
  }

  Future<void> _run(Future<void> Function() job) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await job();
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _wrong = true;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Can’t reach the server. Try again.');
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _newLink() async {
    var fresh = false;
    await _run(() async {
      final app = AppScope.read(context);
      final link = widget.link
          ? await app.telegramLinkStart()
          : await app.telegramStart();
      if (!mounted) return;
      setState(() {
        _link = link;
        _clip = null;
        _code.clear();
      });
      _startCountdown();
      fresh = true;
    });
    // Telegram opens outside the busy state, so the boxes take the code
    // as soon as the person comes back.
    if (fresh && mounted) await _openBot();
  }

  Future<void> _openBot() async {
    final link = _link;
    if (link == null) return;
    final tunnel = AppScope.read(context).tunnel;
    final ok = link.appUrl.isNotEmpty && await tunnel.openUrl(link.appUrl);
    if (!ok) await tunnel.openUrl(link.botUrl);
  }

  Future<void> _verify() async {
    final link = _link;
    final code = _code.text;
    if (link == null) return _newLink();
    if (code.length != 6) {
      setState(() => _error = 'The code has 6 digits.');
      return;
    }
    FocusScope.of(context).unfocus();
    await _run(() async {
      final app = AppScope.read(context);
      if (widget.link) {
        await app.telegramLinkVerify(link.nonce, code);
      } else {
        _signup = await app.telegramVerify(link.nonce, code);
      }
      if (!mounted) return;
      _tick?.cancel();
      setState(() {
        _verified = true;
        _clip = null;
      });
      HapticFeedback.lightImpact();
      if (PMotion.reduced(context)) {
        _wave.value = 1;
      } else {
        unawaited(_wave.forward());
      }
    });
  }

  void _continue() {
    if (widget.link) {
      Navigator.of(context).pop(true);
    } else if (_signup != null) {
      setState(() {
        _passwordStep = true;
        _error = null;
      });
    } else {
      _home();
    }
  }

  Future<void> _create() async {
    final signup = _signup;
    if (signup == null) return;
    if (_password.text.length < 8) {
      setState(() => _error = 'Passwords have at least 8 characters.');
      return;
    }
    if (_password.text != _again.text) {
      setState(() => _error = 'The two passwords don’t match.');
      return;
    }
    FocusScope.of(context).unfocus();
    await _run(() async {
      final err = await AppScope.read(
        context,
      ).telegramRegister(signup, _password.text, invite: _invite.text.trim());
      if (!mounted) return;
      if (err != null) {
        setState(() => _error = err);
        return;
      }
      _home();
    });
  }

  void _home() {
    Navigator.of(context).pushAndRemoveUntil(
      FadeRoute(builder: (_) => const Shell()),
      (_) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    final reduced = PMotion.reduced(context);
    const sheetTop = 110.0;
    return Scaffold(
      backgroundColor: PColors.navy,
      body: Stack(
        children: [
          Positioned(
            left: 0,
            right: 0,
            top: 0,
            height: top + sheetTop + 80,
            child: CustomPaint(painter: _PlaneHeader()),
          ),
          LayoutBuilder(
            builder: (context, box) => SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: box.maxHeight),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(
                      height: top + sheetTop,
                      child: Align(
                        alignment: Alignment.topLeft,
                        child: Padding(
                          padding: EdgeInsets.fromLTRB(16, top + 8, 0, 0),
                          child: RoundIcon(
                            PIcon.back,
                            onTap: () => Navigator.of(context).pop(),
                            label: 'Back',
                            color: PColors.onDeep,
                            background: PColors.onDeep.withValues(alpha: 0.14),
                          ),
                        ),
                      ),
                    ),
                    Container(
                      constraints: BoxConstraints(
                        minHeight: math.max(0, box.maxHeight - top - sheetTop),
                      ),
                      decoration: BoxDecoration(
                        color: PColors.surface,
                        borderRadius: BorderRadius.vertical(
                          top: Radius.circular(PRadius.sheet),
                        ),
                      ),
                      padding: EdgeInsets.fromLTRB(
                        24,
                        12,
                        24,
                        28 + MediaQuery.paddingOf(context).bottom,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Center(child: _Handle()),
                          AnimatedSwitcher(
                            duration: reduced ? Duration.zero : PMotion.quick,
                            child: _passwordStep
                                ? _passwordForm(_signup!)
                                : _codeStep(),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _badge({required bool ok}) => Center(
    child: AnimatedContainer(
      duration: PMotion.quick,
      width: 60,
      height: 60,
      decoration: BoxDecoration(
        color: ok ? PColors.safe.withValues(alpha: 0.14) : PColors.mist,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: ok
          ? PIconView(PIcon.shield, size: 30, color: PColors.safe)
          : SvgPicture.asset('assets/brand/telegram.svg', width: 36),
    ),
  );

  Widget _codeStep() {
    final ok = _verified;
    return Column(
      key: const ValueKey('code'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 4),
        _badge(ok: ok),
        const SizedBox(height: 14),
        AnimatedSwitcher(
          duration: PMotion.quick,
          child: ok
              ? Row(
                  key: const ValueKey('ok'),
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    PIconView(PIcon.check, size: 22, color: PColors.safe),
                    const SizedBox(width: 8),
                    Text('Verified', style: PType.h2(color: PColors.safe)),
                  ],
                )
              : Text(
                  key: const ValueKey('ask'),
                  widget.link ? 'Verify your Telegram' : 'Check Telegram',
                  textAlign: TextAlign.center,
                  style: PType.h2(),
                ),
        ),
        const SizedBox(height: 6),
        Text(
          ok
              ? (widget.link
                    ? 'This Telegram account is now linked.'
                    : 'Your Telegram account is confirmed.')
              : _link == null
              ? 'Getting your sign-in link…'
              : 'Tap Start in our bot, then type the 6-digit code it sends you.',
          textAlign: TextAlign.center,
          style: PType.body(color: PColors.muted),
        ),
        const SizedBox(height: 24),
        _OtpBoxes(
          controller: _code,
          focusNode: _codeFocus,
          enabled: !ok && _link != null,
          wrong: _wrong,
          wave: _wave,
          verified: ok,
        ),
        _ErrorLine(_error, center: true),
        SizedBox(height: ok ? 30 : 18),
        if (ok) ...[
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              PIconView(PIcon.lock, size: 16, color: PColors.safe),
              const SizedBox(width: 6),
              Text(
                widget.link ? 'Linked and secure' : 'Verified and secure',
                style: PType.small(color: PColors.safe)
                    .copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: 14),
          PillButton(label: 'Continue', onTap: _continue, color: PColors.safe),
          if (_signup != null) ...[
            const SizedBox(height: 12),
            Text(
              'New here? You’ll set an app password next.',
              textAlign: TextAlign.center,
              style: PType.small(),
            ),
          ],
        ] else ...[
          AnimatedSize(
            duration: reduced(context) ? Duration.zero : PMotion.quick,
            child: _clip == null
                ? const SizedBox(width: double.infinity)
                : Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: _FillChip(code: _clip!, onFill: _fill),
                  ),
          ),
          Center(
            child: _wait > 0
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    child: Text.rich(
                      TextSpan(
                        style: PType.small(),
                        children: [
                          const TextSpan(text: 'Didn’t get it? Resend in '),
                          TextSpan(
                            text: '0:${_wait.toString().padLeft(2, '0')}',
                            style: PType.meta(color: PColors.ink)
                                .copyWith(fontSize: 13),
                          ),
                        ],
                      ),
                    ),
                  )
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Didn’t get it?', style: PType.small()),
                      _TextLink(
                        'Send a new code',
                        _busy || _link == null ? null : _newLink,
                      ),
                    ],
                  ),
          ),
          if (_error != null && _code.text.length == 6 && !_busy) ...[
            PillButton(label: 'Try again', onTap: _verify),
            const SizedBox(height: 12),
          ] else
            const SizedBox(height: 6),
          PillButton(
            label: _link == null ? 'Getting your link…' : 'Open Telegram',
            onTap: _busy || _link == null ? null : _openBot,
            color: PColors.field,
            textColor: PColors.ink,
          ),
          if (!widget.link) ...[
            const SizedBox(height: 14),
            Text(
              'Can’t open Telegram? Go back and use your email instead.',
              textAlign: TextAlign.center,
              style: PType.small(),
            ),
          ],
        ],
      ],
    );
  }

  static bool reduced(BuildContext context) => PMotion.reduced(context);

  Widget _passwordForm(TelegramSignup s) => Column(
    key: const ValueKey('password'),
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const SizedBox(height: 4),
      Text('Set your app password', style: PType.h2()),
      const SizedBox(height: 8),
      Text.rich(
        TextSpan(
          style: PType.body(color: PColors.muted),
          children: [
            const TextSpan(text: 'Your login is '),
            TextSpan(
              text: s.login,
              style: PType.body().copyWith(fontWeight: FontWeight.w700),
            ),
            const TextSpan(
              text: '. Use it with this password to sign in on any phone.',
            ),
          ],
        ),
      ),
      const SizedBox(height: 18),
      AuthField(
        controller: _password,
        icon: PIcon.lock,
        hint: 'Password (8+ characters)',
        secret: true,
        autofill: const [AutofillHints.newPassword],
      ),
      const SizedBox(height: 12),
      AuthField(
        controller: _again,
        icon: PIcon.lock,
        hint: 'Password again',
        secret: true,
        autofill: const [AutofillHints.newPassword],
      ),
      const SizedBox(height: 12),
      AuthField(
        controller: _invite,
        icon: PIcon.ticket,
        hint: 'Invite code (optional)',
        caps: true,
        onDone: _create,
      ),
      _ErrorLine(_error),
      const SizedBox(height: 16),
      PillButton(
        label: _busy ? 'Creating…' : 'Create account',
        onTap: _busy ? null : _create,
      ),
    ],
  );
}

// ---- pieces ------------------------------------------------------------

/// A pill input with a leading glyph. Focus draws the accent ring; a
/// secret field gets a show/hide eye.
class AuthField extends StatefulWidget {
  const AuthField({
    super.key,
    required this.controller,
    required this.icon,
    required this.hint,
    this.focusNode,
    this.secret = false,
    this.caps = false,
    this.keyboard,
    this.autofill,
    this.onDone,
  });

  final TextEditingController controller;
  final FocusNode? focusNode;
  final PIcon icon;
  final String hint;
  final bool secret, caps;
  final TextInputType? keyboard;
  final Iterable<String>? autofill;
  final VoidCallback? onDone;

  @override
  State<AuthField> createState() => _AuthFieldState();
}

class _AuthFieldState extends State<AuthField> {
  FocusNode? _own;
  FocusNode get _focus => widget.focusNode ?? (_own ??= FocusNode());
  late bool _hidden = widget.secret;

  @override
  void initState() {
    super.initState();
    _focus.addListener(_changed);
  }

  @override
  void dispose() {
    _focus.removeListener(_changed);
    _own?.dispose();
    super.dispose();
  }

  void _changed() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final on = _focus.hasFocus;
    return AnimatedContainer(
      duration: PMotion.reduced(context) ? Duration.zero : PMotion.quick,
      height: 56,
      padding: const EdgeInsets.only(left: 20, right: 8),
      decoration: BoxDecoration(
        color: on ? PColors.surface : PColors.field,
        borderRadius: BorderRadius.circular(PRadius.pill),
        border: Border.all(
          color: on ? PColors.blue : Colors.transparent,
          width: 1.5,
        ),
        boxShadow: on
            ? [
                BoxShadow(
                  color: PColors.blue.withValues(alpha: 0.14),
                  spreadRadius: 4,
                ),
              ]
            : null,
      ),
      child: Row(
        children: [
          PIconView(
            widget.icon,
            size: 20,
            color: on ? PColors.accentInk : PColors.muted,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              controller: widget.controller,
              focusNode: _focus,
              obscureText: _hidden,
              autocorrect: false,
              enableSuggestions: !widget.secret,
              keyboardType: widget.keyboard,
              textCapitalization: widget.caps
                  ? TextCapitalization.characters
                  : TextCapitalization.none,
              autofillHints: widget.autofill,
              textInputAction: widget.onDone == null
                  ? TextInputAction.next
                  : TextInputAction.go,
              onSubmitted: widget.onDone == null
                  ? null
                  : (_) => widget.onDone!(),
              style: PType.body().copyWith(fontWeight: FontWeight.w700),
              decoration: InputDecoration(
                isCollapsed: true,
                border: InputBorder.none,
                hintText: widget.hint,
                hintStyle: PType.body(color: PColors.muted),
              ),
            ),
          ),
          if (widget.secret)
            Semantics(
              button: true,
              label: _hidden ? 'Show password' : 'Hide password',
              child: InkResponse(
                onTap: () => setState(() => _hidden = !_hidden),
                radius: 22,
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Icon(
                    _hidden
                        ? Icons.visibility_outlined
                        : Icons.visibility_off_outlined,
                    size: 20,
                    color: PColors.muted,
                  ),
                ),
              ),
            )
          else
            const SizedBox(width: 12),
        ],
      ),
    );
  }
}

/// Six code boxes over one hidden field: typing, pasting and the keyboard's
/// one-time-code suggestion all go through it. The active box carries the
/// accent ring and a caret; after a good code the boxes turn green in a
/// wave and a ring with dots settles around them.
class _OtpBoxes extends StatelessWidget {
  const _OtpBoxes({
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.wrong,
    required this.wave,
    required this.verified,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled, wrong, verified;
  final Animation<double> wave;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '6-digit code',
      textField: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? focusNode.requestFocus : null,
        child: Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            // The real input: invisible, but it owns focus and the keyboard.
            Positioned.fill(
              child: Opacity(
                opacity: 0,
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  enabled: enabled,
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  showCursor: false,
                  enableInteractiveSelection: false,
                  autofillHints: const [AutofillHints.oneTimeCode],
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(6),
                  ],
                  decoration: const InputDecoration(
                    counterText: '',
                    border: InputBorder.none,
                  ),
                ),
              ),
            ),
            AnimatedBuilder(
              animation: Listenable.merge([controller, focusNode, wave]),
              builder: (context, _) {
                final text = controller.text;
                final t = wave.value;
                return IgnorePointer(
                  child: Stack(
                    clipBehavior: Clip.none,
                    alignment: Alignment.center,
                    children: [
                      if (verified)
                        Positioned(
                          left: -8,
                          right: -8,
                          top: -12,
                          bottom: -12,
                          child: Opacity(
                            opacity: ((t - 0.6) / 0.4).clamp(0.0, 1.0),
                            child: CustomPaint(
                              painter: _RingPainter(PColors.safe),
                            ),
                          ),
                        ),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          for (var i = 0; i < 6; i++) ...[
                            if (i == 3) const SizedBox(width: 10),
                            if (i != 0 && i != 3) const SizedBox(width: 8),
                            _box(
                              context,
                              i < text.length ? text[i] : '',
                              active:
                                  enabled &&
                                  focusNode.hasFocus &&
                                  (i == text.length ||
                                      (i == 5 && text.length == 6)),
                              ok: verified && t >= i * 0.09,
                              lift: verified
                                  ? math.sin(
                                          ((t - i * 0.09) / 0.18).clamp(
                                                0.0,
                                                1.0,
                                              ) *
                                              math.pi,
                                        ) *
                                        6
                                  : 0,
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _box(
    BuildContext context,
    String digit, {
    required bool active,
    required bool ok,
    required double lift,
  }) {
    final border = ok
        ? PColors.safe
        : wrong
        ? PColors.alert
        : active
        ? PColors.blue
        : Colors.transparent;
    return Transform.translate(
      offset: Offset(0, -lift),
      child: AnimatedContainer(
        duration: PMotion.reduced(context)
            ? Duration.zero
            : const Duration(milliseconds: 220),
        width: 46,
        height: 58,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: ok
              ? PColors.safe.withValues(alpha: 0.12)
              : active
              ? PColors.surface
              : PColors.field,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: border, width: 1.5),
          boxShadow: active
              ? [
                  BoxShadow(
                    color: PColors.blue.withValues(alpha: 0.14),
                    spreadRadius: 4,
                  ),
                ]
              : null,
        ),
        child: digit.isEmpty && active
            ? Container(width: 2, height: 24, color: PColors.blue)
            : Text(
                digit,
                style: PType.h2(
                  color: ok ? PColors.safe : PColors.ink,
                ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
      ),
    );
  }
}

/// The rounded frame and scattered dots around verified boxes.
class _RingPainter extends CustomPainter {
  _RingPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final r = RRect.fromRectAndRadius(
      Offset.zero & size,
      const Radius.circular(24),
    );
    canvas.drawRRect(
      r,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = color.withValues(alpha: 0.5),
    );
    final dot = Paint()..color = color;
    final rnd = math.Random(7);
    for (var i = 0; i < 14; i++) {
      final x = size.width * (i / 13);
      final yTop = -8 + rnd.nextDouble() * 4;
      final yBottom = size.height + 4 + rnd.nextDouble() * 4;
      canvas.drawCircle(
        Offset(x + rnd.nextDouble() * 8 - 4, i.isEven ? yTop : yBottom),
        1.4 + rnd.nextDouble(),
        dot,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.color != color;
}

/// "Code copied from Telegram · 481 293 · Fill".
class _FillChip extends StatelessWidget {
  const _FillChip({required this.code, required this.onFill});
  final String code;
  final VoidCallback onFill;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
    decoration: BoxDecoration(
      color: PColors.field,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: PColors.mist),
    ),
    child: Row(
      children: [
        PIconView(PIcon.copy, size: 20, color: PColors.accentInk),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Code copied from Telegram', style: PType.meta()),
              const SizedBox(height: 2),
              Text(
                '${code.substring(0, 3)} ${code.substring(3)}',
                style: PType.h3(color: PColors.accentInk).copyWith(
                  letterSpacing: 1.5,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
        PillButton(label: 'Fill', onTap: onFill, height: 36, expand: false),
      ],
    ),
  );
}

class _Handle extends StatelessWidget {
  const _Handle();

  @override
  Widget build(BuildContext context) => Container(
    width: 40,
    height: 5,
    margin: const EdgeInsets.only(bottom: 18),
    decoration: BoxDecoration(
      color: PColors.muted.withValues(alpha: 0.3),
      borderRadius: BorderRadius.circular(3),
    ),
  );
}

/// Two-option segmented control on the field fill.
class _Segmented extends StatelessWidget {
  const _Segmented({
    required this.labels,
    required this.index,
    required this.onChanged,
  });

  final List<String> labels;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final reduced = PMotion.reduced(context);
    return Container(
      height: 48,
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: PColors.field,
        borderRadius: BorderRadius.circular(PRadius.pill),
      ),
      child: LayoutBuilder(
        builder: (context, box) {
          final w = box.maxWidth / labels.length;
          return Stack(
            children: [
              AnimatedPositioned(
                duration: reduced ? Duration.zero : PMotion.quick,
                curve: Curves.easeOutCubic,
                left: w * index,
                top: 0,
                bottom: 0,
                width: w,
                child: Container(
                  decoration: BoxDecoration(
                    color: PColors.current.isDark
                        ? PColors.mist
                        : PColors.surface,
                    borderRadius: BorderRadius.circular(PRadius.pill),
                    boxShadow: PColors.current.isDark
                        ? null
                        : [
                            BoxShadow(
                              color: PColors.navy.withValues(alpha: 0.10),
                              blurRadius: 8,
                              offset: const Offset(0, 2),
                            ),
                          ],
                  ),
                ),
              ),
              Row(
                children: [
                  for (var i = 0; i < labels.length; i++)
                    Expanded(
                      child: Semantics(
                        button: true,
                        selected: i == index,
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () => onChanged(i),
                          child: Center(
                            child: Text(
                              labels[i],
                              style: PType.small(
                                color: i == index ? PColors.ink : PColors.muted,
                              ).copyWith(fontWeight: FontWeight.w700),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }
}

class _OrLine extends StatelessWidget {
  const _OrLine(this.text, {this.top = 24, this.bottom = 18});
  final String text;
  final double top, bottom;

  @override
  Widget build(BuildContext context) {
    final line = Expanded(
      child: Container(height: 1, color: PColors.muted.withValues(alpha: 0.2)),
    );
    return Padding(
      padding: EdgeInsets.only(top: top, bottom: bottom),
      child: Row(
        children: [
          line,
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Text(text, style: PType.meta()),
          ),
          line,
        ],
      ),
    );
  }
}

Widget _brandLogo(String asset, double size) =>
    SvgPicture.asset('assets/brand/$asset.svg', width: size, height: size);

/// Square quick sign-in tile with the brand logo and a caption.
class _BrandTile extends StatelessWidget {
  const _BrandTile({
    required this.asset,
    required this.label,
    required this.onTap,
  });
  final String asset, label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Pressable(
        onTap: onTap,
        label: 'Sign in with $label',
        radius: 22,
        color: PColors.surface,
        child: Container(
          width: 64,
          height: 64,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(22),
            border: Border.all(
              color: PColors.muted.withValues(alpha: 0.22),
              width: 1.5,
            ),
          ),
          child: _brandLogo(asset, 32),
        ),
      ),
      const SizedBox(height: 8),
      Text(label, style: PType.meta().copyWith(fontWeight: FontWeight.w700)),
    ],
  );
}

/// Wide quick button: logo + name on the field fill.
class _BrandButton extends StatelessWidget {
  const _BrandButton({
    required this.asset,
    required this.label,
    required this.onTap,
  });
  final String asset, label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    label: label,
    radius: PRadius.pill,
    color: PColors.field,
    child: SizedBox(
      height: 54,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _brandLogo(asset, 24),
          const SizedBox(width: 10),
          Text(
            label,
            style: PType.body().copyWith(fontWeight: FontWeight.w800),
          ),
        ],
      ),
    ),
  );
}

class _HeaderChip extends StatelessWidget {
  const _HeaderChip(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
    decoration: BoxDecoration(
      color: PColors.onDeep.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(PRadius.pill),
      border: Border.all(color: PColors.onDeep.withValues(alpha: 0.22)),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PIconView(PIcon.ticket, size: 14, color: PColors.onDeep),
        const SizedBox(width: 6),
        Text(
          text,
          style: PType.meta(color: PColors.onDeep)
              .copyWith(fontWeight: FontWeight.w700),
        ),
      ],
    ),
  );
}

class _TextLink extends StatelessWidget {
  const _TextLink(this.text, this.onTap);
  final String text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    label: text,
    radius: 20,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
      child: Text(
        text,
        style: PType.small(color: PColors.accentInk)
            .copyWith(fontWeight: FontWeight.w700),
      ),
    ),
  );
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine(this.error, {this.center = false});
  final String? error;
  final bool center;

  @override
  Widget build(BuildContext context) => AnimatedSize(
    duration: PMotion.reduced(context) ? Duration.zero : PMotion.quick,
    child: error == null
        ? const SizedBox(width: double.infinity)
        : Padding(
            padding: EdgeInsets.only(top: 12, left: center ? 0 : 18),
            child: Text(
              error!,
              textAlign: center ? TextAlign.center : TextAlign.start,
              style: PType.small(color: PColors.alert)
                  .copyWith(fontWeight: FontWeight.w600),
            ),
          ),
  );
}

/// The navy plane with the ice sliver and the blue plane cut in on the
/// right, the way the brand mark folds.
class _PlaneHeader extends CustomPainter {
  /// Repaints when Day and Night switch.
  final PPalette palette = PColors.current;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    canvas.drawRect(Offset.zero & size, Paint()..color = PColors.navy);
    final ice = Path()
      ..moveTo(w * 0.815, -10)
      ..lineTo(w * 0.95, -10)
      ..lineTo(w * 0.77, h * 0.80)
      ..lineTo(w * 0.635, h * 0.80)
      ..close();
    final blue = Path()
      ..moveTo(w * 0.93, -10)
      ..lineTo(w + 10, -10)
      ..lineTo(w + 10, h)
      ..lineTo(w * 0.73, h)
      ..close();
    canvas.drawPath(ice, Paint()..color = PColors.ice.withValues(alpha: 0.9));
    canvas.drawPath(blue, Paint()..color = PColors.blue);
  }

  @override
  bool shouldRepaint(_PlaneHeader old) => old.palette != palette;
}
