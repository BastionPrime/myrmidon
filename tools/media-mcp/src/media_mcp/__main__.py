import os
import sys

import uvicorn


def main() -> None:
    role = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MEDIA_ROLE", "facade")).lower()
    if role == "worker":
        from .worker import build_app
        port = int(os.environ.get("MEDIA_LISTEN_PORT", "8081"))
    elif role == "facade":
        from .facade import build_app
        port = int(os.environ.get("MEDIA_LISTEN_PORT", "8080"))
    else:
        raise SystemExit(f"unknown role {role!r}: facade or worker")
    uvicorn.run(build_app(), host=os.environ.get("MEDIA_LISTEN_HOST", "0.0.0.0"), port=port,
                log_level="info", access_log=False, timeout_keep_alive=30,
                proxy_headers=False)


if __name__ == "__main__":
    main()
