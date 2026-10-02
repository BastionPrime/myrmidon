"""OneDrive operations confined to one root. Bots give (root, path); ids never come from a bot."""

from __future__ import annotations

import httpx
from urllib.parse import quote

from .config import Root
from .graph import Graph, GraphError, graph_error
from .paths import norm_name

SELECT = "id,name,size,folder,file,remoteItem,package,parentReference,lastModifiedDateTime"
CHUNK = 320 * 1024 * 32  # 10 MiB, a multiple of 320 KiB as Graph requires
SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024


class DriveError(Exception):
    pass


def q(parts: list[str]) -> str:
    return "/".join(quote(p, safe="") for p in parts)


def describe(it: dict) -> dict:
    kind = "folder" if "folder" in it else "file"
    out = {"name": it.get("name"), "type": kind, "modified": (it.get("lastModifiedDateTime") or "")[:19]}
    if kind == "file":
        out["size"] = it.get("size", 0)
    else:
        out["children"] = it["folder"].get("childCount")
    return out


class Drive:
    def __init__(self, graph: Graph):
        self.g = graph

    # -- addressing ---------------------------------------------------------
    def _base(self, root: Root, parts: list[str]) -> str:
        if root.kind == "shared":
            b = f"/drives/{root.drive_id}/items/{quote(root.item_id or '', safe='!')}"
            return b + (f":/{q(parts)}:" if parts else "")
        full = [p for p in (root.folder or "").split("/") if p] + parts
        return f"/me/drive/root:/{q(full)}:"

    @staticmethod
    def ref(it: dict) -> str:
        drv = (it.get("parentReference") or {}).get("driveId")
        if not drv:
            raise DriveError("item has no drive reference")
        return f"/drives/{drv}/items/{quote(it['id'], safe='!')}"

    async def _children(self, ref: str, top: int = 200, limit: int = 2000) -> list[dict]:
        url: str | None = f"{ref}/children?$top={min(top, 200)}&$select={SELECT}"
        out: list[dict] = []
        while url and len(out) < limit:
            d = await self.g.json("GET", url, ok=(200,))
            out += d.get("value", [])
            url = d.get("@odata.nextLink")
        return out

    async def item(self, root: Root, parts: list[str]) -> dict:
        r = await self.g.request("GET", f"{self._base(root, parts)}?$select={SELECT}")
        if r.status_code == 200:
            it = r.json()
            self._reject_shortcut(it)
            return it
        if r.status_code != 404 or not parts:
            raise graph_error(r)
        # exact address missed: names from macOS are NFD, from Windows NFC; walk and compare normalised
        r = await self.g.request("GET", f"{self._base(root, [])}?$select={SELECT}")
        if r.status_code != 200:
            raise graph_error(r)
        cur = r.json()
        for seg in parts:
            if "folder" not in cur:
                raise GraphError(404, "not found")
            hit = None
            for c in await self._children(self.ref(cur)):
                if norm_name(c["name"]) == norm_name(seg):
                    hit = c
                    break
            if hit is None:
                raise GraphError(404, "not found")
            self._reject_shortcut(hit)
            cur = hit
        return cur

    @staticmethod
    def _reject_shortcut(it: dict) -> None:
        if "remoteItem" in it:
            raise DriveError("this entry is a shortcut to another location; shortcuts are not followed")

    # -- reads --------------------------------------------------------------
    async def list(self, root: Root, parts: list[str], limit: int = 200) -> dict:
        it = await self.item(root, parts)
        if "folder" not in it:
            raise DriveError("not a folder")
        kids = await self._children(self.ref(it), limit=limit)
        return {"path": "/".join(parts), "items": [describe(k) for k in kids[:limit]], "truncated": len(kids) > limit}

    async def search(self, root: Root, parts: list[str], query: str, limit: int = 20) -> list[dict]:
        if not query.strip() or len(query) > 200 or any(c in query for c in "'\"\\\n\r"):
            raise DriveError("query: 1-200 characters, no quotes or backslashes")
        it = await self.item(root, parts)
        d = await self.g.json("GET", f"{self.ref(it)}/search(q='{quote(query, safe='')}')?$top={limit}&$select={SELECT}", ok=(200,))
        cache: dict[str, dict] = {}
        out: list[dict] = []
        for hit in d.get("value", [])[:limit]:
            path = await self._path_in_root(root, hit, cache)
            if path is None:
                continue  # not verifiably inside this root: never shown
            out.append({"path": "/".join(path), **describe(hit)})
        return out

    async def _path_in_root(self, root: Root, hit: dict, cache: dict) -> list[str] | None:
        names = [hit["name"]]
        cur = hit
        for _ in range(24):
            par = cur.get("parentReference") or {}
            pid = par.get("id")
            if root.kind == "shared":
                if pid == root.item_id:
                    return list(reversed(names))
            else:
                p = par.get("path") or ""
                pre = "/drive/root:"
                base = pre + "/" + (root.folder or "")
                if p == base or p.startswith(base + "/"):
                    mid = [s for s in p[len(base):].split("/") if s]
                    return mid + [hit["name"]] if cur is hit else None
                return None
            if not pid or pid in cache and cache[pid] is None:
                return None
            if pid not in cache:
                r = await self.g.request("GET", f"/drives/{par.get('driveId')}/items/{quote(pid, safe='!')}?$select=id,name,parentReference")
                cache[pid] = r.json() if r.status_code == 200 else None
            parent = cache[pid]
            if parent is None:
                return None
            names.append(parent["name"])
            cur = parent
        return None

    async def download(self, root: Root, parts: list[str], dest, limit: int) -> dict:
        it = await self.item(root, parts)
        if "folder" in it or "file" not in it:
            raise DriveError("not a file")
        if it.get("size", 0) > limit:
            raise DriveError(f"file is {it.get('size')} bytes; the limit for one file here is {limit}")
        total = 0
        url = f"{self.ref(it)}/content"
        async for chunk in self.g.stream_get(url):
            total += len(chunk)
            if total > limit:
                raise DriveError("file grew past the size limit while downloading")
            dest.write(chunk)
        return it

    async def read_bytes(self, root: Root, parts: list[str], limit: int) -> tuple[dict, bytes]:
        it = await self.item(root, parts)
        if "folder" in it or "file" not in it:
            raise DriveError("not a file")
        if it.get("size", 0) > limit:
            raise DriveError(f"file is {it.get('size')} bytes, more than {limit}; use download")
        buf = bytearray()
        async for chunk in self.g.stream_get(f"{self.ref(it)}/content"):
            buf += chunk
            if len(buf) > limit:
                raise DriveError("file grew past the limit; use download")
        return it, bytes(buf)

    # -- writes (own roots only; the caller has checked rw) -----------------
    async def ensure_folder(self, root: Root, parts: list[str]) -> dict:
        try:
            it = await self.item(root, parts)
            if "folder" not in it:
                raise DriveError("a file is in the way of this folder")
            return it
        except GraphError as e:
            if e.status != 404:
                raise
        parent = await self.ensure_folder(root, parts[:-1]) if parts else None
        if parent is None:  # the root folder itself is missing: create it under the drive root
            names = (root.folder or "").split("/")
            cur_ref = "/me/drive/root"
            it = None
            for i, n in enumerate(names):
                r = await self.g.request("GET", f"/me/drive/root:/{q(names[:i + 1])}?$select={SELECT}")
                if r.status_code == 200:
                    it = r.json()
                else:
                    it = await self.g.json("POST", f"{cur_ref}/children", json={"name": n, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})
                cur_ref = self.ref(it)
            return it
        r = await self.g.request("POST", f"{self.ref(parent)}/children",
                                 json={"name": parts[-1], "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})
        if r.status_code == 409:
            return await self.item(root, parts)
        if r.status_code not in (200, 201):
            raise graph_error(r)
        return r.json()

    async def upload(self, root: Root, parts: list[str], src, size: int, overwrite: bool) -> dict:
        if not parts:
            raise DriveError("give a file path")
        await self.ensure_folder(root, parts[:-1])
        behavior = "replace" if overwrite else "fail"
        base = self._base(root, parts)  # ends with ':'
        if size <= SIMPLE_UPLOAD_MAX:
            with open(src, "rb") as f:
                data = f.read()
            r = await self.g.request("PUT", f"{base}/content?@microsoft.graph.conflictBehavior={behavior}", content=data,
                                     headers={"Content-Type": "application/octet-stream"})
            if r.status_code == 409:
                raise DriveError("a file with this name already exists (overwrite=false)")
            if r.status_code not in (200, 201):
                raise graph_error(r)
            return r.json()
        s = await self.g.request("POST", f"{base}/createUploadSession", json={"item": {"@microsoft.graph.conflictBehavior": behavior}})
        if s.status_code == 409:
            raise DriveError("a file with this name already exists (overwrite=false)")
        if s.status_code != 200:
            raise graph_error(s)
        url = s.json()["uploadUrl"]
        sent = 0
        last: httpx.Response | None = None
        with open(src, "rb") as f:
            while sent < size:
                chunk = f.read(CHUNK)
                end = sent + len(chunk) - 1
                for attempt in range(3):
                    last = await self.g.http.put(url, content=chunk, headers={"Content-Range": f"bytes {sent}-{end}/{size}"})
                    if last.status_code < 500:
                        break
                if last is None or last.status_code not in (200, 201, 202):
                    await self.g.http.delete(url)
                    raise GraphError(502, f"upload failed at byte {sent} ({last.status_code if last else '?'})")
                sent += len(chunk)
        assert last is not None
        return last.json()

    async def move(self, src_root: Root, src: list[str], dst_root: Root, dst: list[str]) -> dict:
        if not src or not dst:
            raise DriveError("give the source and destination paths")
        it = await self.item(src_root, src)
        parent = await self.ensure_folder(dst_root, dst[:-1])
        body = {"name": dst[-1], "parentReference": {"id": parent["id"]}, "@microsoft.graph.conflictBehavior": "fail"}
        r = await self.g.request("PATCH", self.ref(it), json=body)
        if r.status_code == 409:
            raise DriveError("the destination already exists")
        if r.status_code != 200:
            raise graph_error(r)
        return r.json()

    async def mkdir(self, root: Root, parts: list[str]) -> dict:
        return await self.ensure_folder(root, parts)
