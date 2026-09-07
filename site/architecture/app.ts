import { ArchitectureScene } from "./scene.js";
import { focusedViews } from "./types.js";
import type {
  Architecture,
  Component,
  SourceReference,
  System,
  ViewState,
} from "./types.js";

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
  focused: null,
  lens: "all",
  reading: "overview",
  inspecting: false,
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
  const focusId = query.get("focus");
  const focused =
    focusId && nodes.has(focusId) && parents.get(focusId)?.id !== focusId
      ? focusId
      : null;
  const isolated = focused ? parents.get(focused)!.id : query.get("inside");
  const lens = query.get("view") ?? "all";
  const journey =
    data.journeys.find((item) => item.id === query.get("flow"))?.id ??
    defaults.journey;
  const step = Number(query.get("step") ?? -1);
  const explosion = Number(query.get("explode") ?? (isolated ? 100 : 0));
  return {
    ...defaults,
    focused,
    lens:
      Object.hasOwn(focusedViews, lens) &&
      (!selected ||
        !parents.has(selected) ||
        lens === "all" ||
        (
          focusedViews[lens as ViewState["lens"]].systems as readonly string[]
        ).includes(parents.get(selected)!.id))
        ? (lens as ViewState["lens"])
        : "all",
    reading: query.get("read") === "mechanics" ? "mechanics" : "overview",
    inspecting: query.get("inspect") === "1" || !!isolated || !!focused,
    selected: focused ?? (selected && nodes.has(selected) ? selected : null),
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
  if (state.focused) query.set("focus", state.focused);
  if (state.lens !== "all") query.set("view", state.lens);
  if (state.reading === "mechanics") query.set("read", state.reading);
  if (state.inspecting && state.step >= 0) query.set("inspect", "1");
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

// Opening a panel is an interaction, independent of its cached content.
function openDetails() {
  $("systems").classList.remove("open");
  $("inspector").classList.add("open");
  if (compact()) $("detail-title")?.focus({ preventScroll: true });
}

function restoreDetails() {
  $("inspector").classList.toggle(
    "open",
    (!!state.selected || state.lens !== "all") &&
      (state.step < 0 || state.inspecting),
  );
}

function select(id: string) {
  if (!nodes.has(id)) return;
  stop();
  const parent = parents.get(id)!;
  const resource = id !== parent.id;
  const inventory = !state.isolated && state.explosion === 100;
  setState(
    {
      selected: id,
      focused: state.focused === id ? id : null,
      reading: "overview",
      inspecting: true,
      rotating: false,
      labels: resource ? true : state.labels,
      explosion: resource ? 100 : state.explosion,
      lens:
        state.lens !== "all" &&
        !(focusedViews[state.lens].systems as readonly string[]).includes(
          parent.id,
        )
          ? "all"
          : state.lens,
      isolated: resource
        ? inventory
          ? null
          : parent.id
        : state.isolated && state.isolated !== parent.id
          ? null
          : state.isolated,
    },
    true,
  );
  openDetails();
  if (resource) scene?.reset();
}

function fullSystem() {
  stop();
  setState(
    {
      selected: null,
      isolated: null,
      focused: null,
      lens: "all",
      explosion: 0,
      rotating: false,
      inspecting: true,
    },
    true,
  );
  $("systems").classList.remove("open");
  $("inspector").classList.remove("open");
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
      focused: null,
      inspecting: true,
      rotating: false,
      explosion: opening ? 100 : 0,
    },
    true,
  );
  scene?.reset();
  if (compact()) $("inspector").classList.remove("open");
}

function sources(node: { sources: SourceReference[] }) {
  return `<details class="source-details"><summary>Implementation · ${node.sources.length} source${node.sources.length === 1 ? "" : "s"}</summary>${node.sources.map((source) => `<a class="source-link" href="${escape(source.url)}" target="_blank" rel="noreferrer">${escape(source.file)} ↗<span>Line ${source.line} · ${escape(source.anchor)}</span></a>`).join("")}<p class="source-note">Source anchors are checked at build time. Explanations are reviewed alongside code changes.</p></details>`;
}

function endpointTitle(id: string) {
  return (
    nodes.get(id)?.title ??
    data.externals.find((item) => item.id === id)?.title ??
    id
  );
}

function focusResource() {
  if (!state.selected || state.selected === parents.get(state.selected)!.id)
    return;
  stop();
  setState(
    {
      focused: state.selected,
      isolated: parents.get(state.selected)!.id,
      explosion: 100,
      rotating: false,
      inspecting: true,
    },
    true,
  );
  scene?.reset();
  if (compact()) $("inspector").classList.remove("open");
}

