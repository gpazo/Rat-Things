import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";

// Evidence anchors are intentionally reviewed content. A source change updates the
// fingerprint; a removed file/anchor fails the build instead of shipping a dead link.
export async function resolveArchitecture(catalogue, root = process.cwd()) {
  const data = structuredClone(catalogue);
  const resourceManifest = JSON.parse(
    await readFile(
      new URL("../site/architecture/resource-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const ids = new Set();
  const sourceFiles = new Map();
  const digest = createHash("sha256");
  let revision;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    revision = "main";
  }
  async function evidence(references, owner) {
    if (!references?.length)
      throw new Error(`Architecture: ${owner} needs source evidence`);
    for (const reference of references) {
      if (
        !/^(src|infra\/modules\/agent-runner|microvm)\/[\w./-]+$/.test(
          reference.file,
        ) ||
        reference.file.includes("..")
      ) {
        throw new Error(`Architecture: invalid source path for ${owner}`);
      }
      if (!reference.anchor?.trim())
        throw new Error(`Architecture: empty evidence anchor for ${owner}`);
      if (!sourceFiles.has(reference.file)) {
        sourceFiles.set(
          reference.file,
          await readFile(resolve(root, reference.file), "utf8"),
        );
      }
      const source = sourceFiles.get(reference.file);
      const offset = source.indexOf(reference.anchor);
      if (offset < 0)
        throw new Error(
          `Architecture: missing anchor ${reference.anchor} in ${reference.file} (${owner})`,
        );
      reference.line = source.slice(0, offset).split("\n").length;
      reference.url = `https://github.com/gpazo/Rat-Things/blob/${revision}/${reference.file}#L${reference.line}`;
    }
  }
  for (const system of data.systems) {
    if (
      !/^#[a-f0-9]{6}$/i.test(system.color) ||
      system.position?.length !== 2 ||
      !system.position.every(Number.isFinite)
    ) {
      throw new Error(
        `Architecture: invalid visual configuration for ${system.id}`,
      );
    }
    if (!system.components?.length)
      throw new Error(`Architecture: ${system.id} has no components`);
    for (const node of [system, ...system.components]) {
      if (!/^[a-z][a-z0-9-]*$/.test(node.id) || ids.has(node.id))
        throw new Error(`Architecture: duplicate or invalid ID ${node.id}`);
      ids.add(node.id);
      if (
        !node.title ||
        !node.subtitle ||
        !node.description ||
        !node.facts?.length
      )
        throw new Error(`Architecture: incomplete content for ${node.id}`);
      if (
        node !== system &&
        !Object.hasOwn(resourceManifest, node.resource ?? "")
      ) {
        throw new Error(
          `Architecture: missing 3D resource asset for ${node.id}`,
        );
      }
      await evidence(node.sources, node.id);
    }
  }
  const systemIds = new Set(data.systems.map((system) => system.id));
  for (const connection of data.connections) {
    if (
      !systemIds.has(connection.from) ||
      !systemIds.has(connection.to) ||
      !connection.label
    ) {
      throw new Error("Architecture: connection must link known systems");
    }
    await evidence(connection.sources, `${connection.from} → ${connection.to}`);
  }
  const journeys = new Set();
  for (const journey of data.journeys) {
    if (!journey.steps.length || journeys.has(journey.id))
      throw new Error("Architecture: invalid journey");
    journeys.add(journey.id);
    for (const step of journey.steps) {
      if (
        !ids.has(step.node) ||
        !step.title ||
        !step.description ||
        ![
          "request",
          "queued",
          "dispatching",
          "running",
          "succeeded",
          "failed",
          "cancelled",
        ].includes(step.state)
      ) {
        throw new Error(`Architecture: invalid step in ${journey.id}`);
      }
    }
  }
  for (const [file, source] of [...sourceFiles].sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    digest.update(file).update("\0").update(source);
  data.provenance = {
    revision,
    fingerprint: digest.digest("hex").slice(0, 12),
    sourceCount: sourceFiles.size,
    componentCount: ids.size - data.systems.length,
  };
  return data;
}

export async function buildArchitecture(output) {
  const catalogue = JSON.parse(
    await readFile("site/architecture/catalogue.json", "utf8"),
  );
  const data = await resolveArchitecture(catalogue);
  await mkdir(join(output, "architecture"), { recursive: true });
  await writeFile(join(output, "architecture/data.json"), JSON.stringify(data));
  await build({
    entryPoints: ["site/architecture/app.ts"],
    outfile: join(output, "architecture/app.js"),
    bundle: true,
    format: "esm",
    target: ["es2022"],
    minify: true,
    legalComments: "linked",
    logLevel: "warning",
  });
  console.log(
    `Architecture: ${data.systems.length} systems, ${data.provenance.componentCount} components, ${data.provenance.sourceCount} verified source files`,
  );
}
