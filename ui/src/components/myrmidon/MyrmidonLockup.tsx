// myrmidon(B1a): brand lockup (ant mark + wordmark), replacing PaperclipLockup
// on the sign-in screen. Source SVGs are the owner-approved brand-v2 export,
// copied as-is into ui/public/brand/myrmidon/ — see that directory's README.
// Two fixed-color exports (navy on light, white on dark) are swapped with the
// `dark:` variant rather than inlined with `currentColor`, since the source
// files ship as separate light/dark artwork, not a single currentColor trace.
import type { ImgHTMLAttributes } from "react";

interface MyrmidonLockupProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "children"> {
  decorative?: boolean;
}

export function MyrmidonLockup({ decorative = false, className, ...rest }: MyrmidonLockupProps) {
  return (
    <>
      <img
        {...rest}
        src="/brand/myrmidon/myrmidon-lockup.svg"
        alt={decorative ? "" : "Myrmidon"}
        aria-hidden={decorative ? true : undefined}
        className={`${className ?? ""} dark:hidden`}
      />
      <img
        {...rest}
        src="/brand/myrmidon/myrmidon-lockup-white.svg"
        alt={decorative ? "" : "Myrmidon"}
        aria-hidden={decorative ? true : undefined}
        className={`${className ?? ""} hidden dark:block`}
      />
    </>
  );
}
