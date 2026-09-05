import type { ResourceKind } from "./resources.js";

export interface SourceReference {
  file: string;
  anchor: string;
  line: number;
  url: string;
}

export interface Component {
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

export interface Journey {
  id: string;
  title: string;
  steps: { node: string; title: string; description: string; state: string }[];
}

export interface Architecture {
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
  selected: string | null;
  isolated: string | null;
  explosion: number;
  labels: boolean;
  rotating: boolean;
  journey: string;
  step: number;
  playing: boolean;
}
