// myrmidon(UI-0a): "Tell the Commander" palette — the stub promised by
// OPE-3550: an input that acknowledges the request and routes the operator
// to the existing chat surface. Full CTO-CHAT (epic parsing, per-Commander
// history, active channel routing) is 1.6 (screen-map §4.3); this entry only
// guarantees the affordance exists under the flag and never looks wired to
// something that does not exist yet: the send action is explicit about being
// a stub in the UI copy (ui2.commander.stubNote).
import { useEffect, useRef } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useNavigate } from "@/lib/router";

export function Ui2CommanderPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("ui2.commander.aria", { defaultValue: "Tell the Commander (Ctrl K)" })}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        background: "color-mix(in srgb, var(--myr-ink) 40%, transparent)",
        zIndex: 50,
      }}
      onMouseDown={onClose}
    >
      <form
        className="myr-ui2__commander-palette"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          navigate("/board-chat");
          onClose();
        }}
        style={{
          width: "min(560px, calc(100vw - 2 * var(--myr-space-3)))",
          background: "var(--myr-surface-raised)",
          border: "1px solid var(--myr-hairline)",
          borderRadius: "var(--myr-radius-md)",
          boxShadow: "0 24px 90px color-mix(in srgb, var(--myr-ink) 18%, transparent)",
          padding: "var(--myr-space-2)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--myr-space-1)",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          placeholder={t("ui2.commander.placeholder", { defaultValue: "Tell the Commander…" })}
          style={{
            height: 40,
            borderRadius: "var(--myr-radius-sm)",
            border: "1px solid var(--myr-hairline)",
            background: "var(--myr-surface)",
            color: "var(--myr-ink)",
            padding: "0 var(--myr-space-1)",
            fontSize: "var(--myr-text-body)",
            fontFamily: "var(--myr-font-ui)",
            outline: "none",
          }}
        />
        <p style={{ fontSize: "var(--myr-text-nano)", color: "var(--myr-ink-muted)", margin: 0 }}>
          {t("ui2.commander.stubNote", {
            defaultValue:
              "Stub: the message is not sent yet. It opens the existing chat; the Commander conversation arrives with the 1.6 chat update.",
          })}
        </p>
        <button
          type="submit"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            alignSelf: "flex-end",
            height: 32,
            borderRadius: "var(--myr-radius-sm)",
            border: "1px solid var(--myr-navy-deep)",
            background: "var(--myr-navy-deep)",
            color: "var(--myr-on-navy)",
            padding: "0 var(--myr-space-1)",
            fontSize: "var(--myr-text-body)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("ui2.commander.openChat", { defaultValue: "Open chat" })}
          <ArrowRight aria-hidden="true" style={{ width: 14, height: 14 }} />
        </button>
      </form>
    </div>
  );
}
