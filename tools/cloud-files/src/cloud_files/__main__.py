import asyncio
import sys
from pathlib import Path

from .config import load_settings


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "serve":
        import uvicorn

        from .server import build_app
        cfg = load_settings()
        uvicorn.run(build_app(cfg), host=cfg.listen_host, port=cfg.listen_port, log_level="info",
                    access_log=False, timeout_keep_alive=30, proxy_headers=False)
        return 0
    if cmd == "auth":  # python -m cloud_files auth: device code sign-in of the mailbox owner
        from .graph import TokenStore, device_code_login
        cfg = load_settings(need_acl=False)
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        return asyncio.run(device_code_login(TokenStore(cfg.state_dir, cfg.client_id, cfg.tenant, cfg.scopes),
                                             Path(cfg.state_dir) / "devicecode.json"))
    print("usage: python -m cloud_files [serve|auth]")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
