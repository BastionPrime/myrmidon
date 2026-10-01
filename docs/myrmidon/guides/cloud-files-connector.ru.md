# Файлы и почта Microsoft 365 для ботов-контейнеров

> English version: [cloud-files-connector.md](cloud-files-connector.md)

Служба `tools/cloud-files` даёт ботам-контейнерам доступ к OneDrive и общему
почтовому ящику одного служебного аккаунта Microsoft (личный аккаунт, tenant
`consumers`). Образ собирает workflow `.github/workflows/myrmidon-cloud-files.yml`
и публикуется как `ghcr.io/itkadr-git/myrmidon-cloud-files`; на бою он закреплён
по digest из CI. Подробный справочник — [../cloud-files.md](../cloud-files.md).

## Как бот обращается к службе

```
бот ──▶ шлюз инструментов доски (bearer + x-paperclip-agent-id) ──▶ cloud-files:8080/mcp ──▶ Microsoft Graph
бот ──▶ cloud-files:8080/v1/files  (крупные файлы; личность по имени контейнера в docker DNS)
```

Токен Microsoft хранится только в службе (`/state/token.json`, режим 0600) и
обновляется внутри неё; бот его не видит. Владелец ящика входит один раз по
device-code.

## Что может бот

Бот адресует данные парой `(корень, путь)`. Id элементов не принимаются. Корни и
права задаются для каждого бота в `config/bots.json` (см. `config.example.json`):

- `shared` — папка, которой поделились со служебным аккаунтом, только чтение;
- `own` — папка на собственном диске аккаунта, с режимом `ro`/`rw` на бота;
- режим почты на бота: `none`, `read` или `send`.

`..`, ярлыки OneDrive и выход за пределы корня отклоняются; запись в общий корень
отклоняется при загрузке конфигурации.

Инструменты: `cloud_whoami`, `drive_list`, `drive_search`, `drive_read_text`,
`drive_download`, `drive_upload`, `drive_mkdir`, `drive_move`, `stage_list`,
`stage_delete`, `mail_list`, `mail_search`, `mail_read`,
`mail_attachment_download`, `mail_send` (лимит отправки — 30 писем в час на бота).

Крупные файлы идут через личную промежуточную область бота (TTL 12 часов, квота):
бот скачивает через `drive_download`, затем забирает файл с `/v1/files/<id>`;
загружает `PUT` на `/v1/files?name=…` и затем `drive_upload(file_id=…)`.
Промежуточные файлы одного бота не видны другому.

## Настройка службы (администратор)

1. Поместите контейнер только в сеть `myrmidon-bots`; порты наружу не
   публикуйте. Пример compose — в `compose.example.yml`.
2. Создайте `config/bots.json` из `config.example.json`: назовите корни и задайте
   каждому боту его корни `ro`/`rw` и режим почты. Ключ бота — id агента доски.
3. Войдите один раз как владелец ящика:

   ```sh
   docker compose exec -d cloud-files python -m cloud_files auth
   ```

   Ссылка и код устройства появятся в `/state/devicecode.json` (не секрет).
   Запрашиваемые права: `Files.ReadWrite.All Mail.ReadWrite Mail.Send
   offline_access User.Read`.
4. Подключите доску к службе как приложение `mcp_http`: соединение типа
   `mcp_remote` на `http://cloud-files:8080/mcp` с bearer из секрета и
   `headerPolicy.metadata.forward = ["agent_id"]`.

## Журнал

Каждый вызов пишется в `/state/audit.log` строками JSON: бот, инструмент, корень,
путь, исход. Содержимое файлов и темы или тела писем в журнал не пишутся.
