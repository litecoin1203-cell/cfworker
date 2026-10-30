import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/client.dart';
import 'design/tokens.dart';
import 'screens/splash.dart';
import 'state/app_state.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: Colors.white,
      systemNavigationBarIconBrightness: Brightness.dark,
    ),
  );
  final prefs = await SharedPreferences.getInstance();
  final tokens = TokenStore();
  await tokens.load();
  final state = AppState(prefs, ApiClient(tokens));
  await state.loadDevice();
  // Last launch's values show at once; fresh ones load behind them.
  await state.warmStart();
  state.signedIn ? state.refreshAccount() : state.loadPublic();
  state.resumeTunnel();
  runApp(PleatApp(state: state));
}

class PleatApp extends StatelessWidget {
  const PleatApp({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
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
    colorScheme: ColorScheme.fromSeed(
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
