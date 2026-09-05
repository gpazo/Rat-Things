import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveArchitecture } from "../../scripts/build-architecture.mjs";
import catalogue from "../../site/architecture/catalogue.json" with { type: "json" };

describe("architecture explorer evidence", () => {
  it("resolves every component and connection to a real source line", async () => {
    const data = await resolveArchitecture(catalogue);
    const refs = data.systems.flatMap((system) =>
      [system, ...system.components].flatMap((node) => node.sources),
    );
    refs.push(...data.connections.flatMap((connection) => connection.sources));
    for (const ref of refs) {
      const source = await readFile(ref.file, "utf8");
      expect(
        source
          .split("\n")
          .slice(ref.line - 1)
          .join("\n"),
      ).toContain(ref.anchor);
      expect(ref.url).toMatch(new RegExp(`#L${ref.line}$`));
    }
    expect(data.provenance.componentCount).toBe(
      catalogue.systems.reduce(
        (total, system) => total + system.components.length,
        0,
      ),
    );
  });

  it("fails the build when a source anchor disappears", async () => {
    const changed = structuredClone(catalogue);
    changed.systems[0]!.sources[0]!.anchor =
      "export class RemovedIngressService";
    await expect(resolveArchitecture(changed)).rejects.toThrow(
      "missing anchor",
    );
  });

  it("rejects duplicate nodes and dangling walkthroughs", async () => {
    const duplicate = structuredClone(catalogue);
    duplicate.systems[1]!.id = duplicate.systems[0]!.id;
    await expect(resolveArchitecture(duplicate)).rejects.toThrow(
      "duplicate or invalid ID",
    );
    const missing = structuredClone(catalogue);
    missing.journeys[0]!.steps[0]!.node = "removed-api";
    await expect(resolveArchitecture(missing)).rejects.toThrow("invalid step");
  });

  it("rejects source traversal and connections to missing systems", async () => {
    const invalid = structuredClone(catalogue);
    invalid.systems[0]!.sources[0]!.file = "../private.json";
    await expect(resolveArchitecture(invalid)).rejects.toThrow(
      "invalid source path",
    );
    const dangling = structuredClone(catalogue);
    dangling.connections[0]!.to = "removed-system";
    await expect(resolveArchitecture(dangling)).rejects.toThrow(
      "known systems",
    );
  });
});
