import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { createResourceAsset, type ResourceKind } from '../../site/architecture/resources.js';
import manifest from '../../site/architecture/resource-manifest.json' with { type: 'json' };

it('gives every registered resource a distinct, finite 3D asset that fits its assembly', () => {
  const signatures = new Set<string>();
  for (const kind of Object.keys(manifest) as ResourceKind[]) {
    const asset = createResourceAsset(kind, '#72edbb');
    const bounds = new THREE.Box3().setFromObject(asset);
    const size = bounds.getSize(new THREE.Vector3());
    expect(size.toArray().every(value => Number.isFinite(value) && value > 0)).toBe(true);
    expect(size.x).toBeLessThanOrEqual(1.3);
    expect(size.y).toBeLessThanOrEqual(1.3);
    expect(size.z).toBeLessThanOrEqual(1.3);
    const signature = createHash('sha256');
    asset.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      signature.update(JSON.stringify({
        positions: Array.from(object.geometry.getAttribute('position').array),
        transform: object.matrix.elements,
      }));
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material: THREE.Material) => material.dispose());
    });
    const value = signature.digest('hex');
    expect(signatures.has(value), `${kind} should have a unique silhouette`).toBe(false);
    signatures.add(value);
  }
  expect(signatures.size).toBe(Object.keys(manifest).length);
});
