# Инструкция применения media-скриптов в живом дереве bbq-workspace (vm-core)

Скрипты лежат в репозитории: tools/media-mcp/bot-scripts/ (эта директория).
Файлы идентичны вложениям тикета OPE-3288 (sha256 см. в комментарии сдачи);
media_shim_full.py сохранён здесь как media_shim.py — имя, которое импортирует
патч-хвост, переименование при установке больше не нужно.

Адресат: у кого есть доступ к контейнеру профилей bbq на vm-core
(живое дерево /home/hermes/.hermes/shared/bbq-workspace, uid 1000, канон путей OPE-1835).
Исполнять под тем же uid, что и владельцы дерева.

## Состав деливерабла (из песочницы vm-exec, ран 30.09)

- media_client.py — клиент MCP media-mcp (stdlib-only, python 3.13 контейнера бота).
- media_shim_full.py — drop-in слой: video_info (контракт _video_info OPE-2384),
  run_ffmpeg / subprocess_run_shim (CompletedProcess-контракт), patch_tail().
- test_media_client.py, test_media_shim_full.py, shorts_gate.py — проверки.
- Все файлы: приложить рядом, патч-хвост — применить к post_media_prep.py (п. 3).

## 1. Положить модули

cp media_client.py media_shim.py \
   /home/hermes/.hermes/shared/bbq-workspace/tools/posts/

(В репозитории хранится только полная версия под именем media_shim.py —
импортируется патч-хвостом. Лёгкая версия не нужна: наличие локального
ffmpeg переключает поведение обратно без отдельного файла.)

## 2. Переменные окружения бота (контейнер video-director/smm/operator)

export MEDIA_TOOLS_URL=http://media-mcp:8080   # имя в docker-сети ботов
export MEDIA_TOOLS_TOKEN=<bot token>           # запись бота в config/bots.json медиасервиса
# необязательные: MEDIA_TOOLS_POLL_INTERVAL (с, по умолчанию 2),
# MEDIA_TOOLS_POLL_TIMEOUT (с, по умолчанию 1800)

## 3. Патч post_media_prep.py (хвост, ~21 строка)

Дописать в конец файла блок из media_shim_full.py::patch_tail() —
python3 -c "import media_shim; open('patch_tail.txt','w').write(media_shim.patch_tail())"
и append patch_tail.txt к tools/posts/post_media_prep.py.

Блок: подмена _video_info (ffprobe→media_probe, контракт OPE-2384) и обёртка
subprocess.run для argv[0]=='ffmpeg' через сервис, только если локального ffmpeg нет.
Существующие 66 вызовов ffmpeg/2 ffprobe самих вызовов не меняются.

## 4. media_look.py

Точки вызова ffmpeg (2) — обёртка тем же media_shim.run_ffmpeg:
в местах subprocess.run([... 'ffmpeg' ...]) заменить на media_shim.run_ffmpeg(argv, cwd=...)
или добавить тот же хвост (клип-конверсия там простая: -i in -ss/-t out).

## 5. Проверка после применения (в контейнере бота, ffmpeg отсутствует)

cd tools/posts
python3 test_media_shim_full.py     # 9/9 PASS (живой media-mcp)
python3 shorts_gate.py <мастер.mp4> # Shorts 9:16 ≤58 c — PASS
sha256sum post_media_prep.py        # зафиксировать до/после патча (канон OPE-1835)

## 6. Приёмочный критерий тикета

video-director: реальный мастер RQ-002 → select/render пост_media_prep → Shorts ≤58 c,
9:16 → проверка probe+sha256. Готово = все шаги живые, лог в комментарий тикета.
