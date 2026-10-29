import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/geometry.dart';
import '../design/icons.dart';
import '../design/mark.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import 'confirm.dart';

/// Login: a navy cut header built from the brand planes, the mark on the
/// blue plane, one field and Continue. "Use a phone number" swaps the
/// field with an animated height change.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _phone = false;
  final _email = TextEditingController();
  final _number = TextEditingController();
  String _code = '+49';
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _number.dispose();
    super.dispose();
  }

  void _continue() {
    final String address;
    if (_phone) {
      final digits = _number.text.replaceAll(RegExp(r'\D'), '');
      if (digits.length < 7) {
        setState(() => _error = 'Enter at least 7 digits.');
        return;
      }
      address = '$_code $digits';
    } else {
      final v = _email.text.trim();
      if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v)) {
        setState(() => _error = 'That email address looks incomplete.');
        return;
      }
      address = v;
    }
    setState(() => _error = null);
    FocusScope.of(context).unfocus();
    Navigator.of(context).push(
      FadeRoute(
        builder: (_) => ConfirmScreen(address: address, byPhone: _phone),
      ),
    );
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
                  AnimatedSize(
                    duration: reduced ? Duration.zero : PMotion.state,
                    curve: Curves.easeInOutCubic,
                    alignment: Alignment.topCenter,
                    child: AnimatedSwitcher(
                      duration: reduced ? Duration.zero : PMotion.quick,
                      child: _phone ? _phoneField() : _emailField(),
                    ),
                  ),
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
                      onTap: () => setState(() {
                        _phone = !_phone;
                        _error = null;
                      }),
                      label: _phone
                          ? 'Use an email address'
                          : 'Use a phone number',
                      radius: 20,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 14,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            PIconView(
                              _phone ? PIcon.mail : PIcon.phone,
                              size: 18,
                              color: PColors.blue,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              _phone
                                  ? 'Use an email address'
                                  : 'Use a phone number',
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
                    'Demo app. No account is created and nothing leaves this phone.',
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

  Widget _phoneField() => Column(
    key: const ValueKey('phone'),
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _label('Country'),
      SizedBox(
        height: 48,
        child: ListView(
          scrollDirection: Axis.horizontal,
          children: [
            for (final c in const ['+49', '+31', '+41', '+44', '+1'])
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Pressable(
                  onTap: () => setState(() => _code = c),
                  label: 'Country code $c',
                  selected: c == _code,
                  radius: PRadius.pill,
                  color: c == _code ? PColors.navy : PColors.field,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 18),
                    alignment: Alignment.center,
                    child: Text(
                      c,
                      style: PType.small(
                        color: c == _code ? Colors.white : PColors.ink,
                      ).copyWith(fontWeight: FontWeight.w700),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      _label('Phone number'),
      _fieldShell(
        Row(
          children: [
            Text(
              _code,
              style: PType.body().copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                controller: _number,
                keyboardType: TextInputType.phone,
                autofillHints: const [AutofillHints.telephoneNumberNational],
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9 ]')),
                ],
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => _continue(),
                style: PType.body().copyWith(fontWeight: FontWeight.w700),
                decoration: _dec('151 2345 678'),
              ),
            ),
          ],
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
