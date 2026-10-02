// myrmidon(UI-0a, 1.6-CTO-CHAT-A): "Tell the Commander" palette — the entry
// point promised by OPE-3550 and now wired to the real Commander chat screen
// (1.6): submitting navigates to the Commander chat route with the typed text
// carried over, so the planning conversation continues in one place. The
// conversation itself (epic parsing via /api/myrmidon/cto-chat/plan, approval
// card, per-Commander history, active channel routing) lives in
// screens/CommanderChatScreen.tsx (screen-map §4.3).
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
          // myrmidon(1.6-CTO-CHAT-A): continue in the Commander chat, keeping
          // the typed draft so the operator does not retype it.
          const draft = inputRef.current?.value ?? "";
          navigate(
            draft ? `/commander-chat?draft=${encodeURIComponent(draft)}` : "/commander-chat",
          );
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
          {/* myrmidon(1.6-CTO-CHAT-A): no longer a stub — the draft carries
              over to the Commander chat screen, where the plan is built. */}
          {t("ui2.commander.carryNote", {
            defaultValue:
              "The draft opens in the Commander chat, where the board proposes an epic from your text.",
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
