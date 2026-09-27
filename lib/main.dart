import 'package:flutter/material.dart';

// Minimal wellmagram app entry (OPE-2568 Шаг 3). The full unified UI is
// Фаза 3 (plan-v3); this entry exists so the debug-APK builds and hosts
// the core modules produced by Фазы 1–2.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const WellmagramApp());
}

class WellmagramApp extends StatelessWidget {
  const WellmagramApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'wellmagram',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff2f6f4f)),
      ),
      home: const StatusScreen(),
    );
  }
}

class StatusScreen extends StatelessWidget {
  const StatusScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('wellmagram')),
      body: const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Ядро готово: аккаунты · сессии · TDLib-мост'),
            Text('Фаза 3 (единый UI) — впереди'),
          ],
        ),
      ),
    );
  }
}
