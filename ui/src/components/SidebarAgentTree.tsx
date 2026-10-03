// myrmidon(AGENTS-TREE): collapsible agent hierarchy for the sidebar.
//
// Rows reuse SidebarAgentItem (nav-row chrome, live dot, ⋯ menu, star) — this
// component only adds the tree mechanics: a chevron toggle for parents, the
// collapsed-node badges (subtree agent count + running/error indicator) and
// depth indentation. Collapse state lives in the parent (SidebarAgents), so
// the same component serves the roster page and the UI 2.0 shell with their
// own persistence.
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import type { AgentTreeNode } from "../lib/agent-tree";
import type { Agent } from "@paperclipai/shared";

export interface SidebarAgentTreeRowProps {
  nodes: AgentTreeNode[];
  renderRow: (agent: Agent) => ReactNode;
  collapsed: Set<string>;
  onToggleNode: (agentId: string) => void;
  rail: boolean;
  /** Extra class on each depth wrapper for custom indent steps. */
  indentClassName?: (depth: number) => string;
  /** Labels for the collapsed-node badges (i18n-owned by the caller). */
  labels: {
    expandNode: (name: string) => string;
    collapseNode: (name: string) => string;
    agentsCount: (count: number) => string;
    runningCount: (count: number) => string;
  };
}

export function SidebarAgentTreeRows({
  nodes,
  renderRow,
  collapsed,
  onToggleNode,
  rail,
  indentClassName,
  labels,
}: SidebarAgentTreeRowProps) {
  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsed.has(node.agent.id);
        const hasChildren = node.children.length > 0;
        const indent = indentClassName?.(node.depth) ?? undefined;
        return (
          <div key={node.agent.id} className={cn("relative", indent)}>
            <div className="flex items-center">
              {hasChildren ? (
                <button
                  type="button"
                  data-slot="agent-tree-toggle"
                  data-agent-id={node.agent.id}
                  onClick={() => onToggleNode(node.agent.id)}
                  aria-label={
                    isCollapsed
                      ? labels.expandNode(node.agent.name)
                      : labels.collapseNode(node.agent.name)
                  }
                  aria-expanded={!isCollapsed}
                  className={cn(
                    "z-10 ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    rail && "hidden",
                  )}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      !isCollapsed && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <span className={cn("w-5 shrink-0", rail && "hidden")} aria-hidden="true" />
              )}
              {renderRow(node.agent)}
              {hasChildren && isCollapsed && (
                // Collapsed summary: subtree agent count + running/error dot.
                // Only rendered when not in the rail (the rail hides all
                // trailing chrome anyway).
                <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-1.5 md:flex" data-slot="agent-tree-collapsed-badge">
                  <span className="rounded-full bg-muted px-1.5 text-(length:--text-nano) leading-4 font-medium text-muted-foreground">
                    {node.descendantCount + 1}
                  </span>
                  {node.runningCount > 0 ? (
                    <span className="relative flex h-2 w-2" aria-hidden="true">
                      <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                    </span>
                  ) : node.hasError ? (
                    <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
                  ) : null}
                </span>
              )}
            </div>
            {!isCollapsed && node.children.length > 0 && (
              <div className="my-0.5 ml-6 border-l border-border/70 pl-1.5">
                <SidebarAgentTreeRows
                  nodes={node.children}
                  renderRow={renderRow}
                  collapsed={collapsed}
                  onToggleNode={onToggleNode}
                  rail={rail}
                  indentClassName={indentClassName}
                  labels={labels}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
