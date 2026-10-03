import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "src" / "media_mcp" / "dwg_convert.py"


def have_bins():
    for b in ("dwg2dxf",):
        if subprocess.run(["sh", "-c", f"command -v {b}"], capture_output=True).returncode != 0:
            return False
    try:
        import ezdxf  # noqa: F401
        from ezdxf.addons.drawing.svg import SVGBackend  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless(have_bins(), "dwg2dxf and ezdxf are needed (installed in the worker image)")
class DwgConvertScript(unittest.TestCase):
    """End-to-end run of the job script itself: real subprocess, real files."""

    def job(self, tmp: Path) -> Path:
        d = tmp / "in"
        d.mkdir(parents=True, exist_ok=True)
        (tmp / "out").mkdir(exist_ok=True)
        return d

    def run_script(self, cwd: Path, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd, capture_output=True, text=True, timeout=240)

    def test_dxf_roundtrip_and_svg(self):
        import ezdxf

        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            d = self.job(tmp)
            doc = ezdxf.new("R2000")
            doc.modelspace().add_lwpolyline([(0, 0), (100, 0), (100, 50), (0, 50)], close=True)
            doc.saveas(d / "in.dxf")

            r = self.run_script(d, "in.dxf", "--kind", "dxf", "--dxf-version", "R2018",
                                "--output", str(tmp / "out" / "r2018.dxf"))
            self.assertEqual(r.returncode, 0, r.stderr[-400:])
            out = ezdxf.readfile(tmp / "out" / "r2018.dxf")
            self.assertEqual(out.dxfversion, "AC1032")

            r = self.run_script(d, "in.dxf", "--kind", "svg", "--output", str(tmp / "out" / "out.svg"))
            self.assertEqual(r.returncode, 0, r.stderr[-400:])
            svg = (tmp / "out" / "out.svg").read_text()
            self.assertIn("<svg", svg)

            r = self.run_script(d, "in.dxf", "--kind", "pdf", "--output", str(tmp / "out" / "out.pdf"))
            # no LibreOffice in the unit environment: the script must fail loudly
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("PDF", r.stderr)

    def test_rejects_non_cad(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            d = self.job(tmp)
            (d / "x.txt").write_text("nope")
            r = self.run_script(d, "x.txt", "--kind", "dxf", "--output", str(tmp / "out" / "x.dxf"))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn(".dwg or .dxf", r.stderr)


if __name__ == "__main__":
    unittest.main()
