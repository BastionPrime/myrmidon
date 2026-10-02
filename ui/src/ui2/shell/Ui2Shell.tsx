// myrmidon(UI-0a): the UI-2.0 shell layout — rail + top bar on desktop,
// phone header + bottom bar below md, page outlet in between. Mounted by
// App.tsx under the enableMyrmidonUi2 flag INSTEAD of the vendor Layout; the
// nested routes render through <Outlet/>, so every existing page keeps
// working (the shell runs in parallel with 1.5, OPE-3550). `children` is
// accepted for direct composition (Storybook stories); when both are absent
// the outlet renders the routes. Settings routes get the internal 10-section
// side panel (screen-map §3.1); the `lang` prop keys the RU display-font
// switch (UI-0b contract).
import type { ReactNode } from "react";
import { Outlet, useLocation } from "@/lib/router";
import { useIsMobileViewport } from "../useIsMobileViewport";
import { Ui2Rail } from "./Ui2Rail";
import { Ui2TopBar } from "./Ui2TopBar";
import { Ui2SettingsSidebar } from "./Ui2SettingsSidebar";
import { Ui2PhoneHeader, Ui2PhoneTabBar } from "./Ui2PhoneNav";

function isSettingsPath(pathname: string): boolean {
  const segment = pathname.split("/").filter(Boolean).slice(1)[0]?.toLowerCase();
  return segment === "company";
}

export function Ui2Shell({ children, lang }: { children?: ReactNode; lang?: string }) {
  const isMobile = useIsMobileViewport();
  const location = useLocation();
  const content = children ?? <Outlet />;
  const rootProps = lang ? { lang } : {};

  if (isMobile) {
    return (
      <div
        className="myr-ui2"
        style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}
        {...rootProps}
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
    <div
      className="myr-ui2"
      style={{ display: "flex", minHeight: "100dvh" }}
      {...rootProps}
    >
      <Ui2Rail />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Ui2TopBar />
        <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
          {isSettingsPath(location.pathname) ? <Ui2SettingsSidebar /> : null}
          <main style={{ flex: 1, minWidth: 0, padding: "var(--myr-space-2)" }}>{content}</main>
        </div>
      </div>
    </div>
  );
}
