// myrmidon(UI2-I18N): English catalog for the 2.0 UI tree (ui/src/ui2).
//
// English is the base language: every key the new UI renders user-visible
// strings from must exist here, and the RU catalog must carry the exact same
// key set (guarded by catalog-parity.myrmidon.test.ts). Values are plain
// i18next strings; interpolation placeholders use {{name}}.
//
// The catalog is a fork-owned tree: vendor locale files are never touched.
// Base scope carried over from the 1.2 localization branch (core screens),
// plus the 2.0 shell/navigation and the Settings → Language screen.
export const en = {
  nav: {
    newTask: "New Task",
    search: "Search",
    dashboard: "Dashboard",
    inbox: "Inbox",
    decisions: "Decisions",
    status: "Status",
    conferenceRoom: "Conference Room",
    work: "Work",
    tasks: "Tasks",
    projects: "Projects",
    routines: "Routines",
    artifacts: "Artifacts",
    cases: "Cases",
    pipelines: "Pipelines",
    goals: "Goals",
    workspaces: "Workspaces",
    org: "Org",
    agents: "Agents",
    skills: "Skills",
    connectors: "Connectors",
    audit: "Audit",
    organization: "Organization",
    timeline: "Timeline",
    costs: "Costs",
    activity: "Activity",
    settings: "Settings",
    home: "Home",
    unread: "unread",
    decisionsBadge: "decisions",
    // 2.0 shell navigation (rail groups and rail entries).
    shell: {
      observe: "Observe",
      commandCenter: "Command Center",
      fleet: "Fleet",
      swarm: "Swarm",
      quality: "Quality",
      decisionsAndComms: "Decisions & Communication",
      waitingForMe: "Waiting for me",
      commander: "Commander",
      more: "More",
    },
  },
  common: {
    cancel: "Cancel",
    save: "Save",
    close: "Close",
    retry: "Retry",
    retrying: "Retrying…",
    remove: "Remove",
    removing: "Removing…",
    update: "Update",
    loading: "Loading…",
    moreActions: "More actions",
    none: "None",
    me: "Me",
    board: "Board",
    apply: "Apply",
    undo: "Undo",
    on: "On",
    off: "Off",
    notSaved: "Not saved: {{count}}",
  },
  language: {
    label: "Language",
    english: "English",
    russian: "Русский",
    switchTo: "Switch interface language",
    // Settings → Language screen (screen-map 2.16).
    settingsTitle: "Language and formats",
    settingsDescription:
      "Interface language for the board. Agent-written text and identifiers are never translated; missing Russian keys fall back to English.",
    currentLanguage: "Current language",
    previewTitle: "Preview",
    previewNav: "Navigation",
    previewDecisionCard: "Decision card",
    previewNavItemDecisions: "Waiting for me",
    previewNavItemSwarm: "Swarm",
    previewNavItemCosts: "Costs",
    previewDecisionCardTitle: "Extend the budget by $1",
    previewDecisionCardBody:
      "The soft limit paused {{count}} task(s). Extending the budget resumes them automatically.",
    savedToast: "Language saved",
    saveFailed: "Could not save the language choice. It stays for this browser only.",
    serverHint: "The choice is saved to your user profile and follows you across devices.",
  },
  status: {
    open: "Open",
    inProgress: "In progress",
    inReview: "In review",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled",
    todo: "To do",
    queued: "Queued",
    running: "Running",
    error: "Error",
    paused: "Paused",
    terminated: "Terminated",
    idle: "Idle",
    failed: "Failed",
    timedOut: "Timed out",
    scheduledRetry: "Scheduled retry",
  },
  agentRoles: {
    ceo: "CEO",
    cfo: "CFO",
    cmo: "CMO",
    cto: "CTO",
    designer: "Designer",
    devops: "DevOps",
    engineer: "Engineer",
    general: "General",
    pm: "Project manager",
    qa: "QA",
    researcher: "Researcher",
    security: "Security",
  },
  tasks: {
    newTask: "New Task",
    searchTasks: "Search tasks",
    assignee: "Assignee",
    priority: "Priority",
    status: "Status",
    filter: "Filter",
    all: "All",
    active: "Active",
    board: "Board",
    list: "List",
    noTasks: "No tasks",
    createdTask: "Task created",
    createdBy: "Created by {{author}}",
    updatedAt: "Updated {{time}}",
    commentsCount: "{{count}} comment(s)",
    runsCount: "{{count}} run(s)",
    blocks: "Blocks",
    blockedBy: "Blocked by",
    relatedTo: "Related to",
  },
  time: {
    justNow: "just now",
    minutesAgo: "{{count}}m ago",
    hoursAgo: "{{count}}h ago",
    daysAgo: "{{count}}d ago",
    weeksAgo: "{{count}}w ago",
    monthsAgo: "{{count}}mo ago",
    updated: "Updated {{time}}",
  },
  ui2: {
      agent: {
        overview: {
          budget: {
            none: "No budget",
            title: "Budget",
            utilization: "{{spent}} of {{budget}} used",
          },
          lastRun: "Last run",
          missing: "Agent not found",
          noRuns: "No runs yet",
          runCost: "Cost",
          runResult: "Result",
          runTokens: "Tokens",
          runs: {
            empty: "No runs in this period",
            title: "Runs",
          },
          spend: {
            month: "Spend this month",
          },
          status: "Status",
          title: "Agent overview",
        },
      },
      common: {
        emptyDoneSr: "No completed items",
        emptyFilteredSr: "No items match the filters",
        error: "Something went wrong",
        retry: "Retry",
        unknown: "Unknown",
      },
      costs: {
        agents: {
          agent: "Agent",
          cost: "Cost",
          empty: "No agent spend in this period",
          runs: "Runs",
          title: "Spend by agent",
          tokens: "Tokens",
          unnamed: "Unnamed agent",
        },
        incidents: {
          keepPaused: "Keep paused",
          raiseAndResume: "Raise and resume",
          title: "Cost incidents",
        },
        policies: {
          amount: "Amount",
          empty: "No cost policies",
          observed: "Observed: {{amount}}",
          scope: "Scope",
          scopeType: {
            agent: "Agent",
            company: "Company",
            project: "Project",
          },
          title: "Cost policies",
          window: {
            calendar_month_utc: "Calendar month (UTC)",
            lifetime: "Lifetime",
          },
        },
        tile: {
          budget: "Budget",
          incidents: "Incidents",
          pausedAgents: "Paused agents",
          spent: "Spent",
          utilization: "Utilization",
        },
        title: "Costs",
      },
      decisions: {
        badge: "{{count}} decisions waiting",
        card: {
          age: "{{age}} ago",
          decide: "Decide",
          dismiss: "Dismiss",
          expired: "Expired",
          expires: "Expires {{time}}",
          optionExecutes: "Executes on accept: {{action}}",
          options: "Options",
          preparedBy: "Prepared by {{who}}",
          summary: "Summary",
        },
        empty: {
          body: "Nothing waits for a decision right now.",
          filtered: {
            body: "No decisions match the current filters.",
            title: "No matches",
          },
          title: "No decisions",
        },
        filter: {
          all: "All",
          external: "External",
          money: "Money",
          policies: "Policies",
        },
        subtitle: "Awaiting your choice",
        title: "Decisions",
      },
      settings: {
        language: {
          note: "Agent output and identifiers are not translated.",
          preview: {
            decisionBody: "A decision card preview: options, expiry and the actor who prepared it.",
            decisionTitle: "Decision card",
            title: "Preview",
          },
          subtitle: "Interface language",
          title: "Language and formats",
        },
        runs: {
          off: "Runs are off",
          reset: "Reset",
          save: "Save",
          saveError: "Could not save. The value stays applied until reload.",
          source: {
            default: "Default",
            env: "Environment",
            settings: "Settings",
          },
          subtitle: "How the dispatch of runs is configured",
          title: "Runs",
        },
        system: {
          changelog: {
            actor: "Actor",
            empty: "No changes recorded",
            title: "Changelog",
          },
          channels: {
            title: "Channels",
            web: "Web",
          },
          denied: "Access denied",
          deniedHint: "You do not have permission to view this screen.",
          keys: {
            created: "Created",
            empty: "No keys",
            expires: "Expires",
            lastUsed: "Last used",
            never: "Never",
            revoked: "Revoked",
            title: "Keys",
          },
          members: {
            empty: "No members",
            role: "Role",
            status: "Status",
            title: "Members",
          },
          subtitle: "Instance-wide settings",
          title: "System",
        },
        navLabel: "Settings sections",
      },
      owner: "Owner",
      ownerChannel: "Web",
      nests: {
        all: "All nests",
      },
      phone: {
        status: "Owner · Web",
      },
      chip: {
        colony: "{{active}} of {{total}}",
        fleet: "Fleet",
        fleetAttention: "Fleet: 1 attention",
        forecast: "{{spend}} of {{budget}}",
      },
      commander: {
        aria: "Tell the Commander (Ctrl K)",
        placeholder: "Tell the Commander…",
        stubNote: "Stub: the message is not sent yet. It opens the existing chat; the Commander conversation arrives with the 1.6 chat update.",
        // myrmidon(1.6-CTO-CHAT-A): palette carries the draft to the real screen.
        carryNote: "The draft opens in the Commander chat, where the board proposes an epic from your text.",
        openChat: "Open chat",
      },
      nav: {
        railLabel: "Main navigation",
        badge: {
          attention: "{{count}} items need attention",
        },
      },
      screens: {
        placeholderTitle: "This screen arrives with 2.0",
        placeholderBody: "The 2.0 layout for this area is not wired yet; the working screen below keeps the flow.",
        placeholderLegacyLink: "Back to the current layout",
      },
  },
  // myrmidon(1.6-CTO-CHAT-A): the Commander chat screen — free-text planning
  // entry (screen-map §4.3).
  commanderChat: {
    title: "Commander chat",
    subtitle:
      "Describe what you want in plain text — the board proposes an epic with tasks for your approval.",
    loading: "Loading conversation…",
    noAgent: "No Commander agent found in this company yet.",
    placeholder: "Tell the Commander what to build…",
    send: "Build a plan",
    planAria: "Proposed plan",
    epicLabel: "Epic",
    resolving: "Applying your decision…",
  },
};