function returnToSystem() {
  const parent = state.selected ? parents.get(state.selected)! : undefined;
  if (!parent) return;
  stop();
  setState(
    {
      focused: null,
      selected: parent.id,
      isolated: parent.id,
      explosion: 100,
      rotating: false,
      inspecting: true,
    },
    true,
  );
  openDetails();
  scene?.reset();
}

function renderDetails() {
  const key = `${state.selected}:${state.isolated}:${state.focused}:${state.reading}:${state.step}:${state.inspecting}:${state.lens}`;
  if (detailKey === key) return;
  detailKey = key;
  $("inspector").scrollTop = 0;
  if (!state.selected && state.lens !== "all") {
    const view = focusedViews[state.lens];
    const conceptId = {
      runtime: "run",
      durability: "durability",
      authority: "capability-envelope",
    }[state.lens];
    const concept = data.concepts.find((item) => item.id === conceptId)!;
    $("detail-content").innerHTML =
      `<div class="detail-head"><span>EXPLORE A QUESTION</span><button class="icon-button" data-action="close" aria-label="Close details">×</button></div><div class="detail-body"><h2 id="detail-title" tabindex="-1">${escape(view.title)}</h2><p class="detail-description">${escape(concept.description)}</p><div class="inside-heading"><span class="small-label">SYSTEMS IN THIS VIEW</span></div>${view.systems.map((id) => `<button class="child-row" data-select="${id}">${escape(nodes.get(id)!.title)}<span>↗</span></button>`).join("")}${sources(concept)}<button class="inspect-action" data-action="full">Return to full architecture <span>↙</span></button></div>`;
    return;
  }
  if (!state.selected) {
    $("detail-content").innerHTML =
      `<div class="detail-head">START HERE <span>↗</span></div><div class="detail-body"><div class="welcome-icon" aria-hidden="true">⌘</div><h2>One request.<br>One durable Run.</h2><p class="detail-description">Rat Things runs cloud agents in your AWS account. A request gets a durable receipt first; execution and result delivery happen later.</p><button class="inspect-action" data-action="start">Follow one task <span>→</span></button><div class="welcome-path"><div><span>1</span>Accept and save the request</div><div><span>2</span>Run within fixed permissions</div><div><span>3</span>Store the result, then deliver it</div></div><button class="child-row" data-action="concepts">Run, Thing, conversation… <span>?</span></button><p class="welcome-note">Select a system, open its parts, then focus a resource. Every explanation links to its implementation.</p><p class="source-note">Logical architecture. Shapes and spacing illustrate roles; they do not describe hardware or a live deployment.</p></div>`;
    return;
  }
  const node = nodes.get(state.selected)!;
  const parent = parents.get(state.selected)!;
  const isSystem = node.id === parent.id;
  const related = data.connections.filter(
    (connection) => connection.from === node.id || connection.to === node.id,
  );
  $("inspector").style.setProperty("--system-color", parent.color);
  const overview = `<p class="detail-description">${escape(node.description)}</p><ul class="detail-facts">${node.facts.map((fact) => `<li>${escape(fact)}</li>`).join("")}</ul>`;
  const mechanics = node.mechanics
    ? `<dl class="resource-contract"><dt>Receives</dt><dd>${escape(node.inputs!)}</dd><dt>Produces</dt><dd>${escape(node.outputs!)}</dd><dt>How it works</dt><dd>${escape(node.mechanics)}</dd><dt>When things go wrong</dt><dd>${escape(node.failure!)}</dd></dl>`
    : `<p class="detail-description">Explore a resource below to see its inputs, outputs, behavior and failure handling.</p>`;
  $("detail-content").innerHTML =
    `<div class="detail-head"><span>${isSystem ? "SYSTEM" : escape(parent.title.toUpperCase())} / ${String(data.systems.indexOf(parent) + 1).padStart(2, "0")}</span><button class="icon-button" data-action="close" aria-label="Close details">×</button></div><div class="detail-body"><h2 id="detail-title" tabindex="-1">${escape(node.title)}</h2><p class="detail-subtitle">${escape(node.subtitle)}</p><div class="detail-tabs" role="tablist" aria-label="Resource explanation"><button id="overview-tab" role="tab" data-reading="overview" aria-controls="explanation" aria-selected="${state.reading === "overview"}" tabindex="${state.reading === "overview" ? "0" : "-1"}">Overview</button><button id="mechanics-tab" role="tab" data-reading="mechanics" aria-controls="explanation" aria-selected="${state.reading === "mechanics"}" tabindex="${state.reading === "mechanics" ? "0" : "-1"}">How it works</button></div><div id="explanation" role="tabpanel" aria-labelledby="${state.reading}-tab">${state.reading === "overview" ? overview : mechanics}</div>${!isSystem ? `<button class="inspect-action" data-action="${state.focused ? "parent" : "focus"}">${state.focused ? "Back to " + escape(parent.title) : "Focus this resource"}<span aria-hidden="true">${state.focused ? "↙" : "↗"}</span></button>` : ""}<button class="${isSystem ? "inspect-action" : "child-row"}" data-action="isolate">${state.isolated === parent.id ? "Return to full system" : `Look inside ${escape(parent.title.toLowerCase())}`}<span aria-hidden="true">${state.isolated ? "↙" : "↗"}</span></button>${isSystem ? `<div class="inside-heading"><span class="small-label">INSIDE THIS SYSTEM</span><span class="count">${parent.components.length}</span></div><div class="child-list">${parent.components.map((child) => `<button class="child-row" data-select="${child.id}">${escape(child.title)}<span aria-hidden="true">↗</span></button>`).join("")}</div>` : `<button class="child-row" data-select="${parent.id}">← All ${escape(parent.title.toLowerCase())} components</button>`}${sources(node)}${
      related.length
        ? `<div class="inside-heading"><span class="small-label">HANDOFFS</span></div>${related
            .map((connection) => {
              const other =
                connection.from === node.id ? connection.to : connection.from;
              const tag = nodes.has(other)
                ? `button data-select="${other}"`
                : "div";
              return `<${tag} class="connection-row">${connection.from === node.id ? "→" : "←"} ${escape(endpointTitle(other))}<span>${escape(connection.label)}</span></${nodes.has(other) ? "button" : "div"}>`;
            })
            .join("")}`
        : ""
    }</div>`;
}

