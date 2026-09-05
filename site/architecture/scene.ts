import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Architecture, System, ViewState } from "./types.js";
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
};

/** The catalogue owns meaning; this class owns geometry, picking and camera life. */
export class ArchitectureScene {
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-12, 12, 10, -10, 0.1, 150);
  private controls: OrbitControls;
  private pieces: Piece[] = [];
  private connections: {
    from: string;
    to: string;
    line: THREE.Line;
    dot: THREE.Mesh;
  }[] = [];
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
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  private position = new THREE.Vector3();
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
      const color =
        connection.kind === "request"
          ? 0x78d9bb
          : connection.kind === "access"
            ? 0xb987a3
            : 0x536970;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(),
          new THREE.Vector3(),
          new THREE.Vector3(),
        ]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 }),
      );
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xb1ffdf }),
      );
      this.world.add(line, dot);
      this.connections.push({
        from: connection.from,
        to: connection.to,
        line,
        dot,
      });
    }
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
      this.dirty = true;
    });
    this.controls.target.set(0, this.state.isolated ? 0.6 : 0, 0.5);
    this.controls.update();
    this.bindPointer();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.layout(true);
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
    label.innerHTML = `<span class="label-dot"></span><span class="label-title">${title}</span>${parent ? `<span class="label-index">${String(this.catalogue.systems.indexOf(system) + 1).padStart(2, "0")}</span>` : ""}`;
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
    });
  }

  update(state: ViewState) {
    const changed =
      state.isolated !== this.state.isolated ||
      state.explosion !== this.state.explosion;
    this.state = { ...state };
    // Rotation is explicitly requested, never started automatically.
    this.controls.autoRotate = state.rotating;
    this.dirty = true;
    this.moving = changed;
    this.layout(false);
    if (changed) this.resize();
  }

  private layout(immediate: boolean) {
    const amount = this.state.explosion / 100;
    const isolated = this.state.isolated;
    const selectedSystem = this.pieces.find(
      (piece) => piece.id === this.state.selected,
    )?.system.id;
    this.board.visible = !isolated;
    this.board.scale.set(1 + amount * 0.36, 1, 1 + amount * 0.32);
    for (const piece of this.pieces) {
      const visible = !isolated || isolated === piece.system.id;
      piece.group.visible = visible;
      const [x, z] = isolated ? [0, 0] : piece.system.position;
      if (piece.index === -1) {
        piece.target.set(
          x * (1 + amount * 0.34),
          -0.02,
          z * (1 + amount * 0.4),
        );
        piece.group.scale.set(1 + amount * 0.35, 1, 1 + amount * 0.3);
        piece.mesh.material.opacity = 1 - amount * 0.65;
        piece.mesh.material.transparent = true;
      } else {
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
          0.39 + amount * (isolated ? 1 + row * 0.25 : 0.7 + row * 0.32),
          z * (1 + amount * 0.4) + (row - 0.5) * spacingZ,
        );
        piece.group.scale.setScalar(isolated ? 1 + amount * 0.25 : 1);
      }
      if (immediate || this.reduced.matches)
        piece.group.position.copy(piece.target);
      const selected = piece.id === this.state.selected;
      const inSelection =
        !this.state.selected || piece.system.id === selectedSystem;
      piece.mesh.material.emissiveIntensity = selected
        ? 0.48
        : inSelection
          ? 0.09
          : 0.01;
      piece.outline.material.opacity = selected ? 1 : inSelection ? 0.66 : 0.2;
      piece.label.classList.toggle("selected", selected);
      const showLabel =
        this.state.labels &&
        visible &&
        (piece.index === -1
          ? !isolated || amount < 0.25
          : !!isolated && amount >= 0.25);
      piece.label.hidden = !showLabel;
    }
    this.host.dataset.view = isolated ? "isolated" : "system";
    this.host.dataset.explosion = String(this.state.explosion);
  }

  private resize() {
    this.dirty = true;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    const aspect = width / height;
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
    this.camera.position.set(12, 23, 38);
    this.camera.zoom = 1;
    this.controls.target.set(0, this.state.isolated ? 0.6 : 0, 0.5);
    this.controls.update();
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
      const rect = canvas.getBoundingClientRect();
      this.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.picking.setFromCamera(this.pointer, this.camera);
      const hits = this.picking.intersectObjects(
        this.pieces
          .filter((piece) => piece.group.visible)
          .flatMap((piece) => piece.pickMeshes),
      );
      if (hits[0]) {
        const piece = this.pieces.find(
          (candidate) => candidate.id === hits[0]!.object.userData.id,
        )!;
        this.onSelect(
          this.state.explosion > 25 || this.state.isolated
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
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    this.cleanups.push(() => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
    });
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
      !this.state.rotating &&
      !this.state.playing
    )
      return;
    this.moving = false;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    for (const piece of this.pieces) {
      if (piece.group.position.distanceToSquared(piece.target) > 0.00001)
        this.moving = true;
      piece.group.position.lerp(piece.target, alpha);
      if (!piece.label.hidden) {
        this.position.copy(piece.group.position);
        this.position.y += piece.index === -1 ? -0.95 : 1.5;
        this.position.project(this.camera);
        const x = (this.position.x * 0.5 + 0.5) * width;
        const y = (-this.position.y * 0.5 + 0.5) * height;
        piece.label.style.left = `${x}px`;
        piece.label.style.top = `${y}px`;
        piece.label.style.visibility =
          x > 25 && x < width - 25 && y > 20 && y < height - 20 ? "" : "hidden";
        piece.label.style.zIndex = String(
          Math.round((1 - this.position.z) * 100),
        );
      }
    }
    const selectedSystem = this.pieces.find(
      (piece) => piece.id === this.state.selected,
    )?.system.id;
    for (let index = 0; index < this.connections.length; index++) {
      const connection = this.connections[index]!;
      connection.line.visible = !this.state.isolated;
      const a = this.pieces.find((piece) => piece.id === connection.from)!.group
        .position;
      const b = this.pieces.find((piece) => piece.id === connection.to)!.group
        .position;
      const active =
        selectedSystem === connection.from || selectedSystem === connection.to;
      (connection.line.material as THREE.LineBasicMaterial).opacity = active
        ? 0.8
        : 0.24;
      const points = [
        new THREE.Vector3(a.x, -0.3, a.z),
        new THREE.Vector3(a.x, -0.3, (a.z + b.z) / 2),
        new THREE.Vector3(b.x, -0.3, (a.z + b.z) / 2),
        new THREE.Vector3(b.x, -0.3, b.z),
      ];
      const positions = connection.line.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      points.forEach((point, i) =>
        positions.setXYZ(i, point.x, point.y, point.z),
      );
      positions.needsUpdate = true;
      connection.line.geometry.computeBoundingSphere();
      connection.dot.visible =
        !this.state.isolated &&
        this.state.playing &&
        active &&
        !this.reduced.matches;
      if (connection.dot.visible) {
        const t = ((time / 2300 + index * 0.13) % 1) * 3;
        const segment = Math.floor(t);
        connection.dot.position.lerpVectors(
          points[segment]!,
          points[Math.min(segment + 1, 3)]!,
          t - segment,
        );
      }
    }
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
