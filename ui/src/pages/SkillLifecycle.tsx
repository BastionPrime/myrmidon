// myrmidon(1.6-SKILL-LIFE): the company skill lifecycle page.
//
// A board page under the company scope: state, verified revision, who approved
// and the history of every company skill. The panel holds the data; the page is
// the route target.

import { SkillLifecyclePanel } from "@/components/myrmidon/skill-lifecycle/SkillLifecyclePanel";

export function SkillLifecycle() {
  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Skill lifecycle</h1>
        <p className="text-sm text-muted-foreground">
          candidate → verified → deprecated, with rollback to the previous verified revision.
        </p>
      </div>
      <SkillLifecyclePanel />
    </div>
  );
}