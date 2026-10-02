// myrmidon(UI-0a): the UI-2.0 shell layout — rail + top bar on desktop,
// phone header + bottom bar below md, page outlet in between. Mounted by
// App.tsx under the enableMyrmidonUi2 flag INSTEAD of the vendor Layout; the
// nested routes render through <Outlet/>, so every existing page keeps
// working (the shell runs in parallel with 1.5, OPE-3550). `children` is
// accepted for direct composition (Storybook stories); when both are absent
// the outlet renders the routes.
import type { ReactNode } from "react";
import { Outlet } from "@/lib/router";
import { useIsMobileViewport } from "../useIsMobileViewport";
import { Ui2Rail } from "./Ui2Rail";
import { Ui2TopBar } from "./Ui2TopBar";
import { Ui2PhoneHeader, Ui2PhoneTabBar } from "./Ui2PhoneNav";

export function Ui2Shell({ children }: { children?: ReactNode }) {
  const isMobile = useIsMobileViewport();
  const content = children ?? <Outlet />;

  if (isMobile) {
    return (
      <div
        className="myr-ui2"
        style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}
      >
        <Ui2PhoneHeader />
        <main style={{ flex: 1, minWidth: 0, paddingBottom: "var(--myr-phone-tabbar-height)" }}>
          {content}
        </main>
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0 }}>
          <Ui2PhoneTabBar />
        </div>
      </div>
    );
  }

  return (
    <div className="myr-ui2" style={{ display: "flex", minHeight: "100dvh" }}>
      <Ui2Rail />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Ui2TopBar />
        <main style={{ flex: 1, minWidth: 0, padding: "var(--myr-space-2)" }}>{content}</main>
      </div>
    </div>
  );
}
