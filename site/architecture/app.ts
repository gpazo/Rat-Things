import { ArchitectureScene } from "./scene.js";
import type { Architecture, Component, System, ViewState } from "./types.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const defaults: ViewState = {
  selected: null,
  isolated: null,
  explosion: 0,
  labels: true,
  rotating: false,
  journey: "api",
  step: -1,
  playing: false,
};
let scene: ArchitectureScene | undefined;
let data: Architecture;
let state: ViewState = { ...defaults };
let timer: ReturnType<typeof setTimeout> | undefined;
let detailKey = "";
const nodes = new Map<string, Component>();
const parents = new Map<string, System>();
const compact = () => window.matchMedia("(max-width: 800px)").matches;

function readLocation(): ViewState {
  const query = new URLSearchParams(location.hash.slice(1));
  const selected = query.get("node");
  const isolated = query.get("inside");
  const journey =
    data.journeys.find((item) => item.id === query.get("flow"))?.id ??
    defaults.journey;
  const step = Number(query.get("step") ?? -1);
  const explosion = Number(query.get("explode") ?? (isolated ? 100 : 0));
  return {
    ...defaults,
    selected: selected && nodes.has(selected) ? selected : null,
    isolated:
      isolated && data.systems.some((system) => system.id === isolated)
        ? isolated
        : null,
    explosion: Number.isFinite(explosion)
      ? Math.max(0, Math.min(100, Math.round(explosion)))
      : 0,
    journey,
    step:
      Number.isInteger(step) &&
      step >= 0 &&
      step < data.journeys.find((item) => item.id === journey)!.steps.length
        ? step
        : -1,
  };
}

