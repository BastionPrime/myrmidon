/// Plausible device presets for spoof generation (plan-v3 Т-1.6:
/// «генерация правдоподобных пар (таблица model/os_version)»).
///
/// Data mirrors the shape of upstream device_presets.dart (Komet 1ae0731:
/// 98 пресетов, 38 ANDROID/24 IOS/WEB, пары model↔osVersion согласованы);
/// wellmagram keeps a compact curated subset — MAX-сервер видит ANDROID-клиент,
/// поэтому генератор использует только ANDROID-строки. Пары model/os_version
/// валидны вместе (Pixel 8 Pro не бывает на Android 11), как в upstream.
library;

class SpoofDevicePreset {
  final String deviceName;
  final String osVersion;
  final String screen;
  final String timezone;
  final String locale;
  final String userAgent;

  const SpoofDevicePreset({
    required this.deviceName,
    required this.osVersion,
    required this.screen,
    required this.timezone,
    required this.locale,
    required this.userAgent,
  });
}

const List<SpoofDevicePreset> spoofDevicePresets = [
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S24 Ultra',
    osVersion: 'Android 14',
    screen: 'xxhdpi 450dpi 1440x3120',
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 8 Pro',
    osVersion: 'Android 14',
    screen: 'xxhdpi 430dpi 1344x2992',
    timezone: 'America/New_York',
    locale: 'en-US',
    userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi 13 Pro',
    osVersion: 'Android 13',
    screen: 'xxhdpi 460dpi 1440x3200',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    userAgent:
        'Mozilla/5.0 (Linux; Android 13; 2210132C) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S21 Ultra',
    osVersion: 'Android 13',
    screen: 'xxhdpi 515dpi 1440x3200',
    timezone: 'Europe/London',
    locale: 'en-GB',
    userAgent:
        'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 6',
    osVersion: 'Android 12',
    screen: 'xxhdpi 420dpi 1080x2400',
    timezone: 'America/Chicago',
    locale: 'en-US',
    userAgent:
        'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Sony Xperia 1 V',
    osVersion: 'Android 14',
    screen: 'xxhdpi 420dpi 1644x3840',
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    userAgent:
        'Mozilla/5.0 (Linux; Android 14; XQ-DQ72) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy A54',
    osVersion: 'Android 14',
    screen: 'xxhdpi 450dpi 1080x2340',
    timezone: 'Australia/Sydney',
    locale: 'en-AU',
    userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Redmi Note 11 Pro',
    osVersion: 'Android 12',
    screen: 'xxhdpi 440dpi 1080x2400',
    timezone: 'Europe/Rome',
    locale: 'it-IT',
    userAgent:
        'Mozilla/5.0 (Linux; Android 12; 2201117TY) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  ),
];

/// Client identity pinned to the upstream spoof profile (spoofing_service
/// .dart:13-14): appVersion/buildNumber are hardcoded, not generated.
const String spoofAppVersion = '26.23.2';
const int spoofBuildNumber = 6779;
