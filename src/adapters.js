const definitions = [
  {
    id: "codex",
    kind: "cli",
    command: "codex",
    capability: "read-only",
    automaticModes: ["review"],
    sessionAutomaticModes: [],
    requiresIsolation: false,
    manualReason: "Codex automatic dispatch is limited to read-only review mode."
  },
  {
    id: "claude-code",
    kind: "cli",
    command: "claude",
    capability: "write",
    automaticModes: [],
    sessionAutomaticModes: ["execute"],
    requiresIsolation: true,
    manualReason: "Direct Claude Code dispatch is manual; automatic execution requires an active isolated SUMI session."
  },
  {
    id: "browser",
    kind: "browser",
    command: "agent-browser",
    capability: "browser",
    automaticModes: [],
    sessionAutomaticModes: [],
    requiresIsolation: false,
    manualReason: "Browser routes require an explicit browser session; SUMI records the handoff instead of auto-executing it."
  },
  {
    id: "human",
    kind: "human",
    command: null,
    capability: "action",
    automaticModes: [],
    sessionAutomaticModes: [],
    requiresIsolation: false,
    manualReason: "Human routes require an external/manual action; SUMI records the handoff instead of auto-executing it."
  }
];

export const AGENT_ADAPTERS = Object.freeze(definitions.map((item) => Object.freeze({
  ...item,
  automaticModes: Object.freeze([...item.automaticModes]),
  sessionAutomaticModes: Object.freeze([...item.sessionAutomaticModes])
})));

export const AGENT_IDS = Object.freeze(AGENT_ADAPTERS.map((item) => item.id));
export const CODE_AGENT_IDS = Object.freeze(AGENT_ADAPTERS.filter((item) => item.kind === "cli").map((item) => item.id));

export function getAgentAdapter(agent) {
  return AGENT_ADAPTERS.find((item) => item.id === String(agent || "").toLowerCase()) || null;
}

export function isAutomaticAdapter(adapter, mode) {
  return Boolean(adapter?.automaticModes.includes(String(mode || "").toLowerCase()));
}


export function isAutomaticSessionAdapter(adapter, mode) {
  return Boolean(adapter?.sessionAutomaticModes.includes(String(mode || "").toLowerCase()));
}
