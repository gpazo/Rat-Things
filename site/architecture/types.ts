import type { ResourceKind } from "./resources.js";

export interface SourceReference {
  file: string;
  anchor: string;
  line: number;
  url: string;
}

export interface Component {
  aliases?: string[];
  inputs?: string;
  outputs?: string;
  mechanics?: string;
  failure?: string;
  resource?: ResourceKind;
  id: string;
  title: string;
  subtitle: string;
  description: string;
  facts: string[];
  sources: SourceReference[];
}

export interface System extends Component {
  color: string;
  position: [number, number];
  components: Component[];
}

export interface Connection {
  from: string;
  to: string;
  label: string;
  kind: "request" | "data" | "access" | "recovery";
  sources: SourceReference[];
}

export interface TeachingNote {
  id: string;
  title: string;
  description: string;
  sources: SourceReference[];
}

export interface Handoff {
  from: string;
  to: string;
  payload: string;
  kind: Connection["kind"];
  sources: SourceReference[];
}

export const focusedViews = {
  all: { title: "All systems", systems: [] as string[] },
  runtime: {
    title: "Request to result",
    systems: ["ingress", "control", "execution", "storage", "delivery"],
  },
  durability: {
    title: "What survives",
    systems: ["control", "storage", "recovery"],
  },
  authority: {
    title: "Where access is enforced",
    systems: ["access", "integrations", "execution"],
  },
} as const;

export interface Journey {
  id: string;
  title: string;
  steps: {
    node: string;
    title: string;
    description: string;
    state: string;
    handoff: Handoff;
  }[];
}

export interface Architecture {
  concepts: TeachingNote[];
  externals: TeachingNote[];
  systems: System[];
  connections: Connection[];
  journeys: Journey[];
  provenance: {
    revision: string;
    fingerprint: string;
    sourceCount: number;
    componentCount: number;
  };
}

export interface ViewState {
  focused: string | null;
  lens: keyof typeof focusedViews;
  reading: "overview" | "mechanics";
  inspecting: boolean;
  selected: string | null;
  isolated: string | null;
  explosion: number;
  labels: boolean;
  rotating: boolean;
  journey: string;
  step: number;
  playing: boolean;
}
