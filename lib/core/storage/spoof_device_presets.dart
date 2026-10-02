/// Plausible device presets for spoof generation (plan-v3 Т-1.6:
/// «генерация правдоподобных пар (таблица model/os_version)»).
///
/// Data mirrors the shape of upstream device_presets.dart (Komet 1ae0731:
/// 98 пресетов, 38 ANDROID/24 IOS/WEB, пары model↔osVersion согласованы);
/// wellmagram keeps a curated table — MAX-сервер видит ANDROID-клиент,
/// поэтому генератор использует только ANDROID-строки. Пары model/os_version
/// валидны вместе (Pixel 8 Pro не бывает на Android 11), как в upstream.
/// Каждая модель — реальное серийное устройство 2022–2026, os_version в
/// диапазоне «с завода … максимум обновлений» по спецификации (источники
/// ниже); ua-модель и разрешение экрана взяты из той же спецификации.
/// Таймзона/локаль/Chrome-версия подобраны правдоподобно к os_version.
///
/// Original curated entries (sources):
/// - Samsung Galaxy S24 Ultra (SM-S928B): https://www.gsmarena.com/samsung_galaxy_s24_ultra-12771.php
/// - Google Pixel 8 Pro: https://www.gsmarena.com/google_pixel_8_pro-12545.php
/// - Xiaomi 13 Pro: https://www.gsmarena.com/xiaomi_13_pro-11962.php
/// - Samsung Galaxy S21 Ultra (SM-G998B): https://www.gsmarena.com/samsung_galaxy_s21_ultra-10746.php
/// - Google Pixel 6: https://www.gsmarena.com/google_pixel_6-11031.php
/// - Sony Xperia 1 V (XQ-DQ72): https://www.gsmarena.com/sony_xperia_1_v-12263.php
/// - Samsung Galaxy A54 (SM-A546B): https://www.gsmarena.com/samsung_galaxy_a54-11901.php
/// - Redmi Note 11 Pro (2201117TY): https://www.gsmarena.com/redmi_note_11_pro-11331.php
///
/// Preset sources (one GSMArena spec page per model; os_version ranges
/// derived from the shipped OS version and the promised max update):
/// - Asus ROG Phone 7 (AI2205): https://www.gsmarena.com/asus_rog_phone_7-12223.php
/// - Asus Zenfone 10 (AI2302): https://www.gsmarena.com/asus_zenfone_10-12380.php
/// - Google Pixel 7a (Pixel 7a): https://www.gsmarena.com/google_pixel_7a-12170.php
/// - Google Pixel 8 (Pixel 8): https://www.gsmarena.com/google_pixel_8-12546.php
/// - Google Pixel 8a (Pixel 8a): https://www.gsmarena.com/google_pixel_8a-12937.php
/// - Google Pixel 9 (Pixel 9): https://www.gsmarena.com/google_pixel_9-13219.php
/// - Google Pixel 9 Pro (Pixel 9 Pro): https://www.gsmarena.com/google_pixel_9_pro-13218.php
/// - Google Pixel 9 Pro XL (Pixel 9 Pro XL): https://www.gsmarena.com/google_pixel_9_pro_xl-13217.php
/// - Google Pixel 9a (Pixel 9a): https://www.gsmarena.com/google_pixel_9a-13478.php
/// - Honor 200 (ELI-AN00): https://www.gsmarena.com/honor_200-13050.php
/// - Honor 90 (REA-AN00): https://www.gsmarena.com/honor_90-12297.php
/// - Honor Magic5 Pro (PGT-AN10): https://www.gsmarena.com/honor_magic5_pro-12148.php
/// - Honor Magic6 Pro (BVL-AN16): https://www.gsmarena.com/honor_magic6_pro-12786.php
/// - Honor Magic7 Pro (PTP-N49): https://www.gsmarena.com/honor_magic7_pro-13480.php
/// - Motorola Edge 40 (XT2303-2): https://www.gsmarena.com/motorola_edge_40-12204.php
/// - Motorola Edge 50 Pro (XT2403-2): https://www.gsmarena.com/motorola_edge_50_pro-12909.php
/// - Motorola Moto G84 5G (XT2347-1): https://www.gsmarena.com/motorola_moto_g84-12526.php
/// - Motorola Razr 40 (XT2323-2): https://www.gsmarena.com/motorola_razr_40-12311.php
/// - OnePlus 11 (PHB110): https://www.gsmarena.com/oneplus_11-11893.php
/// - OnePlus 12 (PJD110): https://www.gsmarena.com/oneplus_12-12725.php
/// - OnePlus 13 (CPH2655): https://www.gsmarena.com/oneplus_13-13477.php
/// - OnePlus Nord 3 (CPH2491): https://www.gsmarena.com/oneplus_nord_3-12135.php
/// - OnePlus Nord 4 (CPH2663): https://www.gsmarena.com/oneplus_nord_4-13200.php
/// - Oppo Find X6 Pro (PGEM110): https://www.gsmarena.com/oppo_find_x6_pro-12105.php
/// - Oppo Reno 11 (CPH2599): https://www.gsmarena.com/oppo_reno11-12791.php
/// - Redmi Note 12 (22111317G): https://www.gsmarena.com/xiaomi_redmi_note_12-12063.php
/// - Redmi Note 12 Pro (22101316C): https://www.gsmarena.com/xiaomi_redmi_note_12_pro-11955.php
/// - Redmi Note 13 Pro (2312DRA50C): https://www.gsmarena.com/xiaomi_redmi_note_13_pro-12581.php
/// - Redmi Note 14 (24094RAD4I): https://www.gsmarena.com/xiaomi_redmi_note_14-13559.php
/// - Samsung Galaxy A35 5G (SM-A356E): https://www.gsmarena.com/samsung_galaxy_a35-12705.php
/// - Samsung Galaxy A54 5G (SM-A546B): https://www.gsmarena.com/samsung_galaxy_a54-12070.php
/// - Samsung Galaxy A55 5G (SM-A556V): https://www.gsmarena.com/samsung_galaxy_a55-12824.php
/// - Samsung Galaxy S23 (SM-S911B): https://www.gsmarena.com/samsung_galaxy_s23-12082.php
/// - Samsung Galaxy S23 FE (SM-S711B): https://www.gsmarena.com/samsung_galaxy_s23_fe-12520.php
/// - Samsung Galaxy S23 Ultra (SM-S918B): https://www.gsmarena.com/samsung_galaxy_s23_ultra-12024.php
/// - Samsung Galaxy S23+ (SM-S916B): https://www.gsmarena.com/samsung_galaxy_s23+-12083.php
/// - Samsung Galaxy S24 (SM-S921B): https://www.gsmarena.com/samsung_galaxy_s24-12773.php
/// - Samsung Galaxy S24 FE (SM-S721B): https://www.gsmarena.com/samsung_galaxy_s24_fe-13262.php
/// - Samsung Galaxy S24+ (SM-S926B): https://www.gsmarena.com/samsung_galaxy_s24+-12772.php
/// - Samsung Galaxy S25 (SM-S931B): https://www.gsmarena.com/samsung_galaxy_s25-13610.php
/// - Samsung Galaxy S25 Edge (SM-S937U): https://www.gsmarena.com/samsung_galaxy_s25_edge-13506.php
/// - Samsung Galaxy S25 Ultra (SM-S938B): https://www.gsmarena.com/samsung_galaxy_s25_ultra-13322.php
/// - Samsung Galaxy Z Flip5 (SM-F731B): https://www.gsmarena.com/samsung_galaxy_z_flip5-12252.php
/// - Samsung Galaxy Z Flip6 (SM-F741B): https://www.gsmarena.com/samsung_galaxy_z_flip6-13192.php
/// - Samsung Galaxy Z Fold5 (SM-F946B): https://www.gsmarena.com/samsung_galaxy_z_fold5-12418.php
/// - Samsung Galaxy Z Fold6 (SM-F956B): https://www.gsmarena.com/samsung_galaxy_z_fold6-13147.php
/// - Sony Xperia 10 V (XQ-DC72): https://www.gsmarena.com/sony_xperia_10_v-12264.php
/// - Sony Xperia 5 V (XQ-DE54): https://www.gsmarena.com/sony_xperia_5_v-12534.php
/// - Xiaomi 13 (2211133C): https://www.gsmarena.com/xiaomi_13-12013.php
/// - Xiaomi 13 Ultra (2304FPN6DC): https://www.gsmarena.com/xiaomi_13_ultra-12236.php
/// - Xiaomi 14 (23127PN0CC): https://www.gsmarena.com/xiaomi_14-12626.php
/// - Xiaomi 14 Ultra (24031PN0DC): https://www.gsmarena.com/xiaomi_14_ultra-12827.php
/// - Xiaomi 15 (24129PN74G): https://www.gsmarena.com/xiaomi_15-13472.php
/// - Xiaomi POCO F5 (23049PCD8G): https://www.gsmarena.com/xiaomi_poco_f5-12258.php
/// - Xiaomi POCO F6 (24069PC21G): https://www.gsmarena.com/xiaomi_poco_f6-13000.php
/// - Xiaomi POCO X6 Pro (2311DRK48G): https://www.gsmarena.com/xiaomi_poco_x6_pro-12717.php
/// - realme 12 Pro+ (RMX3840): https://www.gsmarena.com/realme_12_pro+-12804.php
/// - realme GT 5 (RMX3820): https://www.gsmarena.com/realme_gt5-12528.php
/// - vivo V29 (V2250): https://www.gsmarena.com/vivo_v29-12461.php
/// - vivo X100 Pro (V2324A): https://www.gsmarena.com/vivo_x100_pro-12694.php
///
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
  SpoofDevicePreset(
    deviceName: 'Asus ROG Phone 7',
    osVersion: 'Android 13',
    screen: 'xxhdpi 395dpi 1080x2448',
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; AI2205) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Asus Zenfone 10',
    osVersion: 'Android 15',
    screen: 'xxhdpi 445dpi 1080x2400',
    timezone: 'America/New_York',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; AI2302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 7a',
    osVersion: 'Android 16',
    screen: 'xxhdpi 429dpi 1080x2400',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 8',
    osVersion: 'Android 14',
    screen: 'xxhdpi 428dpi 1080x2400',
    timezone: 'Europe/London',
    locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 8a',
    osVersion: 'Android 16',
    screen: 'xxhdpi 430dpi 1080x2400',
    timezone: 'America/Chicago',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 9',
    osVersion: 'Android 16',
    screen: 'xxhdpi 422dpi 1080x2424',
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 9 Pro',
    osVersion: 'Android 14',
    screen: 'xxxhdpi 495dpi 1280x2856',
    timezone: 'Australia/Sydney',
    locale: 'en-AU',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 9 Pro XL',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 486dpi 1344x2992',
    timezone: 'Europe/Rome',
    locale: 'it-IT',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Google Pixel 9a',
    osVersion: 'Android 16',
    screen: 'xxhdpi 422dpi 1080x2424',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Honor 200',
    osVersion: 'Android 14',
    screen: 'xxhdpi 436dpi 1200x2664',
    timezone: 'Europe/Madrid',
    locale: 'es-ES',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; ELI-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Honor 90',
    osVersion: 'Android 14',
    screen: 'xxhdpi 435dpi 1200x2664',
    timezone: 'Asia/Seoul',
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; REA-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Honor Magic5 Pro',
    osVersion: 'Android 14',
    screen: 'xxhdpi 460dpi 1312x2848',
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; PGT-AN10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Honor Magic6 Pro',
    osVersion: 'Android 14',
    screen: 'xxhdpi 453dpi 1280x2800',
    timezone: 'Europe/Warsaw',
    locale: 'pl-PL',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; BVL-AN16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Honor Magic7 Pro',
    osVersion: 'Android 16',
    screen: 'xxhdpi 453dpi 1280x2800',
    timezone: 'Asia/Singapore',
    locale: 'en-SG',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; PTP-N49) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Motorola Edge 40',
    osVersion: 'Android 14',
    screen: 'xxhdpi 402dpi 1080x2400',
    timezone: 'Europe/Amsterdam',
    locale: 'nl-NL',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; XT2303-2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Motorola Edge 50 Pro',
    osVersion: 'Android 14',
    screen: 'xxhdpi 446dpi 1220x2712',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; XT2403-2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Motorola Moto G84 5G',
    osVersion: 'Android 15',
    screen: 'xxhdpi 405dpi 1080x2400',
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; XT2347-1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Motorola Razr 40',
    osVersion: 'Android 15',
    screen: 'xxhdpi 413dpi 1080x2640',
    timezone: 'America/New_York',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; XT2323-2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'OnePlus 11',
    osVersion: 'Android 13',
    screen: 'xxxhdpi 525dpi 1440x3216',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; PHB110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'OnePlus 12',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 510dpi 1440x3168',
    timezone: 'Europe/London',
    locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; PJD110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'OnePlus 13',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 510dpi 1440x3168',
    timezone: 'America/Chicago',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; CPH2655) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'OnePlus Nord 3',
    osVersion: 'Android 13',
    screen: 'xxhdpi 451dpi 1240x2772',
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; CPH2491) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'OnePlus Nord 4',
    osVersion: 'Android 16',
    screen: 'xxhdpi 450dpi 1240x2772',
    timezone: 'Australia/Sydney',
    locale: 'en-AU',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; CPH2663) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Oppo Find X6 Pro',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 510dpi 1440x3168',
    timezone: 'Europe/Rome',
    locale: 'it-IT',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; PGEM110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Oppo Reno 11',
    osVersion: 'Android 14',
    screen: 'xxhdpi 394dpi 1080x2412',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; CPH2599) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Redmi Note 12',
    osVersion: 'Android 14',
    screen: 'xxhdpi 395dpi 1080x2400',
    timezone: 'Europe/Madrid',
    locale: 'es-ES',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; 22111317G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Redmi Note 12 Pro',
    osVersion: 'Android 15',
    screen: 'xxhdpi 395dpi 1080x2400',
    timezone: 'Asia/Seoul',
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; 22101316C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Redmi Note 13 Pro',
    osVersion: 'Android 13',
    screen: 'xxhdpi 446dpi 1220x2712',
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 2312DRA50C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Redmi Note 14',
    osVersion: 'Android 15',
    screen: 'xxhdpi 395dpi 1080x2400',
    timezone: 'Europe/Warsaw',
    locale: 'pl-PL',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; 24094RAD4I) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy A35 5G',
    osVersion: 'Android 16',
    screen: 'xxhdpi 390dpi 1080x2340',
    timezone: 'Asia/Singapore',
    locale: 'en-SG',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-A356E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy A54 5G',
    osVersion: 'Android 13',
    screen: 'xxhdpi 403dpi 1080x2340',
    timezone: 'Europe/Amsterdam',
    locale: 'nl-NL',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy A55 5G',
    osVersion: 'Android 16',
    screen: 'xxhdpi 390dpi 1080x2340',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-A556V) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S23',
    osVersion: 'Android 16',
    screen: 'xxhdpi 425dpi 1080x2340',
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S23 FE',
    osVersion: 'Android 13',
    screen: 'xxhdpi 403dpi 1080x2340',
    timezone: 'America/New_York',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S23 Ultra',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 500dpi 1440x3088',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S23+',
    osVersion: 'Android 16',
    screen: 'xxhdpi 393dpi 1080x2340',
    timezone: 'Europe/London',
    locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S916B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S24',
    osVersion: 'Android 14',
    screen: 'xxhdpi 416dpi 1080x2340',
    timezone: 'America/Chicago',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S24 FE',
    osVersion: 'Android 16',
    screen: 'xxhdpi 385dpi 1080x2340',
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S721B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S24+',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 513dpi 1440x3120',
    timezone: 'Australia/Sydney',
    locale: 'en-AU',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S25',
    osVersion: 'Android 15',
    screen: 'xxhdpi 416dpi 1080x2340',
    timezone: 'Europe/Rome',
    locale: 'it-IT',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S25 Edge',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 513dpi 1440x3120',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S937U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy S25 Ultra',
    osVersion: 'Android 16',
    screen: 'xxxhdpi 498dpi 1440x3120',
    timezone: 'Europe/Madrid',
    locale: 'es-ES',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy Z Flip5',
    osVersion: 'Android 13',
    screen: 'xxhdpi 425dpi 1080x2640',
    timezone: 'Asia/Seoul',
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-F731B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy Z Flip6',
    osVersion: 'Android 16',
    screen: 'xxhdpi 426dpi 1080x2640',
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-F741B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy Z Fold5',
    osVersion: 'Android 16',
    screen: 'xxhdpi 373dpi 1812x2176',
    timezone: 'Europe/Warsaw',
    locale: 'pl-PL',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-F946B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Samsung Galaxy Z Fold6',
    osVersion: 'Android 14',
    screen: 'xxhdpi 374dpi 1856x2160',
    timezone: 'Asia/Singapore',
    locale: 'en-SG',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-F956B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Sony Xperia 10 V',
    osVersion: 'Android 15',
    screen: 'xxhdpi 449dpi 1080x2520',
    timezone: 'Europe/Amsterdam',
    locale: 'nl-NL',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; XQ-DC72) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Sony Xperia 5 V',
    osVersion: 'Android 15',
    screen: 'xxhdpi 449dpi 1080x2520',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; XQ-DE54) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi 13',
    osVersion: 'Android 13',
    screen: 'xxhdpi 414dpi 1080x2400',
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi 13 Ultra',
    osVersion: 'Android 14',
    screen: 'xxxhdpi 522dpi 1440x3200',
    timezone: 'America/New_York',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; 2304FPN6DC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi 14',
    osVersion: 'Android 15',
    screen: 'xxhdpi 460dpi 1200x2670',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi 14 Ultra',
    osVersion: 'Android 14',
    screen: 'xxxhdpi 522dpi 1440x3200',
    timezone: 'Europe/London',
    locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; 24031PN0DC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi 15',
    osVersion: 'Android 16',
    screen: 'xxhdpi 460dpi 1200x2670',
    timezone: 'America/Chicago',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; 24129PN74G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi POCO F5',
    osVersion: 'Android 15',
    screen: 'xxhdpi 395dpi 1080x2400',
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; 23049PCD8G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi POCO F6',
    osVersion: 'Android 14',
    screen: 'xxhdpi 446dpi 1220x2712',
    timezone: 'Australia/Sydney',
    locale: 'en-AU',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; 24069PC21G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'Xiaomi POCO X6 Pro',
    osVersion: 'Android 15',
    screen: 'xxhdpi 446dpi 1220x2712',
    timezone: 'Europe/Rome',
    locale: 'it-IT',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; 2311DRK48G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'realme 12 Pro+',
    osVersion: 'Android 15',
    screen: 'xxhdpi 394dpi 1080x2412',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; RMX3840) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'realme GT 5',
    osVersion: 'Android 13',
    screen: 'xxhdpi 451dpi 1240x2772',
    timezone: 'Europe/Madrid',
    locale: 'es-ES',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; RMX3820) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'vivo V29',
    osVersion: 'Android 15',
    screen: 'xxhdpi 453dpi 1260x2800',
    timezone: 'Asia/Seoul',
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; V2250) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
  ),
  SpoofDevicePreset(
    deviceName: 'vivo X100 Pro',
    osVersion: 'Android 15',
    screen: 'xxhdpi 452dpi 1260x2800',
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; V2324A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  ),
];

/// Client identity pinned to the upstream spoof profile (spoofing_service
/// .dart:13-14): appVersion/buildNumber are hardcoded, not generated.
const String spoofAppVersion = '26.23.2';
const int spoofBuildNumber = 6779;
