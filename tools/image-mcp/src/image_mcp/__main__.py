import os

import uvicorn


def main() -> None:
    from .facade import build_app

    uvicorn.run(build_app(), host=os.environ.get("IMAGE_LISTEN_HOST", "0.0.0.0"),
                port=int(os.environ.get("IMAGE_LISTEN_PORT", "8080")), log_level="info",
                access_log=False, timeout_keep_alive=30, proxy_headers=False)


if __name__ == "__main__":
    main()