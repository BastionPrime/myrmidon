import unittest

from media_mcp import specs


def dwg(spec, aliases=("d.dwg",)):
    return specs.build_dwg_argv(spec, set(aliases))


BASE = {"input": "d.dwg", "kind": "dxf"}


class DwgSpec(unittest.TestCase):
    def test_basic_dxf(self):
        argv = dwg(BASE)
        self.assertEqual(argv[0], "dwg_convert")
        self.assertIn("d.dwg", argv)
        self.assertIn("--kind", argv)
        self.assertEqual(argv[argv.index("--output") + 1], "../out/drawing.dxf")
        # default version R2010
        self.assertEqual(argv[argv.index("--dxf-version") + 1], "R2010")

    def test_versions(self):
        for v in ("R12", "R2000", "R2018"):
            argv = dwg({**BASE, "dxf_version": v})
            self.assertEqual(argv[argv.index("--dxf-version") + 1], v)
        for bad in ("R13", "R2024", "AC1015", 2010, None):
            with self.assertRaises(specs.SpecError):
                dwg({**BASE, "dxf_version": bad})

    def test_kinds(self):
        argv = dwg({"input": "d.dxf", "kind": "svg", "output": {"name": "out.svg", "width": 800, "height": 600}}, ("d.dxf",))
        self.assertEqual(argv[argv.index("--output") + 1], "../out/out.svg")
        self.assertEqual(argv[argv.index("--width") + 1], "800")
        self.assertEqual(argv[argv.index("--height") + 1], "600")
        argv = dwg({"input": "d.dxf", "kind": "pdf", "output": {"paper": "420x297"}}, ("d.dxf",))
        self.assertEqual(argv[argv.index("--paper") + 1], "420x297")
        for bad in ("step", "dwg", "", None, 1):
            with self.assertRaises(specs.SpecError):
                dwg({**BASE, "kind": bad})

    def test_bad_names_and_paths(self):
        for bad in ("../x.dxf", "a/b.dxf", "n%03d.dxf", "x.dxf ", ".dxf"):
            with self.assertRaises(specs.SpecError):
                dwg({**BASE, "output": {"name": bad}})
        for bad in ("/etc/passwd", "../x", "http://x/y.dwg", 5, None):
            with self.assertRaises(specs.SpecError):
                dwg({"input": bad, "kind": "dxf"})

    def test_alias_must_be_among_inputs(self):
        with self.assertRaises(specs.SpecError):
            dwg({"input": "other.dwg", "kind": "dxf"}, ("d.dwg",))

    def test_bad_sizes(self):
        for bad in (15, 16385, "800", 800.5, None):
            with self.assertRaises(specs.SpecError):
                dwg({"input": "d.dxf", "kind": "svg", "output": {"name": "o.svg", "width": bad}})
        with self.assertRaises(specs.SpecError):
            dwg({"input": "d.dxf", "kind": "pdf", "output": {"paper": "huge"}})
        with self.assertRaises(specs.SpecError):
            dwg({"input": "d.dxf", "kind": "pdf", "output": {"paper": "../../etc/passwd"}})

    def test_cad_input_detection(self):
        self.assertTrue(specs.is_cad_input("plan.dwg"))
        self.assertTrue(specs.is_cad_input("plan.DXF"))
        self.assertFalse(specs.is_cad_input("plan.pdf"))
        self.assertTrue(specs.is_dwg_input("plan.dwg"))
        self.assertFalse(specs.is_dwg_input("plan.dxf"))


if __name__ == "__main__":
    unittest.main()