function renderSearch() {
  const query = $<HTMLInputElement>("resource-search")
    .value.trim()
    .toLocaleLowerCase();
  const hits = query
    ? [...nodes.values()].filter((node) =>
        [node.title, node.subtitle, ...(node.aliases ?? [])]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query),
      )
    : [];
  $("search-results").hidden = !query;
  $("system-list").hidden = !!query;
  $("search-results").innerHTML =
    hits
      .map(
        (node) =>
          `<button class="search-result" data-select="${node.id}"><strong>${escape(node.title)}</strong><span>${escape(parents.get(node.id)!.title)} · ${escape(node.subtitle)}</span></button>`,
      )
      .join("") ||
    "<p class=search-empty>No matching resources. Try a system or service name.</p>";
  $("search-status").textContent = query
    ? `${hits.length} matching resources`
    : "";
}

function render() {
  scene?.update(state);
  const selectedParent = state.selected ? parents.get(state.selected) : null;
  document
    .querySelectorAll<HTMLButtonElement>(".system-row")
    .forEach((button) => {
      const selected = button.dataset.select === selectedParent?.id;
      button.classList.toggle("selected", selected);
      button.classList.toggle(
        "outside-view",
        state.lens !== "all" &&
          !(focusedViews[state.lens].systems as readonly string[]).includes(
            button.dataset.select!,
          ),
      );
      button.setAttribute("aria-pressed", String(selected));
    });
  $("all-systems").setAttribute(
    "aria-pressed",
    String(!state.isolated && !state.selected && state.lens === "all"),
  );
  $<HTMLInputElement>("explosion").value = String(state.explosion);
  $("explosion-value").textContent = `${state.explosion}%`;
  $<HTMLInputElement>("labels").checked = state.labels;
  $("rotate").setAttribute("aria-pressed", String(state.rotating));
  $<HTMLButtonElement>("rotate").disabled =
    !state.isolated && state.explosion === 100;
  document.querySelector<HTMLElement>(".orbit-hint")!.textContent =
    !state.isolated && state.explosion === 100
      ? "DRAG TO PAN · SCROLL TO ZOOM · CLICK TO INSPECT"
      : "DRAG TO ORBIT · SCROLL TO ZOOM · CLICK TO INSPECT";
  $<HTMLSelectElement>("focused-view").value = state.lens;
  $("stage-mode").textContent = state.focused
    ? "RESOURCE FOCUS"
    : state.isolated
      ? "COMPONENT VIEW"
      : state.explosion === 100
        ? "RESOURCE INVENTORY"
        : state.explosion > 0
          ? "EXPLODED VIEW"
          : "ASSEMBLED VIEW";
  $("model-caption").textContent = state.focused
    ? nodes.get(state.focused)!.title
    : state.isolated
      ? `${parents.get(state.isolated)!.components.length} components`
      : state.lens !== "all"
        ? `${focusedViews[state.lens].systems.length} systems · ${focusedViews[state.lens].title}`
        : `${data.systems.length} systems · ${data.provenance.componentCount} components`;
  $("breadcrumb").innerHTML = state.isolated
    ? `<button data-action="full">Rat Things</button><span>/</span>${state.focused ? `<button data-action="parent">${escape(nodes.get(state.isolated)!.title)}</button><span>/</span>${escape(nodes.get(state.focused)!.title)}` : escape(nodes.get(state.isolated)!.title)}`
    : state.lens !== "all"
      ? `<button data-action="full">Rat Things</button><span>/</span><button data-action="details" aria-label="Read about ${focusedViews[state.lens].title}">${focusedViews[state.lens].title}</button>`
      : state.explosion === 100
        ? `<button data-action="full">Rat Things</button><span>/</span>All resources`
        : "Rat Things <span>/</span> Whole system";
  renderDetails();
  const journey = data.journeys.find((item) => item.id === state.journey)!;
  const step = journey.steps[state.step];
  $<HTMLSelectElement>("journey").value = state.journey;
  $("step-handoff").hidden = !step;
  $("step-handoff").innerHTML = step
    ? `<span class="handoff-kind" data-kind="${step.handoff.kind}">${step.handoff.kind === "data" ? "DURABLE DATA" : step.handoff.kind.toUpperCase()}</span><span class="handoff-route">${escape(endpointTitle(step.handoff.from))} <b aria-hidden="true">→</b> ${escape(endpointTitle(step.handoff.to))}</span><span class="handoff-payload">${escape(step.handoff.payload)}</span>`
    : "";
  $("inspect-step").hidden = !step || state.inspecting;
  $("resume-step").hidden = !step || !state.inspecting;
  $("inspect-step").textContent = step
    ? `Inspect ${nodes.get(step.node)!.title} ↗`
    : "Inspect step";
  $("resume-step").textContent = `Return to step ${state.step + 1} ↩`;
  document
    .querySelectorAll<HTMLElement>("[data-external]")
    .forEach((element) => {
      element.classList.toggle(
        "active",
        !!step &&
          !state.inspecting &&
          [step.handoff.from, step.handoff.to].includes(
            element.dataset.external!,
          ),
      );
    });
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
    `<span aria-hidden="true">${state.step === journey.steps.length - 1 ? "↻" : "→"}</span><span>${state.step === journey.steps.length - 1 ? "Replay" : state.step >= 0 ? "Continue" : "Trace a Run"}</span>`;
  $("play").setAttribute(
    "aria-label",
    state.step === journey.steps.length - 1
      ? "Replay walkthrough"
      : state.step >= 0
        ? "Continue walkthrough"
        : "Trace a Run",
  );
  $("autoplay").innerHTML = `<span aria-hidden="true">${state.playing ? "Ⅱ" : "▶"}</span> ${state.playing ? "Pause tour" : "Play tour"}`;
  $("autoplay").setAttribute("aria-pressed", String(state.playing));
}