function writeLocation(push = false) {
  const query = new URLSearchParams();
  if (state.selected) query.set("node", state.selected);
  if (state.isolated) query.set("inside", state.isolated);
  if (state.explosion) query.set("explode", String(state.explosion));
  if (state.journey !== defaults.journey) query.set("flow", state.journey);
  if (state.step >= 0) query.set("step", String(state.step));
  const url = `${location.pathname}${location.search}${query.size ? `#${query}` : ""}`;
  if (push && `${location.pathname}${location.search}${location.hash}` !== url)
    history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

function setState(patch: Partial<ViewState>, push = false) {
  state = { ...state, ...patch };
  render();
  writeLocation(push);
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  state.playing = false;
}

function select(id: string) {
  if (!nodes.has(id)) return;
  stop();
  const parent = parents.get(id)!;
  setState(
    {
      selected: id,
      isolated:
        state.isolated && state.isolated !== parent.id ? null : state.isolated,
    },
    true,
  );
  $("systems").classList.remove("open");
  if (compact()) $("detail-title")?.focus({ preventScroll: true });
}

function fullSystem() {
  stop();
  setState({ selected: null, isolated: null }, true);
  $("systems").classList.remove("open");
  scene?.reset();
}

function lookInside() {
  if (!state.selected) return;
  stop();
  const parent = parents.get(state.selected)!;
  const opening = state.isolated !== parent.id;
  setState(
    {
      isolated: opening ? parent.id : null,
      explosion: opening ? 100 : state.explosion,
    },
    true,
  );
  scene?.reset();
  if (compact()) $("inspector").classList.remove("open");
}

function sources(node: Component) {
  return `<details class="source-details"><summary>Implementation · ${node.sources.length} source${node.sources.length === 1 ? "" : "s"}</summary>${node.sources.map((source) => `<a class="source-link" href="${escape(source.url)}" target="_blank" rel="noreferrer">${escape(source.file)} ↗<span>Line ${source.line} · ${escape(source.anchor)}</span></a>`).join("")}<p class="source-note">References are checked against the source at build time.</p></details>`;
}

function renderDetails() {
  const key = `${state.selected}:${state.isolated}`;
  if (detailKey === key) return;
  detailKey = key;
  $("inspector").classList.toggle("open", !!state.selected);
  if (!state.selected) {
    $("detail-content").innerHTML =
      `<div class="detail-head">AN OPEN SYSTEM <span>↗</span></div><div class="detail-body"><div class="welcome-icon" aria-hidden="true">⌘</div><h2>One request.<br>One durable Run.</h2><p class="detail-description">Rat Things is a self-hosted backend for cloud agents. Work moves through separate stages, inside your AWS account.</p><div class="welcome-path"><div><span>1</span>Authenticate the request</div><div><span>2</span>Coordinate durable work</div><div><span>3</span>Run in an isolated MicroVM</div><div><span>4</span>Persist and deliver the result</div></div><button class="inspect-action" data-select="execution">Explore the runtime <span>↗</span></button><p class="welcome-note">Select a system to understand its role. Explode the layers to reveal its parts, then follow the links into the implementation.</p></div>`;
    return;
  }
  const node = nodes.get(state.selected)!;
  const parent = parents.get(state.selected)!;
  const isSystem = node.id === parent.id;
  const related = data.connections.filter(
    (connection) =>
      connection.from === parent.id || connection.to === parent.id,
  );
  $("inspector").style.setProperty("--system-color", parent.color);
  $("detail-content").innerHTML =
    `<div class="detail-head"><span>${isSystem ? "SYSTEM" : escape(parent.title.toUpperCase())} / ${String(data.systems.indexOf(parent) + 1).padStart(2, "0")}</span><button class="icon-button" data-action="close" aria-label="Close details">×</button></div><div class="detail-body"><h2 id="detail-title" tabindex="-1">${escape(node.title)}</h2><p class="detail-subtitle">${escape(node.subtitle)}</p><p class="detail-description">${escape(node.description)}</p><ul class="detail-facts">${node.facts.map((fact) => `<li>${escape(fact)}</li>`).join("")}</ul><button class="inspect-action" data-action="isolate">${state.isolated === parent.id ? "Return to full system" : `Look inside ${escape(parent.title.toLowerCase())}`}<span aria-hidden="true">${state.isolated ? "↙" : "↗"}</span></button>${isSystem ? `<div class="inside-heading"><span class="small-label">INSIDE THIS SYSTEM</span><span class="count">${parent.components.length}</span></div><div class="child-list">${parent.components.map((child) => `<button class="child-row" data-select="${child.id}">${escape(child.title)}<span aria-hidden="true">↗</span></button>`).join("")}` : `<button class="child-row" data-select="${parent.id}">← All ${escape(parent.title.toLowerCase())} components</button>`}${sources(node)}${
      isSystem
        ? `<div class="inside-heading"><span class="small-label">CONNECTED TO</span></div>${related
            .map((connection) => {
              const other =
                connection.from === parent.id ? connection.to : connection.from;
              return `<button class="connection-row" data-select="${other}">${connection.from === parent.id ? "→" : "←"} ${escape(nodes.get(other)!.title)}<span>${escape(connection.label)}</span></button>`;
            })
            .join("")}`
        : ""
    }</div>`;
}

function render() {
  scene?.update(state);
  const selectedParent = state.selected ? parents.get(state.selected) : null;
  document
    .querySelectorAll<HTMLButtonElement>(".system-row")
    .forEach((button) => {
      const selected = button.dataset.select === selectedParent?.id;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  $("all-systems").setAttribute(
    "aria-pressed",
    String(!state.isolated && !state.selected),
  );
  $<HTMLInputElement>("explosion").value = String(state.explosion);
  $("explosion-value").textContent = `${state.explosion}%`;
  $<HTMLInputElement>("labels").checked = state.labels;
  $("rotate").setAttribute("aria-pressed", String(state.rotating));
  $("stage-mode").textContent = state.isolated
    ? "COMPONENT VIEW"
    : state.explosion > 0
      ? "EXPLODED VIEW"
      : "ASSEMBLED VIEW";
  $("model-caption").textContent = state.isolated
    ? `${parents.get(state.isolated)!.components.length} components`
    : `${data.systems.length} systems · ${data.provenance.componentCount} components`;
  $("breadcrumb").innerHTML = state.isolated
    ? `<button data-action="full">Rat Things</button><span>/</span>${escape(nodes.get(state.isolated)!.title)}`
    : "Rat Things <span>/</span> Whole system";
  renderDetails();
  const journey = data.journeys.find((item) => item.id === state.journey)!;
  const step = journey.steps[state.step];
  $<HTMLSelectElement>("journey").value = state.journey;
  $("step-title").textContent = step?.title ?? "From request to result.";
  $("step-position").textContent = step
    ? `${String(state.step + 1).padStart(2, "0")} / ${String(journey.steps.length).padStart(2, "0")}`
    : "READY TO TRACE";
  $("step-description").textContent =
    step?.description ??
    "Walk through a request and see each system take its part.";
  $("run-state").textContent = (step?.state ?? "request").toUpperCase();
  $("step-track").innerHTML = journey.steps
    .map(
      (item, index) =>
        `<button data-step="${index}" aria-label="Step ${index + 1}: ${escape(item.title)}" ${index === state.step ? 'aria-current="step"' : ""} class="${index === state.step ? "current" : index < state.step ? "complete" : ""}"></button>`,
    )
    .join("");
  $<HTMLButtonElement>("previous-step").disabled = state.step < 1;
  $<HTMLButtonElement>("next-step").disabled =
    state.step >= journey.steps.length - 1;
  $("play").innerHTML =
    `<span aria-hidden="true">${state.playing ? "Ⅱ" : "▶"}</span><span>${state.playing ? "Pause" : state.step === journey.steps.length - 1 ? "Replay" : state.step >= 0 ? "Continue" : "Trace a Run"}</span>`;
  $("play").setAttribute(
    "aria-label",
    state.playing
      ? "Pause walkthrough"
      : state.step === journey.steps.length - 1
        ? "Replay walkthrough"
        : state.step >= 0
          ? "Continue walkthrough"
          : "Trace a Run",
  );
}

function goToStep(index: number, play = false) {
  const journey = data.journeys.find((item) => item.id === state.journey)!;
  const next = Math.min(journey.steps.length - 1, Math.max(0, index));
  const step = journey.steps[next]!;
  setState({
    step: next,
    selected: step.node,
    isolated: null,
    playing: play,
    rotating: false,
  });
  if (compact()) $("inspector").classList.remove("open");
  if (play) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.step < journey.steps.length - 1) goToStep(state.step + 1, true);
      else {
        stop();
        render();
      }
    }, 4800);
  }
}

