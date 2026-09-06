import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  focusedViews,
  type Architecture,
  type Handoff,
  type System,
  type ViewState,
} from "./types.js";
import { createResourceAsset } from "./resources.js";

type Piece = {
  id: string;
  system: System;
  index: number;
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  outline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  label: HTMLButtonElement;
  pickMeshes: THREE.Mesh[];
  target: THREE.Vector3;
  bounds: THREE.Box3;
};

type SceneConnection = {
  from: string;
  to: string;
  line: THREE.Line;
  dot: THREE.Mesh;
  arrow: THREE.Mesh;
};

/** The catalogue owns meaning; this class owns geometry, picking and camera life. */
export class ArchitectureScene {
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-12, 12, 10, -10, 0.1, 150);
  private controls: OrbitControls;
  private pieces: Piece[] = [];
  private connections: SceneConnection[] = [];
  private handoffPath: SceneConnection;
  private board: THREE.Group;
  private observer: ResizeObserver;
  private frame = 0;
  private state: ViewState;
  private picking = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private down: { x: number; y: number; pointerId: number } | null = null;
  private pointerCount = new Set<number>();
  private moved = false;
  private disposed = false;
  private dirty = true;
  private moving = true;
  private lastTime = 0;
  private zoomFactor = 1;
  private hovered: string | null = null;
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  private position = new THREE.Vector3();
  private cameraPose = {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    zoom: 0,
  };
  private cleanups: (() => void)[] = [];

  constructor(
    private host: HTMLElement,
    private catalogue: Architecture,
    state: ViewState,
    private onSelect: (id: string) => void,
    private onUnavailable: () => void,
  ) {
    this.state = { ...state };
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setClearColor(0x071114, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "3D system architecture. Drag to orbit, scroll to zoom. Components are also available in the Systems list.",
    );
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.dataset.renderer = "webgl";
    host.prepend(this.renderer.domElement);
    const lost = (event: Event) => {
      event.preventDefault();
      this.onUnavailable();
      this.dispose();
    };
    this.renderer.domElement.addEventListener("webglcontextlost", lost);
    this.cleanups.push(() =>
      this.renderer.domElement.removeEventListener("webglcontextlost", lost),
    );
    this.world.add(new THREE.HemisphereLight(0xe4fffa, 0x223143, 2.4));
    const key = new THREE.DirectionalLight(0xd3fff3, 3);
    key.position.set(4, 12, 8);
    this.world.add(key);
    const rim = new THREE.DirectionalLight(0x809bff, 2);
    rim.position.set(-10, 5, -6);
    this.world.add(rim);
    this.board = new THREE.Group();
    const base = this.box(19.2, 0.16, 11.4, "#193037", 0.7);
    base.position.y = -0.42;
    this.board.add(base);
    const grid = new THREE.GridHelper(25, 40, 0x31484b, 0x152a2e);
    grid.position.y = -0.54;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.45;
    this.board.add(grid);
    this.world.add(this.board);
    for (const system of catalogue.systems) {
      this.addPiece(system.id, system.title, system, -1);
      system.components.forEach((component, index) =>
        this.addPiece(component.id, component.title, system, index),
      );
    }
    for (const connection of catalogue.connections) {
      // External parties have explicit context cards outside the AWS model.
      if (!this.piece(connection.from) || !this.piece(connection.to)) continue;
      this.connections.push(
        this.makeConnection(connection.from, connection.to, connection.kind),
      );
    }
    this.handoffPath = this.makeConnection("", "", "request");
    this.camera.position.set(12, 23, 38);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.reduced.matches;
    this.controls.dampingFactor = 0.09;
    this.controls.enablePan = false;
    this.controls.minZoom = 0.45;
    this.controls.maxZoom = 3.5;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.autoRotateSpeed = 0.5;
    this.controls.addEventListener("change", () => {
      // OrbitControls can emit changes for sub-pixel target rounding at rest.
      // Ignore that numerical drift so a paused scene does not keep the GPU busy.
      const pose = this.cameraPose;
      if (
        pose.position.distanceToSquared(this.camera.position) > 1e-8 ||
        pose.target.distanceToSquared(this.controls.target) > 1e-8 ||
        8 * (1 - Math.abs(pose.quaternion.dot(this.camera.quaternion))) >
          1e-8 ||
        pose.zoom !== this.camera.zoom
      ) {
        this.dirty = true;
        pose.position.copy(this.camera.position);
        pose.target.copy(this.controls.target);
        pose.quaternion.copy(this.camera.quaternion);
        pose.zoom = this.camera.zoom;
      }
    });
    this.controls.target.set(0, this.state.isolated ? 0.6 : 0, 0.5);
    this.controls.update();
    this.bindPointer();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.layout(true);
    this.configureCamera();
    this.resize();
    this.animate(0);
  }

  private box(
    width: number,
    height: number,
    depth: number,
    color: string,
    opacity = 1,
  ) {
    return new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.36,
        metalness: 0.48,
        transparent: opacity < 1,
        opacity,
      }),
    );
  }

  private addPiece(id: string, title: string, system: System, index: number) {
    const group = new THREE.Group();
    const parent = index === -1;
    const mesh = this.box(
      parent ? 3.35 : 1.27,
      parent ? 0.24 : 0.12,
      parent ? 2.7 : 0.85,
      "#193039",
    );
    mesh.material.emissive.set(system.color);
    mesh.material.emissiveIntensity = parent ? 0.03 : 0.06;
    mesh.userData.id = id;
    group.add(mesh);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({
        color: system.color,
        transparent: true,
        opacity: parent ? 0.5 : 0.72,
      }),
    );
    group.add(outline);
    if (!parent) {
      const component = system.components[index]!;
      group.add(createResourceAsset(component.resource!, system.color));
    } else {
      for (let rail = 0; rail < 3; rail++) {
        const layer = this.box(
          3.12 - rail * 0.09,
          0.05,
          2.47 - rail * 0.09,
          "#243e44",
        );
        layer.position.y = -0.2 - rail * 0.1;
        group.add(layer);
      }
      for (const side of [-1, 1]) {
        const rail = this.box(0.045, 0.02, 2.2, system.color);
        rail.position.set(side * 1.53, 0.135, 0);
        group.add(rail);
      }
    }
    const label = document.createElement("button");
    label.className = `scene-label ${parent ? "system-label" : "component-label"}`;
    label.dataset.node = id;
    if (!parent) label.dataset.resource = system.components[index]!.resource!;
    label.style.setProperty("--system-color", system.color);
    label.setAttribute("aria-label", `Inspect ${title} in 3D`);
    label.innerHTML = `<span class="label-dot"></span><span class="label-title">${title}</span>${parent ? `<span class="label-index">${String(this.catalogue.systems.indexOf(system) + 1).padStart(2, "0")}</span>` : `<span class="label-system" hidden>${system.title}</span>`}`;
    label.addEventListener("click", () => this.onSelect(id));
    this.host.append(label);
    this.world.add(group);
    const pickMeshes: THREE.Mesh[] = [];
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.userData.id = id;
        pickMeshes.push(object);
      }
    });
    this.pieces.push({
      id,
      system,
      index,
      group,
      mesh,
      outline,
      label,
      pickMeshes,
      target: new THREE.Vector3(),
      bounds: new THREE.Box3().setFromObject(group),
    });
  }

  private piece(id: string) {
    return this.pieces.find((piece) => piece.id === id);
  }

  private get handoff(): Handoff | undefined {
    if (this.state.step < 0 || this.state.inspecting) return undefined;
    return this.catalogue.journeys.find(
      (journey) => journey.id === this.state.journey,
    )?.steps[this.state.step]?.handoff;
  }

  private get inventory() {
    return (
      !this.state.isolated &&
      !this.state.focused &&
      !this.handoff &&
      this.state.explosion === 100
    );
  }

  private makeConnection(
    from: string,
    to: string,
    kind: Handoff["kind"],
  ): SceneConnection {
    const color =
      kind === "request"
        ? 0x78d9bb
        : kind === "access"
          ? 0xb987a3
          : kind === "recovery"
            ? 0xe0b977
            : 0x7ea8c4;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 4 }, () => new THREE.Vector3()),
      ),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 }),
    );
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xe3fff0 }),
    );
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.28, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    line.visible = dot.visible = arrow.visible = false;
    this.world.add(line, dot, arrow);
    return { from, to, line, dot, arrow };
  }

  update(state: ViewState) {
    const cameraModeChanged =
      state.focused !== this.state.focused ||
      state.lens !== this.state.lens ||
      state.isolated !== this.state.isolated;
    const wasInventory = this.inventory;
    const wasTour = !!this.handoff;
    const changed =
      cameraModeChanged ||
      state.isolated !== this.state.isolated ||
      state.explosion !== this.state.explosion ||
      state.step !== this.state.step ||
      state.journey !== this.state.journey ||
      state.inspecting !== this.state.inspecting;
    this.state = { ...state };
    // Rotation is explicitly requested, never started automatically.
    this.controls.autoRotate =
      state.rotating && !this.reduced.matches && !this.inventory;
    this.dirty = true;
    this.moving ||= changed;
    this.layout(false);
    if (
      cameraModeChanged ||
      wasInventory !== this.inventory ||
      wasTour !== !!this.handoff
    )
      this.configureCamera();
    if (changed) this.resize();
  }

  private layout(immediate: boolean) {
    const handoff = this.handoff;
    const inventory = this.inventory;
    const amount = handoff
      ? Math.min(this.state.explosion / 100, 0.35)
      : this.state.explosion / 100;
    const isolated = this.state.isolated;
    const selectedSystem = this.piece(this.state.selected ?? "")?.system.id;
    const visibleSystems: readonly string[] =
      focusedViews[this.state.lens].systems;
    const resources = this.pieces.filter(
      (piece) =>
        piece.index >= 0 &&
        (!visibleSystems.length || visibleSystems.includes(piece.system.id)),
    );
    const columns = Math.min(
      resources.length,
      Math.max(
        3,
        Math.floor(
          this.host.clientWidth / (window.innerWidth <= 800 ? 108 : 114),
        ),
      ),
    );
    const rows = Math.ceil(resources.length / columns);
    this.board.visible = !isolated && !inventory;
    this.board.scale.set(1 + amount * 0.36, 1, 1 + amount * 0.32);
    for (const piece of this.pieces) {
      const endpoint = piece.id === handoff?.from || piece.id === handoff?.to;
      const participatingSystem =
        piece.system.id === selectedSystem ||
        piece.system.id === this.piece(handoff?.from ?? "")?.system.id ||
        piece.system.id === this.piece(handoff?.to ?? "")?.system.id;
      const selected = piece.id === this.state.selected;
      const visible = this.state.focused
        ? piece.id === this.state.focused
        : (!isolated || isolated === piece.system.id) &&
          (!visibleSystems.length ||
            visibleSystems.includes(piece.system.id)) &&
          (!inventory || piece.index >= 0);
      piece.group.visible = visible;
      const [x, z] = isolated ? [0, 0] : piece.system.position;
      piece.group.rotation.set(inventory ? Math.PI * 0.27 : 0, 0, 0);
      if (this.state.focused) {
        piece.target.set(0, 0, 0);
        piece.group.scale.setScalar(1);
      } else if (inventory && piece.index >= 0) {
        const index = resources.indexOf(piece);
        piece.target.set(
          ((index % columns) - (columns - 1) / 2) * 4.4,
          ((rows - 1) / 2 - Math.floor(index / columns)) * 3.1,
          0,
        );
        piece.group.scale.setScalar(1);
      } else if (piece.index === -1) {
        piece.target.set(
          x * (1 + amount * 0.34),
          -0.02,
          z * (1 + amount * 0.4),
        );
        piece.group.scale.set(1 + amount * 0.35, 1, 1 + amount * 0.3);
        piece.mesh.material.opacity = 1 - amount * 0.65;
        piece.mesh.material.transparent = true;
      } else {
        const localAmount =
          handoff && (endpoint || selected) ? Math.max(amount, 0.65) : amount;
        const spacingX = isolated ? 1.43 + amount * 2.6 : 1.43 + amount * 0.67;
        const spacingZ = isolated ? 1.03 + amount * 1.9 : 1.03 + amount * 0.6;
        const count = piece.system.components.length;
        const columns = count === 3 ? 2 : count > 4 ? 3 : 2;
        const row = Math.floor(piece.index / columns);
        const col = piece.index % columns;
        piece.target.set(
          x * (1 + amount * 0.34) +
            (col - (columns - 1) / 2) *
              spacingX *
              (count > 4 && !isolated ? 0.75 : 1),
          0.39 + localAmount * (isolated ? 1 + row * 0.25 : 0.7 + row * 0.32),
          z * (1 + amount * 0.4) + (row - 0.5) * spacingZ,
        );
        piece.group.scale.setScalar(isolated ? 1 + amount * 0.25 : 1);
      }
      if (immediate || this.reduced.matches)
        piece.group.position.copy(piece.target);
      const inSelection =
        !this.state.selected || piece.system.id === selectedSystem;
      piece.mesh.material.emissiveIntensity =
        selected || endpoint ? 0.48 : inSelection ? 0.09 : 0.01;
      piece.outline.material.opacity = selected ? 1 : inSelection ? 0.66 : 0.2;
      piece.label.classList.toggle("selected", selected);
      piece.label.classList.toggle("handoff-endpoint", endpoint);
      piece.label.classList.toggle(
        "active-system",
        piece.index === -1 && piece.id === selectedSystem,
      );
      piece.label.classList.toggle("hovered", piece.id === this.hovered);
      if (!inventory) piece.label.style.removeProperty("width");
      const systemCue = piece.label.querySelector<HTMLElement>(".label-system");
      if (systemCue) systemCue.hidden = !inventory;
      const showLabel =
        visible &&
        this.state.labels &&
        (this.state.focused === piece.id ||
          (handoff && (endpoint || selected)) ||
          piece.id === this.hovered ||
          (this.state.labels &&
            (piece.index === -1
              ? (!handoff || participatingSystem) &&
                (!isolated || amount < 0.25)
              : inventory || (!!isolated && amount >= 0.25))));
      piece.label.hidden = !showLabel;
    }
    this.host.dataset.view = this.state.focused
      ? "focused"
      : inventory
        ? "inventory"
        : isolated
          ? "isolated"
          : "system";
    this.host.dataset.explosion = String(this.state.explosion);
  }

  private configureCamera() {
    const inventory = this.inventory;
    this.camera.position.set(inventory ? 0 : 12, inventory ? 0 : 23, 38);
    this.camera.zoom = 1;
    this.controls.target.set(
      0,
      this.state.isolated ? 0.6 : 0,
      inventory ? 0 : 0.5,
    );
    this.controls.enableRotate = !inventory;
    this.controls.enablePan = inventory || !!this.state.focused;
    this.controls.minPolarAngle = inventory ? 0 : 0.15;
    this.controls.maxPolarAngle = inventory ? Math.PI : Math.PI * 0.48;
    this.controls.mouseButtons.LEFT = inventory
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = inventory
      ? THREE.TOUCH.PAN
      : THREE.TOUCH.ROTATE;
    this.controls.autoRotate =
      this.state.rotating && !this.reduced.matches && !inventory;
    this.renderer.domElement.setAttribute(
      "aria-label",
      inventory
        ? "Resource inventory. Drag to pan, scroll to zoom. Each named resource opens its explanation."
        : "3D system architecture. Drag to orbit, scroll to zoom. Components are also available in the Systems list.",
    );
    this.controls.update();
  }

  /** Fit the actual asset bounds, including their target transforms during a transition. */
  private fitBounds(aspect: number) {
    const bounds = new THREE.Box3();
    const matrix = new THREE.Matrix4();
    const handoff = this.handoff;
    const participants = new Set(
      [this.state.selected, handoff?.from, handoff?.to].map(
        (id) => this.piece(id ?? "")?.system.id,
      ),
    );
    for (const piece of this.pieces) {
      if (!piece.group.visible) continue;
      if (handoff && !participants.has(piece.system.id)) continue;
      matrix.compose(piece.target, piece.group.quaternion, piece.group.scale);
      bounds.union(piece.bounds.clone().applyMatrix4(matrix));
    }
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    if (this.inventory) center.y -= 0.5; // Leave space below the assets for their names.
    const direction = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, 44);
    this.controls.update();
    this.camera.updateMatrixWorld();
    const cameraBounds = new THREE.Box3();
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z])
          cameraBounds.expandByPoint(
            new THREE.Vector3(x, y, z).applyMatrix4(
              this.camera.matrixWorldInverse,
            ),
          );
    const padding = this.state.focused ? 1.15 : this.inventory ? 1.1 : 1.2;
    const margin = this.state.focused ? 0.25 : 0.75;
    const half =
      Math.max(
        handoff ? 3.3 : this.state.focused ? 0.8 : 1.5,
        Math.max(Math.abs(cameraBounds.min.y), Math.abs(cameraBounds.max.y)) +
          margin,
        (Math.max(Math.abs(cameraBounds.min.x), Math.abs(cameraBounds.max.x)) +
          margin) /
          aspect,
      ) * padding;
    const controlGutter =
      this.inventory && window.innerWidth > 800 ? half * aspect * 0.07 : 0;
    this.camera.left = -half * aspect + controlGutter;
    this.camera.right = half * aspect + controlGutter;
    this.camera.top = half;
    this.camera.bottom = -half;
  }

  private resize() {
    this.dirty = true;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    const aspect = width / height;
    if (this.inventory) this.layout(true);
    if (
      this.state.focused ||
      this.inventory ||
      this.state.isolated ||
      this.handoff ||
      this.state.lens !== "all"
    ) {
      this.fitBounds(aspect);
      if (this.inventory) {
        const cellWidth =
          (4.4 / (this.camera.right - this.camera.left)) * width;
        for (const piece of this.pieces)
          piece.label.style.width = `${Math.max(40, Math.floor(cellWidth - 7))}px`;
      }
      this.camera.updateProjectionMatrix();
      return;
    }
    const amount = this.state.explosion / 100;
    const extent = this.state.isolated ? 6.6 + amount * 1.4 : 11 + amount * 3.8;
    const half = Math.max(extent * 0.51, extent / aspect) * this.zoomFactor;
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

  zoom(factor: number) {
    this.dirty = true;
    this.camera.zoom = THREE.MathUtils.clamp(
      this.camera.zoom * factor,
      0.45,
      3.5,
    );
    this.camera.updateProjectionMatrix();
  }

  reset() {
    this.configureCamera();
    this.resize();
  }

  private bindPointer() {
    const canvas = this.renderer.domElement;
    const down = (event: PointerEvent) => {
      this.pointerCount.add(event.pointerId);
      if (event.button !== 0 || this.pointerCount.size > 1) {
        this.moved = true;
        return;
      }
      this.down = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
      this.moved = false;
    };
    const move = (event: PointerEvent) => {
      if (
        this.down &&
        Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 6
      )
        this.moved = true;
      if (!this.down && event.pointerType !== "touch") {
        const piece = this.pick(event.clientX, event.clientY);
        const hovered = piece
          ? this.state.explosion > 25 || this.state.isolated || this.handoff
            ? piece.id
            : piece.system.id
          : null;
        if (hovered !== this.hovered) {
          this.hovered = hovered;
          canvas.style.cursor = hovered ? "pointer" : "grab";
          this.layout(false);
          this.dirty = true;
        }
      }
    };
    const up = (event: PointerEvent) => {
      this.pointerCount.delete(event.pointerId);
      if (!this.down || this.down.pointerId !== event.pointerId) return;
      const click =
        !this.moved &&
        Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) <=
          6;
      this.down = null;
      if (!click) return;
      const piece = this.pick(event.clientX, event.clientY);
      if (piece) {
        this.onSelect(
          this.state.explosion > 25 || this.state.isolated || this.handoff
            ? piece.id
            : piece.system.id,
        );
      }
    };
    const cancel = (event: PointerEvent) => {
      this.pointerCount.delete(event.pointerId);
      this.down = null;
      this.moved = true;
    };
    const leave = () => {
      if (!this.hovered) return;
      this.hovered = null;
      this.layout(false);
      this.dirty = true;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("pointerleave", leave);
    this.cleanups.push(() => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("pointerleave", leave);
    });
  }

  private pick(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.picking.setFromCamera(this.pointer, this.camera);
    const hit = this.picking.intersectObjects(
      this.pieces
        .filter((piece) => piece.group.visible)
        .flatMap((piece) => piece.pickMeshes),
    )[0];
    return hit ? this.piece(hit.object.userData.id as string) : undefined;
  }

  private drawConnection(
    connection: SceneConnection,
    visible: boolean,
    active: boolean,
    time: number,
  ) {
    const from = this.piece(connection.from);
    const to = this.piece(connection.to);
    visible &&= !!from?.group.visible && !!to?.group.visible;
    connection.line.visible = connection.arrow.visible = visible;
    connection.dot.visible =
      visible && active && this.state.playing && !this.reduced.matches;
    if (!visible || !from || !to) return;
    const a = from.group.position.clone();
    const b = to.group.position.clone();
    const resources = from.index >= 0 || to.index >= 0;
    a.y += resources ? 0.45 : -0.3;
    b.y += resources ? 0.45 : -0.3;
    const rise = resources ? Math.max(a.y, b.y) + 0.6 : -0.3;
    const points = resources
      ? [
          a,
          new THREE.Vector3(a.x, rise, a.z),
          new THREE.Vector3(b.x, rise, b.z),
          b,
        ]
      : [
          a,
          new THREE.Vector3(a.x, rise, (a.z + b.z) / 2),
          new THREE.Vector3(b.x, rise, (a.z + b.z) / 2),
          b,
        ];
    const positions = connection.line.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    points.forEach((point, i) =>
      positions.setXYZ(i, point.x, point.y, point.z),
    );
    positions.needsUpdate = true;
    connection.line.geometry.computeBoundingSphere();
    (connection.line.material as THREE.LineBasicMaterial).opacity = active
      ? 0.95
      : this.state.isolated
        ? 0.55
        : 0.25;
    const direction = b.clone().sub(points[2]!);
    if (direction.lengthSq() < 0.001) direction.copy(b).sub(a);
    direction.normalize();
    connection.arrow.position.copy(b).addScaledVector(direction, -0.12);
    connection.arrow.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction,
    );
    connection.arrow.scale.setScalar(active ? 1.15 : 0.8);
    if (connection.dot.visible) {
      const t = ((time / 2600) % 1) * 3;
      const segment = Math.floor(t);
      connection.dot.position.lerpVectors(
        points[segment]!,
        points[Math.min(segment + 1, 3)]!,
        t - segment,
      );
    }
  }

  private placeLabels(width: number, height: number) {
    const handoff = this.handoff;
    const placed: { x: number; y: number; width: number; height: number }[] =
      [];
    const priority = (piece: Piece) =>
      piece.id === this.state.selected ? 0 : piece.index >= 0 ? 1 : 2;
    const pieces = this.pieces
      .filter((piece) => !piece.label.hidden)
      .sort((a, b) => priority(a) - priority(b));
    for (const piece of pieces) {
      this.position.copy(piece.group.position);
      this.position.y += this.inventory
        ? -1.02
        : piece.index === -1
          ? -0.95
          : 1.5;
      this.position.project(this.camera);
      const projectedX = (this.position.x * 0.5 + 0.5) * width;
      const projectedY = (-this.position.y * 0.5 + 0.5) * height;
      const labelWidth = piece.label.offsetWidth;
      const labelHeight = piece.label.offsetHeight;
      const marginX = Math.min(width / 2, labelWidth / 2 + 4);
      const marginY = labelHeight / 2 + 5;
      let x = THREE.MathUtils.clamp(projectedX, marginX, width - marginX);
      let y =
        this.state.focused || handoff
          ? THREE.MathUtils.clamp(
              projectedY,
              Math.max(handoff ? 44 : 0, marginY),
              height - marginY,
            )
          : projectedY;
      if (handoff) {
        // Give the narrated resources priority; nearby names must not obscure them.
        const offsets = [
          [0, 0],
          [-(labelWidth / 2 + 9), 0],
          [labelWidth / 2 + 9, 0],
          [0, -(labelHeight + 6)],
          [0, labelHeight + 6],
          [-labelWidth - 8, 0],
          [labelWidth + 8, 0],
          [0, -2 * (labelHeight + 6)],
          [0, 2 * (labelHeight + 6)],
        ];
        for (const [offsetX, offsetY] of offsets) {
          const candidateX = THREE.MathUtils.clamp(
            x + offsetX!,
            marginX,
            width - marginX,
          );
          const candidateY = THREE.MathUtils.clamp(
            y + offsetY!,
            Math.max(44, marginY),
            height - marginY,
          );
          const overlaps = placed.some(
            (other) =>
              Math.abs(other.x - candidateX) <
                (other.width + labelWidth) / 2 + 3 &&
              Math.abs(other.y - candidateY) <
                (other.height + labelHeight) / 2 + 3,
          );
          if (!overlaps) {
            x = candidateX;
            y = candidateY;
            break;
          }
        }
      }
      piece.label.style.left = `${x}px`;
      piece.label.style.top = `${y}px`;
      piece.label.style.visibility =
        this.state.focused ||
        handoff ||
        (projectedX > 0 &&
          projectedX < width &&
          projectedY > 12 &&
          projectedY < height - 12)
          ? ""
          : "hidden";
      piece.label.style.zIndex = String(
        Math.round((1 - this.position.z) * 100) + (piece.index >= 0 ? 2 : 0),
      );
      placed.push({ x, y, width: labelWidth, height: labelHeight });
    }
  }

  private animate = (time: number) => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (document.hidden) {
      this.lastTime = time;
      return;
    }
    const dt = Math.min(0.05, (time - this.lastTime) / 1000);
    this.lastTime = time;
    const alpha = this.reduced.matches ? 1 : 1 - Math.exp(-dt * 9);
    this.controls.update();
    if (
      !this.dirty &&
      !this.moving &&
      !this.controls.autoRotate &&
      !(this.state.playing && !this.reduced.matches)
    )
      return;
    this.moving = false;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    for (const piece of this.pieces) {
      if (piece.group.position.distanceToSquared(piece.target) > 0.00001)
        this.moving = true;
      piece.group.position.lerp(piece.target, alpha);
    }
    this.placeLabels(width, height);
    const handoff = this.handoff;
    let visibleConnections = 0;
    for (const connection of this.connections) {
      const from = this.piece(connection.from)!;
      const to = this.piece(connection.to)!;
      const internal =
        from.index >= 0 && to.index >= 0 && from.system.id === to.system.id;
      const systemLink = from.index === -1 && to.index === -1;
      const visible =
        !handoff &&
        !this.inventory &&
        !this.state.focused &&
        (this.state.isolated
          ? internal && from.system.id === this.state.isolated
          : systemLink);
      this.drawConnection(connection, visible, false, time);
      if (connection.line.visible) visibleConnections++;
    }
    if (handoff) {
      this.handoffPath.from = handoff.from;
      this.handoffPath.to = handoff.to;
      const color =
        handoff.kind === "access"
          ? 0xb987a3
          : handoff.kind === "recovery"
            ? 0xe0b977
            : handoff.kind === "data"
              ? 0x7ea8c4
              : 0x78d9bb;
      (this.handoffPath.line.material as THREE.LineBasicMaterial).color.setHex(
        color,
      );
      (this.handoffPath.arrow.material as THREE.MeshBasicMaterial).color.setHex(
        color,
      );
    }
    this.drawConnection(
      this.handoffPath,
      !!handoff && !this.state.focused,
      true,
      time,
    );
    if (this.handoffPath.line.visible && handoff) {
      this.host.dataset.handoff = `${handoff.from}:${handoff.to}`;
      visibleConnections++;
    } else if (
      handoff &&
      (!this.piece(handoff.from) || !this.piece(handoff.to))
    )
      this.host.dataset.handoff = "external";
    else delete this.host.dataset.handoff;
    this.host.dataset.connections = String(visibleConnections);
    this.renderer.render(this.world, this.camera);
    this.dirty = false;
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.dispose();
    this.cleanups.forEach((cleanup) => cleanup());
    this.world.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        materials.forEach((material: THREE.Material) => material.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.pieces.forEach((piece) => piece.label.remove());
  }
}