function goToStep(index: number, play = false) {
  const journey = data.journeys.find((item) => item.id === state.journey)!;
  const next = Math.min(journey.steps.length - 1, Math.max(0, index));
  const step = journey.steps[next]!;
  setState({
    step: next,
    selected: step.node,
    isolated: null,
    focused: null,
    inspecting: false,
    lens: "all",
    explosion: 45,
    labels: true,
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
    }, 7000);
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
  $("journey").innerHTML = data.journeys
    .map((item) => `<option value="${item.id}">${escape(item.title)}</option>`)
    .join("");
  $("focused-view").innerHTML = Object.entries(focusedViews)
    .map(([id, view]) => `<option value="${id}">${view.title}</option>`)
    .join("");
  $("external-context").innerHTML = data.externals
    .map(
      (item) =>
        `<button data-external="${item.id}" data-action="concepts" title="${escape(item.description)}">${escape(item.title)}</button>`,
    )
    .join('<span aria-hidden="true">·</span>');
  $("concept-list").innerHTML = [...data.concepts, ...data.externals]
    .map(
      (item) =>
        `<section><h3>${escape(item.title)}</h3><p>${escape(item.description)}</p>${sources(item)}</section>`,
    )
    .join("");
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
  restoreDetails();
  startScene();
  $("explorer").dataset.ready = "true";

  document.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button",
    );
    if (!target) return;
    if (target.dataset.select) {
      select(target.dataset.select);
      $<HTMLInputElement>("resource-search").value = "";
      renderSearch();
    }
    if (target.dataset.reading)
      setState({ reading: target.dataset.reading as ViewState["reading"] });
    if (target.dataset.action === "start") {
      stop();
      goToStep(0);
    }
    if (target.dataset.action === "focus") focusResource();
    if (target.dataset.action === "parent") returnToSystem();
    if (target.dataset.action === "details") {
      stop();
      setState({
        selected: null,
        focused: null,
        inspecting: true,
        rotating: false,
      });
      openDetails();
    }
    if (target.dataset.action === "concepts") {
      stop();
      setState({ rotating: false });
      $<HTMLDialogElement>("concepts-dialog").showModal();
    }
    if (target.dataset.action === "close") {
      stop();
      if (compact()) {
        $("inspector").classList.remove("open");
        render();
      } else {
        setState({
          selected: null,
          focused: null,
          lens: state.selected ? state.lens : "all",
        });
      }
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
  $("resource-search").addEventListener("input", renderSearch);
  $("focused-view").addEventListener("change", (event) => {
    stop();
    setState(
      {
        lens: (event.target as HTMLSelectElement).value as ViewState["lens"],
        focused: null,
        isolated: null,
        selected: null,
        explosion: 0,
        rotating: false,
        inspecting: true,
      },
      true,
    );
    scene?.reset();
    if (state.lens !== "all") openDetails();
    else {
      $("systems").classList.remove("open");
      $("inspector").classList.remove("open");
    }
  });
  $("inspect-step").addEventListener("click", () => {
    stop();
    const step = data.journeys.find((item) => item.id === state.journey)!.steps[
      state.step
    ]!;
    setState(
      {
        selected: step.node,
        isolated: parents.get(step.node)!.id,
        explosion: 100,
        inspecting: true,
        rotating: false,
      },
      true,
    );
    scene?.reset();
    if (compact()) $("inspector").classList.remove("open");
  });
  $("resume-step").addEventListener("click", () => {
    stop();
    goToStep(state.step);
    scene?.reset();
  });
  $("close-concepts").addEventListener("click", () =>
    $<HTMLDialogElement>("concepts-dialog").close(),
  );
  $("explode-all").addEventListener("click", () => {
    stop();
    setState({
      explosion: 100,
      focused: null,
      rotating: false,
      inspecting: true,
    });
  });
  $("assemble").addEventListener("click", () => {
    stop();
    setState({
      explosion: 0,
      isolated: null,
      focused: null,
      rotating: false,
      inspecting: true,
    });
    scene?.reset();
  });
  $("explosion").addEventListener("input", (event) => {
    stop();
    setState({
      explosion: Number((event.target as HTMLInputElement).value),
      focused: null,
      rotating: false,
      inspecting: true,
    });
  });
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
    stop();
    const journey = data.journeys.find((item) => item.id === state.journey)!;
    goToStep(state.step === journey.steps.length - 1 ? 0 : state.step + 1);
  });
  $("autoplay").addEventListener("click", () => {
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
    $("inspector").classList.remove("open");
    setState({
      journey: (event.target as HTMLSelectElement).value,
      focused: null,
      explosion: 0,
      rotating: false,
      inspecting: false,
      lens: "all",
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
    if (
      (event.target as HTMLElement).getAttribute("role") === "tab" &&
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      const reading =
        event.key === "Home"
          ? "overview"
          : event.key === "End"
            ? "mechanics"
            : state.reading === "overview"
              ? "mechanics"
              : "overview";
      setState({ reading });
      $(`${reading}-tab`).focus();
    }
    if (event.key === "Escape") {
      if ($<HTMLDialogElement>("concepts-dialog").open) return;
      stop();
      if ($("systems").classList.contains("open")) {
        $("systems").classList.remove("open");
        $("open-systems").focus();
      } else {
        $("inspector").classList.remove("open");
        setState({
          selected: null,
          focused: null,
          rotating: false,
          inspecting: true,
        });
        if (compact()) $("open-systems").focus();
      }
    }
  });
  window.addEventListener("popstate", () => {
    stop();
    state = readLocation();
    render();
    $("systems").classList.remove("open");
    restoreDetails();
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
