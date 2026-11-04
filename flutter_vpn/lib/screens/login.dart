import 'package:flutter/material.dart';

import '../design/geometry.dart';
import '../design/icons.dart';
import '../design/mark.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../api/client.dart';
import '../design/backdrop.dart';
import '../design/scenes.dart';
import '../state/app_state.dart';
import 'confirm.dart';
import 'shell.dart';

/// Login: a navy cut header built from the brand planes, the mark on the
/// blue plane, Continue with Telegram first, then one field for an email,
/// a Telegram @username or a Telegram id, and Continue to the password.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  /// Email, Telegram @username (with or without @) or numeric Telegram id.
  static final _loginRe = RegExp(
    r'^([^@\s]+@[^@\s]+\.[^@\s]+|@?[A-Za-z][A-Za-z0-9_]{3,31}|\d{1,20})$',
  );

  void _continue() {
    final v = _email.text.trim();
    if (!_loginRe.hasMatch(v)) {
      setState(
        () => _error = 'Enter your email, Telegram @username or Telegram ID.',
      );
      return;
    }
    setState(() => _error = null);
    FocusScope.of(context).unfocus();
    Navigator.of(context)
        .push(FadeRoute(builder: (_) => ConfirmScreen(address: v)));
  }

  void _telegram() {
    FocusScope.of(context).unfocus();
    Navigator.of(context)
        .push(FadeRoute(builder: (_) => const TelegramLoginScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final reduced = PMotion.reduced(context);
    final top = MediaQuery.paddingOf(context).top;
    return Scaffold(
      backgroundColor: Colors.white,
      resizeToAvoidBottomInset: true,
      body: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              height: 300 + top,
              child: Stack(
                children: [
                  const Positioned.fill(
                    child: CustomPaint(painter: _CutHeader()),
                  ),
                  Positioned(
                    left: 28,
                    top: top + 130,
                    child: Text(
                      'Sign in',
                      style: PType.h1(color: Colors.white)
                          .copyWith(fontSize: 36),
                    ),
                  ),
                  Positioned(
                    right: 34,
                    top: top + 64,
                    child: const PleatMark(size: 56, colors: MarkColors.onDark),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(28, 24, 28, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  PillButton(label: 'Continue with Telegram', onTap: _telegram),
                  const SizedBox(height: 22),
                  _emailField(),
                  AnimatedSize(
                    duration: reduced ? Duration.zero : PMotion.quick,
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
                  const SizedBox(height: 16),
                  PillButton(
                    label: 'Continue with password',
                    onTap: _continue,
                    color: PColors.field,
                    textColor: PColors.ink,
                  ),
                  const SizedBox(height: 18),
                  Text(
                    AppScope.of(context).api.configured
                        ? 'New here? Continue with Telegram. No Telegram access yet? Type your email and create an account on the next step.'
                        : 'This build has no server address, so sign-in can’t reach anyone.',
                    style: PType.small(),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(String t) => Padding(
    padding: const EdgeInsets.only(left: 18, bottom: 10),
    child: Text(t, style: PType.small()),
  );

  Widget _fieldShell(Widget child) => Container(
    height: 56,
    padding: const EdgeInsets.symmetric(horizontal: 22),
    decoration: BoxDecoration(
      color: PColors.field,
      borderRadius: BorderRadius.circular(PRadius.pill),
    ),
    alignment: Alignment.centerLeft,
    child: child,
  );

  InputDecoration _dec(String hint) => InputDecoration(
    isCollapsed: true,
    border: InputBorder.none,
    hintText: hint,
    hintStyle: PType.body(color: PColors.muted),
  );

  Widget _emailField() => Column(
    key: const ValueKey('email'),
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _label('Or sign in with a password'),
      _fieldShell(
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          autofillHints: const [AutofillHints.username],
          textInputAction: TextInputAction.go,
          onSubmitted: (_) => _continue(),
          style: PType.body().copyWith(fontWeight: FontWeight.w700),
          decoration: _dec('Email, @username or Telegram ID'),
        ),
      ),
    ],
  );
}

/// Sign in or sign up with Telegram: the bot sends a 6-digit code to the
/// Telegram account that opens the link, the code goes in here, and a new
/// account then sets its app password. Later sign-ins can use the
/// @username (or the numeric Telegram id) and that password.
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

class _TelegramLoginScreenState extends State<TelegramLoginScreen> {
  final _code = TextEditingController();
  final _password = TextEditingController();
  final _again = TextEditingController();
  final _invite = TextEditingController();
  TelegramStart? _link;
  TelegramSignup? _signup;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _newLink());
  }

  @override
  void dispose() {
    _code.dispose();
    _password.dispose();
    _again.dispose();
    _invite.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() job) async {
    if (_busy) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await job();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Can’t reach the server. Try again.');
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _newLink() => _run(() async {
    final app = AppScope.read(context);
    final link = widget.link
        ? await app.telegramLinkStart()
        : await app.telegramStart();
    if (!mounted) return;
    setState(() {
      _link = link;
      _code.clear();
    });
    await _openBot();
  });

  Future<void> _openBot() async {
    final link = _link;
    if (link == null) return;
    final tunnel = AppScope.read(context).tunnel;
    final ok = link.appUrl.isNotEmpty && await tunnel.openUrl(link.appUrl);
    if (!ok) await tunnel.openUrl(link.botUrl);
  }

  Future<void> _verify() async {
    final link = _link;
    final code = _code.text.replaceAll(RegExp(r'\D'), '');
    if (link == null) return _newLink();
    if (code.length != 6) {
      setState(() => _error = 'The code has 6 digits.');
      return;
    }
    await _run(() async {
      if (widget.link) {
        await AppScope.read(context).telegramLinkVerify(link.nonce, code);
        if (mounted) Navigator.of(context).pop(true);
        return;
      }
      final signup = await AppScope.read(context)
          .telegramVerify(link.nonce, code);
      if (!mounted) return;
      if (signup == null) return _home();
      setState(() => _signup = signup);
    });
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
    final signup = _signup;
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
                child: signup == null ? _codeStep() : _passwordStep(signup),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(PIcon icon, String title) => Row(
    children: [
      Container(
        width: 48,
        height: 48,
        decoration: const BoxDecoration(
          color: PColors.mist,
          shape: BoxShape.circle,
        ),
        alignment: Alignment.center,
        child: PIconView(icon, color: PColors.blue),
      ),
      const SizedBox(width: 14),
      Expanded(child: Text(title, style: PType.h2())),
    ],
  );

  Widget _field(
    TextEditingController c,
    String hint, {
    bool secret = false,
    bool digits = false,
    VoidCallback? onDone,
  }) => Container(
    height: 56,
    margin: const EdgeInsets.only(top: 12),
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
      keyboardType: digits ? TextInputType.number : null,
      maxLength: digits ? 6 : null,
      autofillHints: digits
          ? const [AutofillHints.oneTimeCode]
          : secret
          ? const [AutofillHints.newPassword]
          : null,
      textInputAction: onDone == null
          ? TextInputAction.next
          : TextInputAction.go,
      onSubmitted: onDone == null ? null : (_) => onDone(),
      style: PType.body().copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: digits ? 6 : null,
      ),
      decoration: InputDecoration(
        isCollapsed: true,
        counterText: '',
        border: InputBorder.none,
        hintText: hint,
        hintStyle: PType.body(color: PColors.muted),
      ),
    ),
  );

  Widget _errorLine() => AnimatedSize(
    duration: PMotion.reduced(context) ? Duration.zero : PMotion.quick,
    child: _error == null
        ? const SizedBox(width: double.infinity)
        : Padding(
            padding: const EdgeInsets.only(top: 10, left: 18),
            child: Text(_error!, style: PType.small(color: PColors.ink)),
          ),
  );

  Widget _textLink(String text, VoidCallback onTap) => Pressable(
    onTap: _busy ? null : onTap,
    label: text,
    radius: 20,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 14),
      child: Text(
        text,
        style: PType.small(color: PColors.blue)
            .copyWith(fontWeight: FontWeight.w700),
      ),
    ),
  );

  Widget _codeStep() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _header(
        PIcon.lock,
        widget.link ? 'Verify your Telegram' : 'Sign in with Telegram',
      ),
      const SizedBox(height: 16),
      Text(
        '1. Open Telegram and tap Start in our bot.\n'
        '2. Type the 6-digit code the bot sends you.',
        style: PType.body(color: PColors.muted),
      ),
      const SizedBox(height: 16),
      PillButton(
        label: _link == null ? 'Getting your link…' : 'Open Telegram',
        onTap: _busy || _link == null ? null : _openBot,
        color: PColors.field,
        textColor: PColors.ink,
      ),
      _field(_code, '6-digit code', digits: true, onDone: _verify),
      _errorLine(),
      const SizedBox(height: 16),
      PillButton(
        label: _busy ? 'Checking…' : (widget.link ? 'Verify' : 'Continue'),
        onTap: _verify,
      ),
      const SizedBox(height: 4),
      Row(
        children: [
          Expanded(child: Text('Didn’t get a code?', style: PType.small())),
          _textLink('New link', _newLink),
        ],
      ),
      Text(
        widget.link
            ? 'After this you can also log in with your Telegram username.'
            : 'Can’t open Telegram? Go back and use your email instead.',
        style: PType.small(),
      ),
    ],
  );

  Widget _passwordStep(TelegramSignup s) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _header(PIcon.user, 'Set your app password'),
      const SizedBox(height: 16),
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
      const SizedBox(height: 4),
      _field(_password, 'Password (at least 8 characters)', secret: true),
      _field(_again, 'Password again', secret: true),
      _field(_invite, 'Invite code (optional)', onDone: _create),
      _errorLine(),
      const SizedBox(height: 16),
      PillButton(label: _busy ? 'Creating…' : 'Create account', onTap: _create),
    ],
  );
}

