import * as THREE from "three";
import manifest from "./resource-manifest.json" with { type: "json" };

export type ResourceKind = keyof typeof manifest;

/** Small, local 3D diagram assets. Each silhouette describes a resource's role. */
export function createResourceAsset(
  kind: ResourceKind,
  color: string,
): THREE.Group {
  const asset = new THREE.Group();
  asset.name = manifest[kind];
  asset.userData.resource = kind;
  const accent = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.3,
    roughness: 0.4,
    emissive: color,
    emissiveIntensity: 0.05,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: "#142b32",
    metalness: 0.45,
    roughness: 0.33,
  });
  const light = new THREE.MeshStandardMaterial({
    color: "#d7efe6",
    metalness: 0.25,
    roughness: 0.45,
  });
  const glow = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.7,
    roughness: 0.3,
  });
  function shape(
    geometry: THREE.BufferGeometry,
    position: [number, number, number],
    material = accent,
  ) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    asset.add(mesh);
    return mesh;
  }
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material = accent,
  ) => shape(new THREE.BoxGeometry(w, h, d), [x, y, z], material);
  const ball = (
    r: number,
    x: number,
    y: number,
    z: number,
    material = accent,
  ) => shape(new THREE.SphereGeometry(r, 16, 12), [x, y, z], material);
  const cylinder = (
    r: number,
    h: number,
    x: number,
    y: number,
    z: number,
    material = accent,
  ) => shape(new THREE.CylinderGeometry(r, r, h, 24), [x, y, z], material);
  const torus = (
    r: number,
    tube: number,
    x: number,
    y: number,
    z: number,
    material = accent,
    arc = Math.PI * 2,
  ) => shape(new THREE.TorusGeometry(r, tube, 8, 32, arc), [x, y, z], material);
  function link(
    a: [number, number, number],
    b: [number, number, number],
    radius = 0.028,
    material = light,
  ) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      delta = end.clone().sub(start);
    const mesh = shape(
      new THREE.CylinderGeometry(radius, radius, delta.length(), 8),
      [0, 0, 0],
      material,
    );
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      delta.normalize(),
    );
    return mesh;
  }
  function display(x = 0, y = 0.62, width = 1, height = 0.65) {
    box(width, height, 0.12, x, y, 0);
    box(width - 0.12, height - 0.13, 0.025, x, y, 0.078, dark);
  }
  function page(x = 0, y = 0.54, z = 0) {
    box(0.65, 0.85, 0.07, x, y, z, light);
    for (let i = 0; i < 3; i++)
      box(
        i === 2 ? 0.28 : 0.43,
        0.035,
        0.02,
        x - 0.045,
        y + 0.2 - i * 0.15,
        z + 0.049,
        accent,
      );
  }
  switch (kind) {
    case "api":
      box(0.15, 0.88, 0.4, -0.43, 0.55, 0);
      box(0.15, 0.88, 0.4, 0.43, 0.55, 0);
      box(1, 0.16, 0.4, 0, 1.03, 0);
      box(0.44, 0.12, 0.18, 0, 0.54, 0.15, glow);
      shape(
        new THREE.ConeGeometry(0.17, 0.26, 4),
        [0.31, 0.54, 0.15],
        glow,
      ).rotation.z = -Math.PI / 2;
      break;
    case "webhooks":
      ball(0.18, 0, 0.61, 0.08, glow);
      for (const [x, y, z] of [
        [-0.45, 0.3, 0],
        [0.45, 0.3, 0],
        [0, 1, -0.16],
      ] as [number, number, number][]) {
        ball(0.115, x, y, z);
        link([x, y, z], [0, 0.61, 0.08]);
      }
      torus(0.25, 0.025, 0, 0.61, 0.08, light);
      break;
    case "identity":
      box(0.95, 0.65, 0.12, 0, 0.6, 0);
      ball(0.105, -0.23, 0.72, 0.13, light);
      box(0.23, 0.15, 0.06, -0.23, 0.5, 0.11, light);
      for (let i = 0; i < 3; i++)
        box(0.3, 0.04, 0.03, 0.18, 0.74 - i * 0.12, 0.08, dark);
      box(0.32, 0.12, 0.14, 0, 0.98, 0, dark);
      break;
    case "runs":
      page();
      cylinder(0.17, 0.06, 0.29, 0.25, 0.19, accent).rotation.x = Math.PI / 2;
      link([0.2, 0.26, 0.25], [0.27, 0.19, 0.25], 0.024, light);
      link([0.27, 0.19, 0.25], [0.4, 0.34, 0.25], 0.024, light);
      break;
    case "things":
      display(0, 0.61, 0.95, 0.75);
      for (const x of [-0.27, 0.27]) box(0.07, 0.2, 0.13, x, 1.02, 0, light);
      for (const x of [-0.25, 0, 0.25])
        for (const y of [0.42, 0.63]) box(0.13, 0.11, 0.03, x, y, 0.11, light);
      torus(0.18, 0.04, 0.34, 0.32, 0.22, glow);
      link([0.34, 0.32, 0.24], [0.34, 0.44, 0.24], 0.019, light);
      break;
    case "mailbox":
      box(0.92, 0.48, 0.65, 0, 0.4, 0);
      shape(
        new THREE.CylinderGeometry(0.33, 0.33, 0.92, 20, 1, false, 0, Math.PI),
        [0, 0.64, 0],
      ).rotation.z = Math.PI / 2;
      box(0.76, 0.08, 0.035, 0, 0.48, 0.35, dark);
      box(0.045, 0.69, 0.045, 0.48, 0.77, 0, light);
      box(0.24, 0.15, 0.045, 0.39, 1.08, 0, glow);
      break;
    case "queue":
      box(1.04, 0.12, 0.72, 0, 0.17, 0, dark);
      for (let i = 0; i < 3; i++) {
        box(0.73, 0.14, 0.5, 0, 0.32 + i * 0.24, 0);
        box(0.4, 0.028, 0.1, 0, 0.405 + i * 0.24, 0, light);
      }
      break;
    case "dispatcher":
      cylinder(0.24, 0.28, 0, 0.44, 0, dark);
      for (const [x, z] of [
        [-0.44, 0.2],
        [0.44, 0.2],
        [0, -0.38],
      ]) {
        link([0, 0.54, 0], [x!, 0.75, z!], 0.04);
        box(0.2, 0.2, 0.2, x!, 0.75, z!, glow);
      }
      box(0.08, 0.26, 0.08, 0, 0.24, 0.3, light);
      break;
    case "microvm": {
      box(0.92, 0.11, 0.65, 0, 0.2, 0, dark);
      box(0.92, 0.11, 0.65, 0, 1, 0, dark);
      for (const x of [-0.4, 0.4])
        for (const z of [-0.27, 0.27]) box(0.055, 0.8, 0.055, x, 0.6, z, light);
      for (let i = 0; i < 3; i++) {
        box(0.62, 0.14, 0.47, 0, 0.38 + i * 0.21, 0);
        box(0.055, 0.04, 0.028, 0.21, 0.39 + i * 0.21, 0.252, glow);
      }
      break;
    }
    case "runner":
      box(0.78, 0.32, 0.6, 0, 0.38, 0, dark);
      box(0.55, 0.24, 0.4, 0, 0.65, 0);
      for (const x of [-0.41, 0.41])
        for (let i = 0; i < 4; i++)
          box(0.15, 0.055, 0.06, x, 0.37, (i - 1.5) * 0.15, light);
      for (let i = 0; i < 3; i++)
        box(0.06, 0.035, 0.23, (i - 1) * 0.13, 0.79, 0, glow);
      break;
    case "browser":
      display(0, 0.7, 1.05, 0.72);
      box(0.28, 0.14, 0.25, 0, 0.24, 0, dark);
      box(0.65, 0.065, 0.4, 0, 0.16, 0);
      box(0.86, 0.075, 0.025, 0, 0.93, 0.101, light);
      for (let i = 0; i < 3; i++)
        ball(0.025, -0.32 + i * 0.09, 0.93, 0.125, dark);
      box(0.32, 0.28, 0.025, -0.2, 0.66, 0.102);
      box(0.31, 0.06, 0.025, 0.21, 0.74, 0.102, light);
      box(0.31, 0.06, 0.025, 0.21, 0.6, 0.102, light);
      break;
    case "models":
      ball(0.22, 0, 0.62, 0, glow);
      torus(0.41, 0.023, 0, 0.62, 0, light);
      torus(0.41, 0.023, 0, 0.62, 0, light).rotation.y = Math.PI / 2;
      for (const [x, y, z] of [
        [-0.4, 0.62, 0],
        [0.4, 0.62, 0],
        [0, 1.03, 0],
        [0, 0.62, 0.4],
      ] as [number, number, number][])
        ball(0.072, x, y, z);
      break;
    case "events":
      shape(new THREE.OctahedronGeometry(0.23), [0, 0.65, 0], glow);
      for (const [x, y, z] of [
        [-0.42, 0.4, 0],
        [0.42, 0.4, 0],
        [0, 0.95, -0.25],
        [0, 0.35, 0.35],
      ] as [number, number, number][]) {
        link([0, 0.65, 0], [x, y, z], 0.025);
        shape(new THREE.OctahedronGeometry(0.12), [x, y, z]);
      }
      break;
    case "notifier":
      box(1, 0.6, 0.22, 0, 0.6, 0, light);
      link([-0.46, 0.84, 0.14], [0, 0.54, 0.14], 0.022, accent);
      link([0, 0.54, 0.14], [0.46, 0.84, 0.14], 0.022, accent);
      link([-0.46, 0.34, 0.14], [-0.1, 0.61, 0.14], 0.018, accent);
      link([0.46, 0.34, 0.14], [0.1, 0.61, 0.14], 0.018, accent);
      break;
    case "fence":
      for (const x of [-0.43, 0, 0.43])
        box(0.08, 0.83, 0.11, x, 0.58, 0, light);
      box(1.05, 0.1, 0.13, 0, 0.82, 0);
      box(1.05, 0.1, 0.13, 0, 0.39, 0);
      cylinder(0.15, 0.15, 0, 0.58, 0.13, dark).rotation.x = Math.PI / 2;
      ball(0.05, 0, 0.6, 0.24, glow);
      break;
    case "publications":
      page(0, 0.56, -0.08);
      box(0.95, 0.14, 0.65, 0, 0.17, 0, dark);
      link([0.22, 0.57, 0.1], [0.52, 0.91, 0.1], 0.04, accent);
      box(0.3, 0.065, 0.065, 0.38, 0.91, 0.1);
      box(0.065, 0.3, 0.065, 0.5, 0.79, 0.1);
      break;
    case "records":
      for (let i = 0; i < 3; i++) {
        cylinder(0.38, 0.22, 0, 0.29 + i * 0.27, 0);
        cylinder(0.39, 0.03, 0, 0.41 + i * 0.27, 0, light);
      }
      break;
    case "artifacts":
      shape(
        new THREE.CylinderGeometry(0.43, 0.31, 0.74, 24, 1, true),
        [0, 0.56, 0],
      );
      cylinder(0.31, 0.06, 0, 0.2, 0, dark);
      torus(0.43, 0.04, 0, 0.94, 0, light).rotation.x = Math.PI / 2;
      box(0.2, 0.18, 0.025, 0, 0.57, 0.37, light);
      break;
    case "files":
      box(1, 0.62, 0.15, 0, 0.55, -0.17);
      box(0.4, 0.17, 0.15, -0.27, 0.91, -0.17);
      box(0.92, 0.48, 0.07, 0, 0.64, -0.04, light);
      const front = box(1, 0.52, 0.12, 0, 0.48, 0.19);
      front.rotation.x = -0.22;
      break;
    case "profiles":
      for (let i = 0; i < 3; i++) {
        box(0.81, 0.055, 0.55, (i - 1) * 0.065, 0.26 + i * 0.24, 0);
        for (let j = 0; j < 2; j++)
          box(
            0.43,
            0.02,
            0.04,
            -0.02,
            0.296 + i * 0.24,
            (j - 0.5) * 0.16,
            light,
          );
      }
      break;
    case "policy": {
      const contour = new THREE.Shape();
      contour.moveTo(-0.42, 0.94);
      contour.lineTo(0, 1.08);
      contour.lineTo(0.42, 0.94);
      contour.lineTo(0.34, 0.46);
      contour.lineTo(0, 0.19);
      contour.lineTo(-0.34, 0.46);
      contour.closePath();
      shape(
        new THREE.ExtrudeGeometry(contour, {
          depth: 0.14,
          bevelEnabled: false,
        }),
        [0, 0, -0.08],
      );
      link([-0.17, 0.66, 0.11], [-0.02, 0.5, 0.11], 0.04, light);
      link([-0.02, 0.5, 0.11], [0.22, 0.82, 0.11], 0.04, light);
      break;
    }
    case "secrets":
      box(0.8, 0.8, 0.59, 0, 0.59, 0, dark);
      box(0.63, 0.65, 0.05, 0, 0.59, 0.326);
      torus(0.17, 0.032, 0, 0.59, 0.365, light);
      cylinder(0.055, 0.09, 0, 0.59, 0.385, light).rotation.x = Math.PI / 2;
      for (const angle of [0, Math.PI / 2]) {
        const spoke = box(0.31, 0.032, 0.025, 0, 0.59, 0.42, light);
        spoke.rotation.z = angle;
      }
      for (const y of [0.4, 0.79]) box(0.06, 0.11, 0.08, -0.35, y, 0.34, light);
      break;
    case "plugins":
      box(0.66, 0.45, 0.42, 0, 0.48, 0);
      box(0.22, 0.32, 0.18, -0.18, 0.88, 0, light);
      box(0.22, 0.32, 0.18, 0.18, 0.88, 0, light);
      cylinder(0.055, 0.27, 0, 0.2, 0, dark);
      torus(0.16, 0.045, 0.16, 0.2, 0, dark, Math.PI).rotation.z = Math.PI;
      break;
    case "grants":
      torus(0.24, 0.075, -0.22, 0.77, 0.04);
      link([-0.04, 0.59, 0.04], [0.42, 0.22, 0.04], 0.07);
      link([0.19, 0.4, 0.04], [0.34, 0.56, 0.04], 0.05, light);
      link([0.34, 0.28, 0.04], [0.49, 0.44, 0.04], 0.05, light);
      break;
    case "oauth":
      torus(0.35, 0.065, 0, 0.63, 0, accent, Math.PI * 1.55);
      torus(0.2, 0.04, 0, 0.63, 0.1, light, Math.PI * 1.5).rotation.z = Math.PI;
      shape(
        new THREE.ConeGeometry(0.13, 0.23, 3),
        [0.34, 0.66, 0.03],
        light,
      ).rotation.z = Math.PI;
      break;
    case "state":
      for (const [x, y] of [
        [-0.4, 0.35],
        [0, 0.72],
        [0.4, 0.35],
      ])
        cylinder(0.15, 0.11, x!, y!, 0).rotation.x = Math.PI / 2;
      link([-0.3, 0.43, 0], [-0.1, 0.64, 0], 0.025, light);
      link([0.1, 0.64, 0], [0.3, 0.43, 0], 0.025, light);
      torus(0.2, 0.025, 0, 0.72, 0.1, light);
      break;
    case "reconciler":
      torus(0.37, 0.07, 0, 0.65, 0, accent, Math.PI * 1.72);
      shape(
        new THREE.ConeGeometry(0.16, 0.24, 3),
        [0.37, 0.67, 0],
        light,
      ).rotation.z = Math.PI;
      box(0.25, 0.25, 0.25, 0, 0.65, 0, dark);
      break;
    case "heartbeat":
      display(0, 0.65, 1.04, 0.67);
      const pulse: [number, number, number][] = [
        [-0.43, 0.63, 0.105],
        [-0.22, 0.63, 0.105],
        [-0.1, 0.84, 0.105],
        [0.04, 0.4, 0.105],
        [0.18, 0.7, 0.105],
        [0.28, 0.63, 0.105],
        [0.43, 0.63, 0.105],
      ];
      for (let i = 0; i < pulse.length - 1; i++)
        link(pulse[i]!, pulse[i + 1]!, 0.019, glow);
      box(0.64, 0.06, 0.4, 0, 0.18, 0, dark);
      break;
    default: {
      const invalid: never = kind;
      throw new Error(`Missing 3D resource asset: ${invalid}`);
    }
  }
  // Keep the generated name useful in scene inspectors and exported debug captures.
  asset.traverse((object) => {
    if (object instanceof THREE.Mesh)
      object.name = `${kind}:${object.geometry.type}`;
  });
  return asset;
}
