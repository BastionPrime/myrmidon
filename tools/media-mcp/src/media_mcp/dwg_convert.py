#!/opt/cad/bin/python
"""CAD conversion job: DWG/DXF -> DXF / SVG / PDF.

Runs inside the media worker as a plain job command (the same rlimits, timeouts
and output accounting as ffmpeg/poppler jobs). Input is a single file alias in
the job's `in` directory, output goes to `../out`.

DWG input is converted with LibreDWG's dwg2dxf (the drawing content becomes
DXF); DXF input is read directly. DXF output is written by LibreDWG (dwg input)
or ezdxf (dxf input, version bump). SVG and PDF output are rendered by ezdxf's
drawing add-on: SVGBackend directly, PDF via LibreOffice (headless soffice)
because a PDF backend would need AGPL-licensed PyMuPDF or matplotlib.

Usage (from the worker, cwd = <job>/in):
    dwg_convert <input> --kind dxf|svg|pdf --output <path>
                [--dxf-version R2010] [--width N] [--height N] [--paper WxH]
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

DXF_VERSIONS = ("R12", "R2000", "R2004", "R2007", "R2010", "R2013", "R2018")


def die(msg: str) -> None:
    sys.stderr.write("dwg_convert: " + msg + "\n")
    raise SystemExit(1)


def dwg_to_dxf(src: str, out_path: str, version: str) -> None:
    """DWG -> DXF with LibreDWG's dwg2dxf (same tool the bots used on the host)."""
    argv = ["dwg2dxf", "-y", "-o", out_path]
    if version == "R12":
        argv.append("-m")  # minimal DXF for the R12 family
    argv.append(src)
    r = subprocess.run(argv, cwd=os.getcwd(), capture_output=True, text=True, timeout=240)
    if r.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        tail = (r.stderr or r.stdout or "")[-600:]
        die(f"dwg2dxf failed ({tail or 'no output written'})")


def load_dxf(path: str):
    import ezdxf
    from ezdxf import recover

    try:
        # LibreDWG output loads clean but trips ezdxf's strict reader on save
        # (materials table); recover.readfile is the documented loader for
        # foreign files and round-trips them fine.
        return recover.readfile(path)[0]
    except Exception as e:  # ezdxf raises a family of exceptions
        die(f"cannot read {os.path.basename(path)}: {e}")


def render_svg(doc, out_path: str, width: int, height: int) -> None:
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.svg import SVGBackend

    backend = SVGBackend()
    Frontend(RenderContext(doc), backend).draw_layout(doc.modelspace(), finalize=True)
    page = layout.Page(width, height)
    svg = backend.get_string(page)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(svg)


def render_pdf(doc, src: str, out_path: str, paper: str) -> None:
    """DXF -> PDF: ezdxf has no dependency-free PDF backend (PyMuPDF is AGPL,
    matplotlib is heavy), so render SVG and print it with LibreOffice when the
    image provides it; otherwise fail with a clear message."""
    tmp_svg = out_path + ".tmp.svg"
    render_svg(doc, tmp_svg, 1600, 1200)
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice is None:
        os.unlink(tmp_svg)
        die("PDF output is not available in this worker image (no LibreOffice); ask for svg")
    argv = [soffice, "--headless", "--convert-to", "pdf", "--outdir", os.path.dirname(out_path) or ".", tmp_svg]
    r = subprocess.run(argv, cwd=os.getcwd(), capture_output=True, text=True, timeout=240)
    pdf = os.path.splitext(tmp_svg)[0] + ".pdf"
    if r.returncode != 0 or not os.path.exists(pdf):
        os.unlink(tmp_svg)
        die(f"LibreOffice failed ({(r.stderr or '')[-600:]})")
    shutil.move(pdf, out_path)
    os.unlink(tmp_svg)


def main() -> None:
    ap = argparse.ArgumentParser(prog="dwg_convert")
    ap.add_argument("input")
    ap.add_argument("--kind", required=True, choices=("dxf", "svg", "pdf"))
    ap.add_argument("--output", required=True)
    ap.add_argument("--dxf-version", default="R2010", choices=DXF_VERSIONS)
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=1200)
    ap.add_argument("--paper", default=None)
    a = ap.parse_args()

    src = os.path.basename(a.input)
    if not os.path.isfile(src):
        die(f"input {src!r} not found in the job directory")
    out_dir = os.path.dirname(os.path.abspath(a.output))
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.abspath(a.output)

    lower = src.lower()
    if lower.endswith(".dwg"):
        if a.kind == "dxf":
            dwg_to_dxf(src, out, a.dxf_version)
            return
        # svg / pdf from DWG: go through DXF first
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as td:
            mid = os.path.join(td, "mid.dxf")
            dwg_to_dxf(src, mid, "R2000")
            doc = load_dxf(mid)
            if a.kind == "svg":
                render_svg(doc, out, a.width, a.height)
            else:
                render_pdf(doc, mid, out, a.paper)
            return
    if lower.endswith(".dxf"):
        doc = load_dxf(src)
        if a.kind == "dxf":
            target = {"R12": "AC1009", "R2000": "AC1015", "R2004": "AC1018", "R2007": "AC1021",
                      "R2010": "AC1024", "R2013": "AC1027", "R2018": "AC1032"}[a.dxf_version]
            if target != doc.dxfversion:  # ezdxf writes the doc's own version; bump explicitly
                doc.dxfversion = target
            doc.saveas(out)
        elif a.kind == "svg":
            render_svg(doc, out, a.width, a.height)
        else:
            render_pdf(doc, src, out, a.paper)
        return
    die("input must be a .dwg or .dxf file")


if __name__ == "__main__":
    main()