/// The reference's login header, rebuilt: a navy plane cut on the
/// diagonal, a blue plane crossing it, an ice sliver where they fold.
class _CutHeader extends CustomPainter {
  const _CutHeader();

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.white);
    final navy = roundedPolygon([
      const Offset(-40, -40),
      Offset(w * 0.80, -40),
      Offset(w * 0.56, h * 0.84),
      Offset(-40, h * 0.84),
    ], 34);
    final ice = roundedPolygon([
      Offset(w * 0.70, -40),
      Offset(w * 0.86, -40),
      Offset(w * 0.62, h * 0.62),
      Offset(w * 0.46, h * 0.62),
    ], 28);
    final blue = roundedPolygon([
      Offset(w * 0.84, -40),
      Offset(w + 40, -40),
      Offset(w + 40, h * 0.97),
      Offset(w * 0.47, h * 0.97),
    ], 40);
    canvas.drawPath(navy, Paint()..color = PColors.navy);
    canvas.drawPath(ice, Paint()..color = PColors.ice);
    canvas.drawPath(blue, Paint()..color = PColors.blue);
    // Fold: where blue crosses the navy plane it darkens.
    canvas.drawPath(
      Path.combine(PathOperation.intersect, navy, blue),
      Paint()..color = PColors.pressed,
    );
  }

  @override
  bool shouldRepaint(_CutHeader old) => false;
}
