# cloud-files: коннектор Microsoft 365 для ботов

Служба `tools/cloud-files/` даёт ботам-контейнерам OneDrive и почту одного служебного аккаунта Microsoft
(личный аккаунт, tenant `consumers`). Образ собирает `.github/workflows/myrmidon-cloud-files.yml`:
`ghcr.io/itkadr-git/myrmidon-cloud-files`, на бою только по digest из CI.

```
бот ──▶ шлюз доски (профиль инструментов, bearer + x-paperclip-agent-id) ──▶ cloud-files:8080/mcp ──▶ Microsoft Graph
бот ──▶ cloud-files:8080/v1/files  (крупные файлы, личность по имени контейнера в docker DNS)
```

- **Токен Microsoft хранится только в службе** (`/state/token.json`, 0600), обновляется внутри неё. Бот его не видит.
  Вход владельца один раз: `docker compose exec -d cloud-files python -m cloud_files auth`, ссылка и код
  в `/state/devicecode.json` (не секрет). Права: `Files.ReadWrite.All Mail.ReadWrite Mail.Send offline_access User.Read`.
- **ACL в `config/bots.json`** (образец `config.example.json`): корни (`shared` — чужая папка только на чтение,
  `own` — папка в диске служебного аккаунта) и для каждого бота его корни с режимом `ro`/`rw`, режим почты
  `none`/`read`/`send`. Ключ бота — id агента доски. Бот передаёт корень и путь внутри него, id элементов не принимаются;
  `..`, ярлыки OneDrive и выход за корень отклоняются, запись в чужую папку невозможна на уровне конфигурации.
- **Файлы:** `drive_download` кладёт файл в личную промежуточную папку бота (12 ч, квота), бот забирает его
  `curl -o имя http://cloud-files:8080/v1/files/<id>`; загрузка — `curl -T файл '…/v1/files?name=имя'`, затем
  `drive_upload(file_id=…)`. Файлы одного бота другому не видны.
- **Инструменты:** `cloud_whoami`, `drive_list`, `drive_search`, `drive_read_text`, `drive_download`, `drive_upload`,
  `drive_mkdir`, `drive_move`, `stage_list`, `stage_delete`, `mail_list`, `mail_search`, `mail_read`,
  `mail_attachment_download`, `mail_send` (лимит 30 писем в час на бота).
- **Журнал:** `/state/audit.log` (JSON-строки: бот, инструмент, корень, путь, исход; без содержимого файлов и писем).
- **Сеть:** только `myrmidon-bots`, порты наружу не публикуются. Подключение к доске: приложение `mcp_http`,
  соединение `mcp_remote` на `http://cloud-files:8080/mcp` с bearer из секрета и `headerPolicy.metadata.forward = ["agent_id"]`.