function fallback() {
  $("scene-status").hidden = false;
  $("scene-status").innerHTML =
    'The 3D view is unavailable in this browser.<br>Explore every system and source using the Systems list.<br><button class="inspect-action" id="retry-3d">Retry 3D view ↗</button>';
  $("scene-host").dataset.renderer = "unavailable";
  $("retry-3d").addEventListener("click", startScene);
}

function startScene() {
  scene?.dispose();
  scene = undefined;
  try {
    scene = new ArchitectureScene(
      $("scene-host"),
      data,
      state,
      select,
      fallback,
    );
    $("scene-status").hidden = true;
    $("scene-host").dataset.renderer = "webgl";
  } catch (error) {
    // The catalogue and walkthrough remain fully usable without a GPU.
    console.warn(
      "Architecture WebGL view unavailable.",
      error instanceof Error ? error.message : "",
    );
    fallback();
  }
}

async function boot() {
  const response = await fetch(new URL("./data.json", import.meta.url));
  if (!response.ok)
    throw new Error("Architecture catalogue could not be loaded.");
  data = (await response.json()) as Architecture;
  if (!data.systems?.length || !data.journeys?.length)
    throw new Error("Architecture catalogue is incomplete.");
  for (const system of data.systems)
    for (const node of [system, ...system.components]) {
      nodes.set(node.id, node);
      parents.set(node.id, system);
    }
  $("system-count").textContent = String(data.systems.length);
  $("system-list").innerHTML = data.systems
    .map(
      (system, index) =>
        `<button class="system-row" style="--system-color:${system.color}" data-select="${system.id}" aria-pressed="false"><span class="system-dot"></span><span class="system-name">${escape(system.title)}</span><span class="system-count">${String(index + 1).padStart(2, "0")}</span><span class="system-arrow" aria-hidden="true">›</span></button>`,
    )
    .join("");
  $("provenance").textContent =
    `${data.provenance.sourceCount} source files · ${data.provenance.revision.slice(0, 7)} · ${data.provenance.fingerprint.slice(0, 6)}`;
  $("provenance").title =
    "Source revision and content fingerprint. Spatial schematic, not live deployment telemetry.";
  state = readLocation();
  render();
  startScene();
  $("explorer").dataset.ready = "true";

  document.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button",
    );
    if (!target) return;
    if (target.dataset.select) select(target.dataset.select);
    if (target.dataset.action === "close") {
      stop();
      setState({ selected: null });
      $(compact() ? "open-systems" : "all-systems").focus({
        preventScroll: true,
      });
    }
    if (target.dataset.action === "isolate") lookInside();
    if (target.dataset.action === "full") fullSystem();
    if (target.dataset.step !== undefined) {
      stop();
      goToStep(Number(target.dataset.step));
    }
  });
  $("all-systems").addEventListener("click", fullSystem);
  $("explode-all").addEventListener("click", () =>
    setState({ explosion: 100 }),
  );
  $("assemble").addEventListener("click", () => {
    stop();
    setState({ explosion: 0, isolated: null, rotating: false });
    scene?.reset();
  });
  $("explosion").addEventListener("input", (event) =>
    setState({ explosion: Number((event.target as HTMLInputElement).value) }),
  );
  $("labels").addEventListener("change", (event) =>
    setState({ labels: (event.target as HTMLInputElement).checked }),
  );
  $("rotate").addEventListener("click", () =>
    setState({ rotating: !state.rotating }),
  );
  $("reset-camera").addEventListener("click", () => {
    setState({ rotating: false });
    scene?.reset();
  });
  $("zoom-in").addEventListener("click", () => scene?.zoom(1.2));
  $("zoom-out").addEventListener("click", () => scene?.zoom(1 / 1.2));
  $("play").addEventListener("click", () => {
    if (state.playing) {
      stop();
      render();
    } else {
      const journey = data.journeys.find((item) => item.id === state.journey)!;
      goToStep(
        state.step === journey.steps.length - 1 ? 0 : Math.max(0, state.step),
        true,
      );
    }
  });
  $("previous-step").addEventListener("click", () => {
    stop();
    goToStep(state.step - 1);
  });
  $("next-step").addEventListener("click", () => {
    stop();
    goToStep(state.step + 1);
  });
  $("journey").addEventListener("change", (event) => {
    stop();
    setState({
      journey: (event.target as HTMLSelectElement).value,
      step: -1,
      selected: null,
      isolated: null,
    });
  });
  $("open-systems").addEventListener("click", () => {
    $("systems").classList.add("open");
    $("inspector").classList.remove("open");
    $("close-systems").focus();
  });
  $("close-systems").addEventListener("click", () => {
    $("systems").classList.remove("open");
    $("open-systems").focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      stop();
      if ($("systems").classList.contains("open")) {
        $("systems").classList.remove("open");
        $("open-systems").focus();
      } else {
        setState({ selected: null });
        if (compact()) $("open-systems").focus();
      }
    }
  });
  window.addEventListener("popstate", () => {
    stop();
    state = readLocation();
    render();
    scene?.reset();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.playing) {
      stop();
      render();
    }
  });
  window.addEventListener("pagehide", () => {
    stop();
    scene?.dispose();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) startScene();
  });
}

boot().catch((error) => {
  $("scene-status").innerHTML =
    `${escape(error instanceof Error ? error.message : "The architecture could not be loaded.")}<br><a href="docs/architecture/">Read the architecture documentation ↗</a><br><button class="inspect-action" id="retry-load">Retry loading</button>`;
  $("retry-load").addEventListener("click", () => location.reload());
});
