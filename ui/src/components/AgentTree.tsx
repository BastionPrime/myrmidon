// myrmidon(AGENTS-TREE): the roster page's hierarchy view.
//
// Renders the agents forest built from `reportsTo` with collapsible nodes,
// per-level indentation, a per-subtree agent count + running/error indicator
// on collapsed parents, and a name search that auto-expands the branch of
// every match. The flat list remains a toggle; this view is the default
// (issue OPE-3915: 81 agents read as a tree, top level ≤ 10 nodes).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Search, Users } from "lucide-react";
import { useTranslation } from "@/i18n";
import type { Agent } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import {
  type AgentForest,
  type AgentTreeNode,
  buildAgentForest,
  expandedIdsForSearch,
  getAgentTreeCollapsedStorageKey,
  readAgentTreeCollapsed,
  writeAgentTreeCollapsed,
} from "../lib/agent-tree";
import { Input } from "@/components/ui/input";
import { AgentStatusCapsule } from "./StatusBadge";
import { AlertTriangle } from "lucide-react";


function TreeNode({
  node,
  collapsed,
  onToggle,
  renderRow,
  labels,
}: {
  node: AgentTreeNode;
  collapsed: Set<string>;
  onToggle: (agentId: string) => void;
  renderRow: (agent: Agent, node: AgentTreeNode) => ReactNode;
  labels: TreeLabels;
}) {
  const isCollapsed = collapsed.has(node.agent.id);
  const hasChildren = node.children.length > 0;
  return (
    <div data-slot="agent-tree-node" data-depth={node.depth} style={{ paddingLeft: node.depth * 24 }}>
      <div className="relative flex items-center">
        {hasChildren ? (
          <button
            type="button"
            data-slot="agent-tree-toggle"
            data-agent-id={node.agent.id}
            onClick={() => onToggle(node.agent.id)}
            aria-label={
              isCollapsed
                ? labels.expandNode(node.agent.name)
                : labels.collapseNode(node.agent.name)
            }
            aria-expanded={!isCollapsed}
            className="absolute left-1 z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronRight
              className={cn("h-4 w-4 transition-transform", !isCollapsed && "rotate-90")}
              aria-hidden="true"
            />
          </button>
        ) : null}
        {renderRow(node.agent, node)}
        {hasChildren && isCollapsed && (
          <span
            data-slot="agent-tree-collapsed-badge"
            className="pointer-events-none absolute right-6 top-1/2 hidden -translate-y-1/2 items-center gap-2 sm:flex"
          >
            <span className="rounded-full bg-muted px-2 text-xs font-medium leading-5 text-muted-foreground">
              {node.descendantCount + 1}
            </span>
            {node.runningCount > 0 ? (
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
            ) : node.hasError ? (
              <AlertTriangle className="h-3 w-3 text-amber-500" aria-label={labels.errorIndicator} />
            ) : null}
          </span>
        )}
      </div>
      {!isCollapsed && hasChildren && (
        <div className="my-0.5 ml-6 border-l border-border/70 pl-2">
          {node.children.map((child) => (
            <TreeNode
              key={child.agent.id}
              node={child}
              collapsed={collapsed}
              onToggle={onToggle}
              renderRow={renderRow}
              labels={labels}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface TreeLabels {
  expandNode: (name: string) => string;
  collapseNode: (name: string) => string;
  noManager: string;
  searchPlaceholder: string;
  searchAria: string;
  errorIndicator: string;
}

export function AgentTree({
  agents,
  companyId,
  userId,
  renderRow,
}: {
  agents: Agent[];
  companyId: string | null;
  userId: string | null;
  renderRow: (agent: Agent, node: AgentTreeNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const forest: AgentForest = useMemo(() => buildAgentForest(agents), [agents]);

  // myrmidon(AGENTS-TREE): i18n labels (agentsTree namespace, all 40 vendor
  // locales; ru carries the Russian copy).
  const labels: TreeLabels = useMemo(
    () => ({
      expandNode: (name) => t("agentsTree.expandNode", { name }),
      collapseNode: (name) => t("agentsTree.collapseNode", { name }),
      noManager: t("agentsTree.noManager"),
      searchPlaceholder: t("agentsTree.searchPlaceholder"),
      searchAria: t("agentsTree.searchAria"),
      errorIndicator: t("agentsTree.errorIndicator"),
    }),
    [t],
  );

  const storageKey = useMemo(
    () => (companyId ? getAgentTreeCollapsedStorageKey(companyId, userId) : null),
    [companyId, userId],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    storageKey ? readAgentTreeCollapsed(storageKey) : new Set(),
  );
  useEffect(() => {
    setCollapsed(storageKey ? readAgentTreeCollapsed(storageKey) : new Set());
  }, [storageKey]);

  const [query, setQuery] = useState("");
  const searchExpanded = useMemo(() => expandedIdsForSearch(forest, query), [forest, query]);

  // Effective collapsed set: searching temporarily expands every branch that
  // contains a match (the user's stored collapse state is untouched).
  const effectiveCollapsed = useMemo(() => {
    if (searchExpanded.size === 0) return collapsed;
    const next = new Set(collapsed);
    for (const id of searchExpanded) next.delete(id);
    return next;
  }, [collapsed, searchExpanded]);

  const toggleNode = useCallback(
    (agentId: string) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(agentId)) next.delete(agentId);
        else next.add(agentId);
        if (storageKey) writeAgentTreeCollapsed(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  return (
    <div data-slot="agent-tree-root" className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.searchPlaceholder}
            aria-label={labels.searchAria}
            data-testid="agent-tree-search"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>
      <div data-testid="agent-tree-body">
        {forest.roots.map((node) => (
          <TreeNode
            key={node.agent.id}
            node={node}
            collapsed={effectiveCollapsed}
            onToggle={toggleNode}
            renderRow={renderRow}
            labels={labels}
          />
        ))}
        {forest.orphans.length > 0 && (
          <div data-testid="agent-tree-orphans" className="mt-3">
            <p className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
              <Users className="h-3 w-3" aria-hidden="true" />
              {labels.noManager}
            </p>
            {forest.orphans.map((node) => (
              <TreeNode
                key={node.agent.id}
                node={node}
                collapsed={effectiveCollapsed}
                onToggle={toggleNode}
                renderRow={renderRow}
                labels={labels}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
