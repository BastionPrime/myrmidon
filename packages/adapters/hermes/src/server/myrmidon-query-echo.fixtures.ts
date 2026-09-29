/**
 * myrmidon(G5): a stand-in for what the vendor CLI's `Query: <prompt>` echo
 * looks like on a non-tty stdout, shared by the echo-cutting tests. Not a test
 * file (no `.test.` in the name), so vitest does not collect it.
 */

/**
 * What `console.print("[bold blue]Query:[/] " + label)` writes to a non-tty
 * stdout: `Query: ` and the label, word-wrapped at `width` columns. Rich only
 * changes whitespace when it wraps (a space at a wrap point becomes the line
 * break), and strips control codes 7, 8, 11, 12 and 13. `emoji` maps a
 * shortcode to what Rich prints for it.
 */
export function richEcho(label: string, opts: { width?: number; emoji?: Record<string, string> } = {}): string {
  const width = opts.width ?? 80;
  let text = label.replace(/[\x07\x08\x0b\x0c\r]/g, "");
  for (const [code, glyph] of Object.entries(opts.emoji ?? {})) text = text.split(code).join(glyph);
  const out: string[] = [];
  for (const line of `Query: ${text}`.split("\n")) {
    let current = "";
    for (const word of line.split(/(?<=\s)/)) {
      if (current.length > 0 && (current + word).trimEnd().length > width) {
        out.push(current.trimEnd());
        current = word;
      } else {
        current += word;
      }
    }
    out.push(current.trimEnd());
  }
  return out.join("\n") + "\n";
}
