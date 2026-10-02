// myrmidon(UI-0a): viewport-width hook for the ui2 phone layout. The vendor
// SidebarContext owns isMobile for the 1.x shell and is wired into vendor
// state; ui2 needs the same breakpoint (768) without coupling to vendor
// sidebar state, so it observes the media query directly.
import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
