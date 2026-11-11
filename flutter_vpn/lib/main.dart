import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/client.dart';
import 'design/tokens.dart';
import 'screens/splash.dart';
import 'state/app_state.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final tokens = TokenStore();
  await tokens.load();
  final state = AppState(prefs, ApiClient(tokens));
  // An error the app survives still goes to the health reports (type and
  // the first frames, scrubbed); Flutter's own handling stays as it was.
  final shown = FlutterError.onError;
  FlutterError.onError = (d) {
    state.noteAppError(d.exception, d.stack);
    shown?.call(d);
  };
  WidgetsBinding.instance.platformDispatcher.onError = (e, st) {
    state.noteAppError(e, st);
    return false;
  };
  await state.loadDevice();
  // Last launch's values show at once; fresh ones load behind them.
  await state.warmStart();
  state.signedIn ? state.refreshAccount() : state.loadPublic();
  state.resumeTunnel();
  runApp(PleatApp(state: state));
}

class PleatApp extends StatefulWidget {
  const PleatApp({super.key, required this.state});
  final AppState state;

  @override
  State<PleatApp> createState() => _PleatAppState();
}

/// Holds the Day / Night palette. Every widget reads its colours from
/// [PColors] while it builds, so a switch swaps the palette and asks the
/// whole tree to build again, in place: the screen you are on stays open.
class _PleatAppState extends State<PleatApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.state.addListener(_sync);
    _apply(_wanted(), rebuild: false);
  }

  @override
  void dispose() {
    widget.state.removeListener(_sync);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangePlatformBrightness() => _sync();

  PPalette _wanted() => PThemes.resolve(
    widget.state.theme,
    WidgetsBinding.instance.platformDispatcher.platformBrightness,
  );

  void _sync() {
    final next = _wanted();
    if (!identical(next, PColors.current)) _apply(next);
  }

  void _apply(PPalette p, {bool rebuild = true}) {
    PColors.current = p;
    final dark = p.isDark;
    SystemChrome.setSystemUIOverlayStyle(
      SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
        statusBarBrightness: dark ? Brightness.dark : Brightness.light,
        systemNavigationBarColor: p.surface,
        systemNavigationBarIconBrightness: dark
            ? Brightness.light
            : Brightness.dark,
      ),
    );
    if (!rebuild || !mounted) return;
    setState(() {});
    void mark(Element e) {
      e.markNeedsBuild();
      e.visitChildren(mark);
    }

    (context as Element).visitChildren(mark);
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    return AppScope(
      state: state,
      child: MaterialApp(
        title: 'Pleat',
        debugShowCheckedModeBanner: false,
        theme: pleatTheme(),
        // The in-app "Reduce motion" switch joins the OS setting.
        builder: (context, child) {
          final app = AppScope.of(context);
          final mq = MediaQuery.of(context);
          return MediaQuery(
            data: mq.copyWith(
              disableAnimations: mq.disableAnimations || app.reduceMotion,
            ),
            child: child!,
          );
        },
        home: const SplashScreen(),
      ),
    );
  }
}

/// Material's visual defaults are switched off: no ripple, no grey splash,
/// no tinted surfaces, no default page transition.
ThemeData pleatTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: PColors.current.brightness,
    colorScheme: ColorScheme.fromSeed(
      brightness: PColors.current.brightness,
      seedColor: PColors.blue,
      primary: PColors.blue,
      surface: PColors.surface,
      onSurface: PColors.ink,
    ),
  );
  return base.copyWith(
    scaffoldBackgroundColor: PColors.ground,
    splashFactory: NoSplash.splashFactory,
    splashColor: Colors.transparent,
    highlightColor: Colors.transparent,
    hoverColor: Colors.transparent,
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: PColors.blue,
      selectionColor: PColors.ice,
      selectionHandleColor: PColors.blue,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
    ),
  );
}
