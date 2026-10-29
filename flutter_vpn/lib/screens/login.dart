import 'package:flutter/material.dart';

import '../design/geometry.dart';
import '../design/icons.dart';
import '../design/mark.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'confirm.dart';

/// Login: a navy cut header built from the brand planes, the mark on the
/// blue plane, one field and Continue. The backend signs in by email and
/// password only, so "Use a phone number" says so instead of faking it.
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

  void _continue() {
    final v = _email.text.trim();
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v)) {
      setState(() => _error = 'That email address looks incomplete.');
      return;
    }
    setState(() => _error = null);
    FocusScope.of(context).unfocus();
    Navigator.of(context)
        .push(FadeRoute(builder: (_) => ConfirmScreen(address: v)));
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
                  const SizedBox(height: 22),
                  PillButton(label: 'Continue', onTap: _continue),
                  const SizedBox(height: 8),
                  Center(
                    child: Pressable(
                      onTap: () => setState(
                        () => _error =
                            'Phone sign-in isn’t offered. Use your email.',
                      ),
                      label: 'Use a phone number',
                      radius: 20,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 14,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const PIconView(
                              PIcon.phone,
                              size: 18,
                              color: PColors.blue,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'Use a phone number',
                              style: PType.small(color: PColors.blue)
                                  .copyWith(fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Text(
                    AppScope.of(context).api.configured
                        ? 'Sign in with your Cloud Gold account, or create one on the next step.'
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
      _label('Email'),
      _fieldShell(
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          textInputAction: TextInputAction.go,
          onSubmitted: (_) => _continue(),
          style: PType.body().copyWith(fontWeight: FontWeight.w700),
          decoration: _dec('you@example.com'),
        ),
      ),
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