export type Ui2Catalog = {
  nav: {
    newTask: string;
    search: string;
    dashboard: string;
    inbox: string;
    decisions: string;
    status: string;
    conferenceRoom: string;
    work: string;
    tasks: string;
    projects: string;
    routines: string;
    artifacts: string;
    cases: string;
    pipelines: string;
    goals: string;
    workspaces: string;
    org: string;
    agents: string;
    skills: string;
    connectors: string;
    audit: string;
    organization: string;
    timeline: string;
    costs: string;
    activity: string;
    settings: string;
    home: string;
    unread: string;
    decisionsBadge: string;
    shell: {
      observe: string;
      commandCenter: string;
      fleet: string;
      swarm: string;
      quality: string;
      decisionsAndComms: string;
      waitingForMe: string;
      commander: string;
      more: string;
    };
  };
  common: {
    cancel: string;
    save: string;
    close: string;
    retry: string;
    retrying: string;
    remove: string;
    removing: string;
    update: string;
    loading: string;
    moreActions: string;
    none: string;
    me: string;
    board: string;
    apply: string;
    undo: string;
    on: string;
    off: string;
    notSaved: string;
  };
  language: {
    label: string;
    english: string;
    russian: string;
    switchTo: string;
    settingsTitle: string;
    settingsDescription: string;
    currentLanguage: string;
    previewTitle: string;
    previewNav: string;
    previewDecisionCard: string;
    previewNavItemDecisions: string;
    previewNavItemSwarm: string;
    previewNavItemCosts: string;
    previewDecisionCardTitle: string;
    previewDecisionCardBody: string;
    savedToast: string;
    saveFailed: string;
    serverHint: string;
  };
  status: Record<
    | "open"
    | "inProgress"
    | "inReview"
    | "blocked"
    | "done"
    | "cancelled"
    | "todo"
    | "queued"
    | "running"
    | "error"
    | "paused"
    | "terminated"
    | "idle"
    | "failed"
    | "timedOut"
    | "scheduledRetry",
    string
  >;
  agentRoles: Record<
    | "ceo"
    | "cfo"
    | "cmo"
    | "cto"
    | "designer"
    | "devops"
    | "engineer"
    | "general"
    | "pm"
    | "qa"
    | "researcher"
    | "security",
    string
  >;
  tasks: {
    newTask: string;
    searchTasks: string;
    assignee: string;
    priority: string;
    status: string;
    filter: string;
    all: string;
    active: string;
    board: string;
    list: string;
    noTasks: string;
    createdTask: string;
    createdBy: string;
    updatedAt: string;
    commentsCount: string;
    runsCount: string;
    blocks: string;
    blockedBy: string;
    relatedTo: string;
  };
  time: {
    justNow: string;
    minutesAgo: string;
    hoursAgo: string;
    daysAgo: string;
    weeksAgo: string;
    monthsAgo: string;
    updated: string;
  };
  ui2: {
      agent: {
        overview: {
          budget: {
            none: string;
            title: string;
            utilization: string;
          },
          lastRun: string;
          missing: string;
          noRuns: string;
          runCost: string;
          runResult: string;
          runTokens: string;
          runs: {
            empty: string;
            title: string;
          },
          spend: {
            month: string;
          },
          status: string;
          title: string;
        },
      },
      common: {
        emptyDoneSr: string;
        emptyFilteredSr: string;
        error: string;
        retry: string;
        unknown: string;
      },
      costs: {
        agents: {
          agent: string;
          cost: string;
          empty: string;
          runs: string;
          title: string;
          tokens: string;
          unnamed: string;
        },
        incidents: {
          keepPaused: string;
          raiseAndResume: string;
          title: string;
        },
        policies: {
          amount: string;
          empty: string;
          observed: string;
          scope: string;
          scopeType: {
            agent: string;
            company: string;
            project: string;
          },
          title: string;
          window: {
            calendar_month_utc: string;
            lifetime: string;
          },
        },
        tile: {
          budget: string;
          incidents: string;
          pausedAgents: string;
          spent: string;
          utilization: string;
        },
        title: string;
      },
      decisions: {
        badge: string;
        card: {
          age: string;
          decide: string;
          dismiss: string;
          expired: string;
          expires: string;
          optionExecutes: string;
          options: string;
          preparedBy: string;
          summary: string;
        },
        empty: {
          body: string;
          filtered: {
            body: string;
            title: string;
          },
          title: string;
        },
        filter: {
          all: string;
          external: string;
          money: string;
          policies: string;
        },
        subtitle: string;
        title: string;
      },
      settings: {
        language: {
          note: string;
          preview: {
            decisionBody: string;
            decisionTitle: string;
            title: string;
          },
          subtitle: string;
          title: string;
        },
        runs: {
          off: string;
          reset: string;
          save: string;
          saveError: string;
          source: {
            default: string;
            env: string;
            settings: string;
          },
          subtitle: string;
          title: string;
        },
        system: {
          changelog: {
            actor: string;
            empty: string;
            title: string;
          },
          channels: {
            title: string;
            web: string;
          },
          denied: string;
          deniedHint: string;
          keys: {
            created: string;
            empty: string;
            expires: string;
            lastUsed: string;
            never: string;
            revoked: string;
            title: string;
          },
          members: {
            empty: string;
            role: string;
            status: string;
            title: string;
          },
          subtitle: string;
          title: string;
        },
        navLabel: string;
      },
    owner: string;
    ownerChannel: string;
    nests: {
      all: string;
    },
    phone: {
      status: string;
    },
    chip: {
      colony: string;
      fleet: string;
      fleetAttention: string;
      forecast: string;
    },
    commander: {
      aria: string;
      placeholder: string;
      stubNote: string;
      // myrmidon(1.6-CTO-CHAT-A): palette carries the draft to the real screen.
      carryNote: string;
      openChat: string;
    },
    nav: {
      railLabel: string;
      badge: {
        attention: string;
      },
    },
    screens: {
      placeholderTitle: string;
      placeholderBody: string;
      placeholderLegacyLink: string;
    },
  },
  // myrmidon(1.6-CTO-CHAT-A): the Commander chat screen — free-text planning
  // entry (screen-map §4.3). Keys render only via useUi2T.
  commanderChat: {
    title: string;
    subtitle: string;
    loading: string;
    noAgent: string;
    placeholder: string;
    send: string;
    planAria: string;
    epicLabel: string;
    resolving: string;
  };};
