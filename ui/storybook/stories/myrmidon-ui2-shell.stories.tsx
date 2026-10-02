// myrmidon(UI-0a): UI-2.0 shell stories — visual snapshots at 1440 (desktop
// frame) and 390 (phone frame) per OPE-3550 acceptance. Stories render the
// real shell components with the standard Storybook providers (theme,
// company, router) from .storybook/preview.tsx; the status strip reads the
// shared fixtures via the api mock layer.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { Ui2Shell } from "@/ui2/shell/Ui2Shell";
import { Ui2Rail } from "@/ui2/shell/Ui2Rail";
import { Ui2TopBar } from "@/ui2/shell/Ui2TopBar";
import { Ui2PhoneHeader, Ui2PhoneTabBar } from "@/ui2/shell/Ui2PhoneNav";
import { Ui2CommanderPalette } from "@/ui2/shell/Ui2CommanderPalette";
import { Ui2SettingsSidebar } from "@/ui2/shell/Ui2SettingsSidebar";
import { Ui2PlaceholderScreen } from "@/ui2/screens/Ui2PlaceholderScreen";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
});

function ShellPage() {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "var(--myr-space-3)" }}>
      <h1
        className="myr-display"
        style={{ fontSize: "var(--myr-text-hero)", fontWeight: 700, margin: 0, color: "var(--myr-ink)" }}
      >
        {t("ui2.nav.center")}
      </h1>
      <p style={{ color: "var(--myr-ink-muted)", fontSize: "var(--myr-text-body)", maxWidth: 560 }}>
        {t("ui2.commander.stubNote")}
      </p>
      <div
        style={{
          marginTop: "var(--myr-space-2)",
          background: "var(--myr-surface-raised)",
          border: "1px solid var(--myr-hairline)",
          borderRadius: "var(--myr-radius-md)",
          padding: "var(--myr-space-2)",
          display: "grid",
          gap: "var(--myr-space-1)",
        }}
      >
        <span className="myr-mono" style={{ color: "var(--myr-ink)" }}>
          OPE-3550 · run 41cefa42 · $1,574.12
        </span>
        <span style={{ color: "var(--myr-signal-live)" }}>signal-live #1c7a3d</span>
        <span style={{ color: "var(--myr-signal-warn)" }}>signal-warn #8a5300</span>
        <span style={{ color: "var(--myr-signal-halt)" }}>signal-halt #b3261e</span>
      </div>
    </div>
  );
}

const meta: Meta<typeof Ui2Shell> = {
  title: "Myrmidon UI2/Shell",
  component: Ui2Shell,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Ui2Shell>;

export const Desktop1440: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => (
    <Ui2Shell>
      <ShellPage />
    </Ui2Shell>
  ),
};

export const Phone390: Story = {
  parameters: { viewport: { defaultViewport: "mobile" } },
  render: () => (
    <Ui2Shell>
      <ShellPage />
    </Ui2Shell>
  ),
};

export const RailDark: Story = {
  parameters: {
    viewport: { defaultViewport: "desktop" },
    backgrounds: { default: "dark" },
    docs: { description: { story: "Rail alone, cropped — token check in isolation." } },
  },
  render: () => (
    <div style={{ height: 640, display: "flex" }}>
      <Ui2Rail />
    </div>
  ),
};

export const TopBarWithChips: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Ui2TopBar />
    </div>
  ),
};

export const CommanderPalette: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => (
    <div style={{ height: 480, background: "var(--myr-surface)", position: "relative" }}>
      <Ui2CommanderPalette onClose={() => undefined} />
    </div>
  ),
};

export const PhoneBars: Story = {
  parameters: { viewport: { defaultViewport: "mobile" } },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, background: "var(--myr-surface)" }}>
      <Ui2PhoneHeader />
      <Ui2PhoneTabBar />
    </div>
  ),
};

export const SettingsSidebar: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => (
    <div style={{ display: "flex", height: 640, background: "var(--myr-surface)" }}>
      <Ui2SettingsSidebar />
    </div>
  ),
};

export const PlaceholderScreen: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => (
    <div style={{ padding: "var(--myr-space-3)", background: "var(--myr-surface)", minHeight: 480 }}>
      <Ui2PlaceholderScreen />
    </div>
  ),
};
