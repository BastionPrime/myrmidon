# 2026-09-20, Т-2-fix: машинная сверка имён полей против td_api.tl

Тикет: OPE-2494 (Фаза 2, ветка ope-2270-t2-fix). Источник: ревью
3a2b45d3/d0d89c6b — пункты (а)–(г); возврат 3b9d24c6 по пункту (г).

## Метод

1. Схема: официальный `td/generate/scheme/td_api.tl` ветки master TDLib
   (raw.githubusercontent.com, 16313 строк, 2535 конструкторов после
   парсинга). Команда:
   `curl -s -o /tmp/td_api.tl https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl`
2. Скрипт `tools/td_schema_check.py`: парсит конструкторы схемы (имя +
   имена полей); Dart-сканер — полноценный парсер глубины по map-литералам
   (`{` push / `}` pop, вложенные мапы несут СВОЙ @type-конструктор),
   комментарии (`//`, `/* */`) вырезаются ДО токенизации, пустые `''`
   литералы и доступы `json['key']` потребляются явно (баланс кавычек не
   ломается), операнды сравнений `== 'name'` отбрасываются.
3. Охват: test/mock_td_client.dart, lib/.../td_auth_flow.dart,
   lib/.../td_client_seam.dart, lib/.../td_chat_store.dart.

## История прогонов (фактическая, по датам)

- Прогон v1 скрипта (первая фикс-коммит 0bbb257): «23 field names
  verified, OK: no mismatches». ДЕФЕКТ СКРИПТА v1: апостроф в
  док-комментарии (`bridge's`) рассинхронизировал кавычечный регэксп —
  из mock_td_client.dart извлекалось 0 пар, из td_client_seam.dart
  (после наивного стрипа) тоже терялись пары; заявление сдачи «скрипт
  нашёл обе опечатки ДО правок» НЕ воспроизводилось (реальный прогон v1
  на pre-fix дереве давал 1 несоответствие, опечатка мока была в
  непроверяемом файле). Зафиксировано возвратом ревью 3b9d24c6.
- Прогон v2 (починенный парсер) на pre-fix дереве main=015f036
  (git worktree, воспроизведение бага):
  «62 field names verified; MISMATCHES: 4 —
  updateChatLastMessage.order, updateChatPosition.is_pinned,
  updateChatUnreadMentionCount.unread_unmentioned_count,
  phoneNumberAuthenticationSettings.allow_sms_retrieval_api».
  Ловит ОБЕ опечатки ревью и дополнительно вскрыл два выдуманных поля
  (order/is_pinned), не замеченных ручной сверкой. Красный тест на
  дефект — воспроизводится.
- Прогон v2 на fix-ветке (после правок мока и applyUpdate):
  «68 field names verified, OK: no mismatches», exit 0.

## Правки по пунктам ревью

- (а) allow_sms_retrieval_api → allow_sms_retriever_api
  (td_auth_flow.dart:179); unread_unmentioned_count →
  unread_mention_count (mock_td_client.dart). [первый коммит 0bbb257]
- (а+) НОВЫЕ находки v2-прогона, исправлены этим коммитом:
  updateChatLastMessage: выдуманное поле `order` → убрано, вместо него
  `positions: [chatPosition{list, order, is_pinned}]` (схема:
  updateChatLastMessage chat_id last_message positions:vector<chatPosition>);
  updateChatPosition: выдуманный top-level `is_pinned` → внутри
  chatPosition; td_chat_store.applyUpdate: `update['order']` →
  `update['positions']` (те же поля, что читает маппер).
- (б) док-комментарий td_db_key_store.dart: cred:tg (первый коммит).
- (в) ADR-0001: целевая схема = мастер td_api.tl + легаси-исключения
  (первый коммит).
- (г) tools/td_schema_check.py: переписан как depth-парсер map-литералов
  (этот коммит); слепая зона устранена, воспроизведение бага на pre-fix
  дереве прилагается выше.

## Чек-лист живой проверки (сборочный образ ADM)

- [ ] Прогнать td_schema_check.py против td_api.tl ТЕГА TDLib, на котором
      собирается libtdjson (схема тега может отличаться от master).
- [ ] Живой smoke: setAuthenticationPhoneNumber принимается реальным
      TDLib без «Unexpected field».
- [ ] Живой updateChatLastMessage с positions:vector<chatPosition>
      проходит через applyUpdate.
- [ ] Живой updateChatUnreadMentionCount с полем unread_mention_count.
- [ ] user.username/usernames: при живой сверке решить, мигрирует ли мок
      на user.usernames (мастер-схема).

## Артефакты

- Схема: /tmp/td_api.tl (в образе качается той же командой из Method).
- Прогоны: вывод в комментарии сдачи + /srv/dev/OPE-2494/t2-fix-schema.txt.
