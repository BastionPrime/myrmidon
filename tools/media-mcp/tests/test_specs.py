import unittest

from media_mcp import specs


def ok(spec, aliases=("a.mp4",)):
    return specs.build_ffmpeg_argv(spec, set(aliases))


BASE = {"inputs": [{"file": "a.mp4"}], "output": {"name": "o.mp4", "format": "mp4", "video_codec": "libx264"}}


class FfmpegSpec(unittest.TestCase):
    def test_basic(self):
        argv = ok(BASE)
        self.assertEqual(argv[0], "ffmpeg")
        self.assertIn("-protocol_whitelist", argv)
        self.assertEqual(argv[-1], "../out/o.mp4")

    def test_filter_allowlist(self):
        for bad in ("movie=/etc/passwd", "sendcmd=f=x", "drawtext=text=x", "amovie=x"):
            with self.assertRaises(specs.SpecError):
                ok({**BASE, "video_filter": bad})
        ok({**BASE, "video_filter": "scale=1080:-2,fps=30,format=yuv420p"})
        ok({**BASE, "filter_complex": "[0:v]split[a][b];[a]scale=100:100[c];[c][b]overlay[v]", "maps": ["[v]"]})

    def test_subtitles_only_own_files(self):
        ok({**BASE, "video_filter": "subtitles=s.ass:fontsdir=.:force_style='FontName=X'"}, ("a.mp4", "s.ass"))
        for bad in ("subtitles=/etc/passwd", "subtitles=../x.ass", "subtitles=s.ass:fontsdir=/usr", "subtitles=zz.ass"):
            with self.assertRaises(specs.SpecError):
                ok({**BASE, "video_filter": bad}, ("a.mp4", "s.ass"))

    def test_paths_and_urls_rejected(self):
        for bad in ("scale=file:///etc/x", "overlay=http://x/y", "crop=/etc/passwd"):
            with self.assertRaises(specs.SpecError):
                ok({**BASE, "video_filter": bad})
        with self.assertRaises(specs.SpecError):
            ok({"inputs": [{"file": "../../etc/passwd"}], "output": BASE["output"]}, ("../../etc/passwd",))
        with self.assertRaises(specs.SpecError):
            ok({"inputs": [{"file": "http://x/y.mp4"}], "output": BASE["output"]})

    def test_lavfi(self):
        ok({"inputs": [{"lavfi": "color=c=black:s=320x240:d=2"}], "output": BASE["output"]})
        with self.assertRaises(specs.SpecError):
            ok({"inputs": [{"lavfi": "movie=/etc/passwd"}], "output": BASE["output"]})
        with self.assertRaises(specs.SpecError):
            ok({"inputs": [{"lavfi": "color=c=black:s=1x1"}], "output": BASE["output"]})

    def test_output_limits(self):
        for bad in ({"name": "../x.mp4"}, {"name": "a/b.mp4"}, {"format": "exe"}, {"video_codec": "libx264 -x"},
                    {"crf": 99}, {"video_bitrate": "9999999"}):
            with self.assertRaises(specs.SpecError):
                ok({**BASE, "output": {**BASE["output"], **bad}})
        argv = ok({**BASE, "output": {**BASE["output"], "max_duration": 5}})
        self.assertIn("5.0", argv)


class Other(unittest.TestCase):
    def test_image(self):
        argv = specs.build_image_argv({"input": "p.png", "width": 100, "height": 100, "fit": "cover", "format": "jpg"}, {"p.png"})
        self.assertIn("-vf", argv)
        with self.assertRaises(specs.SpecError):
            specs.build_image_argv({"input": "p.png", "width": 99999}, {"p.png"})

    def test_pdf(self):
        argv = specs.build_pdf_images_argv({"input": "d.pdf", "dpi": 100, "last_page": 3}, {"d.pdf"})
        self.assertEqual(argv[0], "pdftoppm")
        with self.assertRaises(specs.SpecError):
            specs.build_pdf_images_argv({"input": "d.pdf", "last_page": 500}, {"d.pdf"})
        with self.assertRaises(specs.SpecError):
            specs.build_pdf_images_argv({"input": "d.pdf", "dpi": 600}, {"d.pdf"})


if __name__ == "__main__":
    unittest.main()
