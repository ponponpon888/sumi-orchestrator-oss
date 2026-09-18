const definitions = [
  {
    id: "codex",
    kind: "cli",
    command: "codex",
    capability: "read-only",
    automaticModes: ["review"],
    requiresIsolation: false,
    manualReason: "Codex automatic dispatch is limited to read-only review mode."
  },
  {
    id: "claude-code",
    kind: "cli",
    command: "claude",
    capability: "write",
    automaticModes: [],
    requiresIsolation: true,
    manualReason: "Claude Code write-capable dispatch is intentionally not automated; use the generated prompt or a future explicitly approved isolated adapter."
  },
  {
    id: "browser",
    kind: "browser",
    command: "agent-browser",
    capability: "browser",
    automaticModes: [],
    requiresIsolation: false,
    manualReason: "Browser routes require an explicit browser session; SUMI records the handoff instead of auto-executing it."
  },
  {
    id: "human",
    kind: "human",
    command: null,
    capability: "action",
    automaticModes: [],
    requiresIsolation: false,
    manualReason: "Human routes require an external/manual action; SUMI records the handoff instead of auto-executing it."
  }
];

export const AGENT_ADAPTERS = Object.freeze(definitions.map((item) => Object.freeze({
  ...item,
  automaticModes: Object.freeze([...item.automaticModes])
})));

export const AGENT_IDS = Object.freeze(AGENT_ADAPTERS.map((item) => item.id));
export const CODE_AGENT_IDS = Object.freeze(AGENT_ADAPTERS.filter((item) => item.kind === "cli").map((item) => item.id));

export function getAgentAdapter(agent) {
  return AGENT_ADAPTERS.find((item) => item.id === String(agent || "").toLowerCase()) || null;
}

export function isAutomaticAdapter(adapter, mode) {
  return Boolean(adapter?.automaticModes.includes(String(mode || "").toLowerCase()));
}
