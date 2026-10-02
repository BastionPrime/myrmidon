// myrmidon(S6): the operator's per-agent tool and connection permission on the
// agent card. "All" is the explicit default (the behaviour before this existed);
// "Listed" is an allow-list of tool names and connection ids, one per line.
import { useEffect, useState } from "react";
import { readAgentToolPermissions } from "@paperclipai/shared";
import type { AgentPermissionUpdate } from "@/api/agents";
import { Button } from "@/components/ui/button";

function toLines(values: string[]): string {
  return values.join("\n");
}

function fromLines(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean))];
}

export function AgentToolAccessSection({
  permissions,
  base,
  pending,
  onSave,
}: {
  permissions: unknown;
  /** The three flags the permissions endpoint requires, echoed unchanged. */
  base: Pick<AgentPermissionUpdate, "canCreateAgents" | "canCreateSkills" | "canAssignTasks">;
  pending: boolean;
  onSave: (update: AgentPermissionUpdate) => void;
}) {
  const stored = readAgentToolPermissions(permissions);
  const [mode, setMode] = useState(stored.mode);
  const [tools, setTools] = useState(toLines(stored.tools));
  const [connections, setConnections] = useState(toLines(stored.connections));

  useEffect(() => {
    setMode(stored.mode);
    setTools(toLines(stored.tools));
    setConnections(toLines(stored.connections));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(stored)]);

  const listed = mode === "listed";
  return (
    <div className="space-y-3 text-sm" data-testid="agent-tool-access">
      <div className="space-y-1">
        <div>Tool and connection access</div>
        <p className="text-xs text-muted-foreground">
          All: the agent reaches every tool it could before (default). Listed: only the tools and
          connections named below; any other call is refused and recorded in the activity log.
        </p>
      </div>
      <div className="flex gap-2">
        {(["all", "listed"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={mode === value ? "default" : "outline"}
            disabled={pending}
            onClick={() => setMode(value)}
          >
            {value === "all" ? "All" : "Listed"}
          </Button>
        ))}
      </div>
      {listed ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span>Allowed tools (one per line)</span>
            <textarea
              className="w-full min-h-24 rounded-md border border-border bg-transparent p-2 font-mono text-xs"
              value={tools}
              onChange={(event) => setTools(event.target.value)}
              disabled={pending}
            />
          </label>
          <label className="space-y-1 text-xs">
            <span>Allowed connections (one per line)</span>
            <textarea
              className="w-full min-h-24 rounded-md border border-border bg-transparent p-2 font-mono text-xs"
              value={connections}
              onChange={(event) => setConnections(event.target.value)}
              disabled={pending}
            />
          </label>
        </div>
      ) : null}
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          onSave({
            ...base,
            toolAccess:
              mode === "listed"
                ? { mode, tools: fromLines(tools), connections: fromLines(connections) }
                : { mode: "all" },
          })
        }
      >
        Save tool access
      </Button>
    </div>
  );
}
