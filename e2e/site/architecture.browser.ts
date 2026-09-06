import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("#explorer")).toHaveAttribute("data-ready", "true");
  await expect(page.locator('canvas[data-renderer="webgl"]')).toBeVisible();
}

test("renders a real 3D scene with all systems and no failed local assets", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  await ready(page);
  await expect(page.locator(".system-row")).toHaveCount(8);
  await expect(page.locator(".system-label:visible")).toHaveCount(8);
  await page.screenshot({ path: "test-results/site/architecture-desktop.png" });
  expect(errors).toEqual([]);
});

test("inspects, explodes and drills into actual implementation references", async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole("button", { name: "Inspect Execution in 3D", exact: true })
    .click();
  await expect(page.locator("#detail-title")).toHaveText("Execution");
  await page.getByRole("button", { name: "Look inside execution" }).click();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "isolated",
  );
  await expect(
    page.getByRole("slider", { name: "Explode layers" }),
  ).toHaveValue("100");
  await expect(page.locator(".component-label:visible")).toHaveCount(5);
  await page
    .getByRole("button", { name: "Inspect Codex runner in 3D" })
    .click();
  await expect(page.locator("#detail-title")).toHaveText("Codex runner");
  await page
    .locator("#detail-content summary")
    .filter({ hasText: /^Implementation · \d+ sources?$/ })
    .click();
  await expect(
    page
      .locator('#detail-content .source-link[href*="/src/runner/main.ts#"]')
      .first(),
  ).toHaveAttribute(
    "href",
    /github\.com\/gpazo\/Rat-Things\/blob\/[^/]+\/src\/runner\/main\.ts#L\d+/,
  );
  await page.screenshot({
    path: "test-results/site/architecture-execution.png",
  });
  await page.getByRole("button", { name: "Return to full system" }).click();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "system",
  );
});

test("supports mesh picking and does not mistake orbit dragging for selection", async ({
  page,
}) => {
  await ready(page);
  const label = await page
    .getByRole("button", { name: "Inspect Ingress in 3D", exact: true })
    .boundingBox();
  expect(label).not.toBeNull();
  const point = { x: label!.x + label!.width / 2, y: label!.y - 12 };
  await page.mouse.click(point.x, point.y);
  await expect(page.locator("#detail-title")).toHaveText("Ingress");
  await page.locator("#all-systems").click();
  const canvas = (await page.locator("canvas").boundingBox())!;
  await page.mouse.move(
    canvas.x + canvas.width * 0.4,
    canvas.y + canvas.height * 0.4,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width * 0.6,
    canvas.y + canvas.height * 0.5,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(page.locator("#detail-title")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset camera", exact: true }).click();
});

for (const [flow, first] of [
  ["api", "Authenticate the request"],
  ["webhook", "Verify the provider signature"],
  ["thing", "Trigger a published Thing"],
  ["thread", "Accept a threaded input"],
] as const) {
  test(`walks the ${flow} flow from ingress to persisted result delivery`, async ({
    page,
  }) => {
    await ready(page);
    await page
      .getByRole("combobox", { name: "Request entry point" })
      .selectOption(flow);
    await page
      .getByRole("button", { name: "Trace a Run", exact: true })
      .click();
    await expect(page.locator("#step-title")).toHaveText(first);
    await page.getByRole("button", { name: "Pause walkthrough" }).click();
    for (let index = 0; index < 7; index++)
      await page
        .getByRole("button", { name: "Next step", exact: true })
        .click();
    await expect(page.locator("#step-title")).toHaveText("Deliver the result");
    await expect(page.locator("#detail-title")).toHaveText("Result notifier");
    await expect(page.locator("#run-state")).toHaveText("SUCCEEDED");
    await expect(
      page.getByRole("button", { name: "Next step", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Replay walkthrough" }).click();
    await expect(page.locator("#step-title")).toHaveText(first);
  });
}

test("supports keyboard explosion, labels, deep links and browser back", async ({
  page,
}) => {
  await ready(page, "/#node=execution&inside=execution&explode=100");
  await expect(page.locator("#detail-title")).toHaveText("Execution");
  const slider = page.getByRole("slider", { name: "Explode layers" });
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveValue("0");
  await slider.press("End");
  await expect(slider).toHaveValue("100");
  await page.getByRole("checkbox", { name: "Labels", exact: true }).uncheck();
  await expect(page.locator(".scene-label:visible")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Labels", exact: true }).check();
  await page.locator('.child-row[data-select="runner"]').click();
  await expect(page).toHaveURL(/node=runner/);
  await page.goBack();
  await expect(page.locator("#detail-title")).toHaveText("Execution");
  await page.reload();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "isolated",
  );
});

test("serves under the GitHub Pages prefix and keeps overview and docs reachable", async ({
  page,
}) => {
  await ready(page, "/Rat-Things/");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page).toHaveURL(/\/Rat-Things\/overview.html$/);
  await expect(
    page.getByRole("heading", {
      name: "The open-source backend for cloud agents.",
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Explore architecture", exact: true })
    .click();
  await expect(page.locator("#explorer")).toHaveAttribute("data-ready", "true");
  await page.getByRole("link", { name: "Documentation", exact: false }).click();
  await expect(page).toHaveURL(/\/Rat-Things\/docs\/$/);
});

test("remains explorable without WebGL and offers a retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      context: string,
      ...args: unknown[]
    ) {
      if (context.includes("webgl")) return null;
      return Reflect.apply(original, this, [context, ...args]);
    } as typeof original;
  });
  await page.goto("/");
  await expect(
    page.getByText("The 3D view is unavailable in this browser.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.locator('.system-row[data-select="access"]').click();
  await expect(page.locator("#detail-title")).toHaveText("Access boundary");
  await expect(
    page.getByRole("button", { name: "Retry 3D view" }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Find a resource" })
    .fill("conditional writes");
  await page.locator('.search-result[data-select="records"]').click();
  await expect(page.locator("#detail-title")).toHaveText("DynamoDB records");
  await page.getByRole("tab", { name: "How it works", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText(
    "Conditional writes enforce transitions",
  );
  await expect(page.getByRole("tabpanel")).toContainText(
    "When things go wrong",
  );
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(page.locator("#step-title")).toHaveText(
    "Authenticate the request",
  );
});

test("follows one task with a single handoff, resource focus and a return to the same step", async ({
  page,
}) => {
  await ready(page);
  await page.locator('.intro-actions [data-action="start"]').click();
  await expect(page.locator("#step-position")).toHaveText("01 / 08");
  await expect(
    page.getByRole("button", { name: "Continue walkthrough" }),
  ).toBeVisible();
  await expect(page.locator('.component-label[data-node="api"]')).toBeVisible();
  await expect(page.locator("#step-handoff .handoff-route")).toContainText(
    "Control API",
  );

  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(page.locator("#step-position")).toHaveText("02 / 08");
  await expect(page.locator("#step-title")).toHaveText(
    "Accept one durable Run",
  );
  await expect(page.locator("#step-handoff .handoff-route")).toHaveText(
    /Control API\s*→\s*Run service/,
  );
  await expect(page.locator("#step-handoff .handoff-payload")).toContainText(
    /owner|principal|input/i,
  );
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-handoff",
    "api:runs",
  );
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-connections",
    "1",
  );
  await expect(
    page.locator('.component-label[data-node="runs"]'),
  ).toBeVisible();
  const handoff = await page.locator("#step-handoff").innerText();

  await page.locator("#inspect-step").click();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "isolated",
  );
  await expect(page.locator("#scene-host")).not.toHaveAttribute(
    "data-connections",
    "0",
  );
  await page.locator('#detail-content [data-action="focus"]').click();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "focused",
  );
  await expect(page.locator(".component-label:visible")).toHaveCount(1);
  await expect(page).toHaveURL(/focus=runs/);
  await page.locator('#breadcrumb [data-action="parent"]').click();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "isolated",
  );
  await expect(page.locator(".component-label:visible")).toHaveCount(4);
  await page.locator("#resume-step").click();
  await expect(page.locator("#step-position")).toHaveText("02 / 08");
  await expect(page.locator("#step-handoff")).toHaveText(handoff, {
    useInnerText: true,
  });
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-handoff",
    "api:runs",
  );
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-connections",
    "1",
  );
  await expect(
    page.locator('.component-label[data-node="runs"]'),
  ).toBeVisible();
});

test("finds resources by service aliases and preserves a focused durability view", async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole("combobox", { name: "Focused view", exact: true })
    .selectOption("durability");
  await expect(page.locator(".system-label:visible")).toHaveCount(3);
  await expect(
    page.locator('.system-label[data-node="storage"]'),
  ).toBeVisible();
  await expect(
    page.locator('.system-label[data-node="execution"]'),
  ).toBeHidden();
  const search = page.getByRole("searchbox", { name: "Find a resource" });
  await search.fill("conditional writes");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.locator('.search-result[data-select="records"]').click();
  await expect(page.locator("#detail-title")).toHaveText("DynamoDB records");
  await page.getByRole("tab", { name: "How it works", exact: true }).click();
  const explanation = page.getByRole("tabpanel");
  await expect(explanation).toContainText("Receives");
  await expect(explanation).toContainText("Produces");
  await expect(explanation).toContainText(
    "Conditional writes enforce transitions",
  );
  await expect(explanation).toContainText("When things go wrong");
  await page.locator('#detail-content [data-action="focus"]').click();
  await expect(page).toHaveURL(/focus=records/);
  await expect(page).toHaveURL(/view=durability/);
  await page.reload();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "focused",
  );
  await expect(
    page.locator('.component-label[data-node="records"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Focused view", exact: true }),
  ).toHaveValue("durability");
  await expect(
    page.getByRole("tab", { name: "How it works", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(explanation.locator(".detail-description")).toBeVisible();
  await expect(explanation.locator(".resource-contract")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "isolated",
  );
  await expect(page).not.toHaveURL(/[?#&]focus=/);
  await expect(page.locator("#breadcrumb")).toContainText("Durable state");
  await expect(page.locator('#breadcrumb [data-action="full"]')).toBeVisible();
  await expect(page.locator(".component-label:visible")).toHaveCount(3);
  await search.fill("no-such-resource");
  await expect(page.locator("#search-results")).toContainText(
    "No matching resources",
  );
});

test("full explosion gives every resource a readable and clickable inventory label", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await page.locator("#explode-all").click();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "inventory",
  );
  await expect(page.locator(".component-label:visible")).toHaveCount(28);
  await expect(page.locator(".system-label:visible")).toHaveCount(0);
  const labels = await page
    .locator(".component-label:visible")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return {
          name: element.textContent?.trim(),
          clickable: element.contains(hit),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      }),
    );
  for (const [index, label] of labels.entries()) {
    expect(label.name).toBeTruthy();
    expect(label.clickable, `${label.name} is obscured`).toBe(true);
    for (const other of labels.slice(index + 1)) {
      const overlaps =
        label.left < other.right &&
        label.right > other.left &&
        label.top < other.bottom &&
        label.bottom > other.top;
      expect(overlaps, `${label.name} overlaps ${other.name}`).toBe(false);
    }
  }
  await page.locator('.component-label[data-node="runner"]').click();
  await expect(page.locator("#detail-title")).toHaveText("Codex runner");
  await page.screenshot({
    path: "test-results/site/architecture-inventory.png",
  });
});

test("explains recovery of a missed wake-up without inventing another Run", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#journey").selectOption("recovery");
  await page.locator('.intro-actions [data-action="start"]').click();
  await expect(page.locator("#step-description")).toContainText(
    "queue send failed",
  );
  await expect(page.locator("#run-state")).toHaveText("QUEUED");
  await page.locator('#step-track [data-step="2"]').click();
  await expect(page.locator("#step-handoff .handoff-payload")).toContainText(
    "Same Run ID",
  );
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-handoff",
    "reconciler:queue",
  );
  await page.locator('#step-track [data-step="5"]').click();
  await expect(page.locator("#run-state")).toHaveText("SUCCEEDED");
  await expect(page.locator("#step-description")).toContainText(
    "original Run identity",
  );
  await expect(
    page.getByRole("button", { name: "Next step", exact: true }),
  ).toBeDisabled();
});

test("distinguishes a cancellation request from a confirmed cancelled execution", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#journey").selectOption("cancellation");
  await page.locator('.intro-actions [data-action="start"]').click();
  await expect(page.locator("#run-state")).toHaveText("RUNNING");
  await page.locator('#step-track [data-step="2"]').click();
  await expect(page.locator("#run-state")).toHaveText("CANCELLING");
  await page.locator('#step-track [data-step="4"]').click();
  await expect(page.locator("#run-state")).toHaveText("CANCELLING");
  await expect(page.locator("#step-description")).toContainText(
    "unknown observations defer",
  );
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(page.locator("#run-state")).toHaveText("CANCELLED");
  await expect(page.locator("#step-description")).toContainText(
    "terminal or absent",
  );
});

test("keeps a successful result separate from uncertain notification delivery", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#journey").selectOption("delivery-failure");
  await page.locator('.intro-actions [data-action="start"]').click();
  await expect(page.locator("#run-state")).toHaveText("SUCCEEDED");
  await page.locator('#step-track [data-step="3"]').click();
  await expect(page.locator("#step-title")).toHaveText(
    "Receive an ambiguous send error",
  );
  await expect(page.locator("#step-handoff .handoff-payload")).toContainText(
    "outcome uncertain",
  );
  await expect(page.locator("#run-state")).toHaveText("SUCCEEDED");
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(page.locator("#step-description")).toContainText(
    "outcome_unknown",
  );
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-handoff",
    "notifier:fence",
  );
  await expect(page.locator("#run-state")).toHaveText("SUCCEEDED");
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(page.locator("#step-title")).toHaveText(
    "Retrieve the successful Run",
  );
  await expect(page.locator("#step-description")).toContainText(
    "does not require rerunning",
  );
});

test("stops auto rotation when selecting or opening architecture layers", async ({
  page,
}) => {
  await ready(page);
  const rotate = page.getByRole("button", { name: "Auto rotate", exact: true });
  await rotate.click();
  await expect(rotate).toHaveAttribute("aria-pressed", "true");
  await page.locator('.system-row[data-select="execution"]').click();
  await expect(rotate).toHaveAttribute("aria-pressed", "false");
  await rotate.click();
  await page.locator("#explode-all").click();
  await expect(rotate).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Trace a Run", exact: true }).click();
  const position = await page.locator("#step-position").innerText();
  await rotate.click();
  await page.locator('.intro-actions [data-action="concepts"]').click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#play")).toHaveAttribute(
    "aria-label",
    "Continue walkthrough",
  );
  await expect(rotate).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Close field guide" }).click();
  await expect(page.locator("#step-position")).toHaveText(position);
  await expect(
    page.getByRole("button", { name: "Continue walkthrough" }),
  ).toBeVisible();
});

test("stops GPU drawing when a focused resource is idle and redraws after zoom", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const observed = window as unknown as Window & { architectureDraws: number };
    observed.architectureDraws = 0;
    for (const prototype of [
      WebGLRenderingContext.prototype,
      WebGL2RenderingContext.prototype,
    ]) {
      const original = prototype.drawElements;
      prototype.drawElements = function (...args: Parameters<typeof original>) {
        observed.architectureDraws++;
        return Reflect.apply(original, this, args);
      };
    }
  });
  await ready(page, "/#node=runner&inside=execution&focus=runner&explode=100");
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "focused",
  );
  const drawCount = () =>
    page.evaluate(
      () =>
        (window as unknown as Window & { architectureDraws: number }).architectureDraws,
    );
  await expect.poll(drawCount).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const before = await drawCount();
        await page.waitForTimeout(300);
        return (await drawCount()) - before;
      },
      { message: "A settled resource should stop drawing GPU frames" },
    )
    .toBe(0);
  const beforeZoom = await drawCount();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(drawCount).toBeGreaterThan(beforeZoom);
});

test("keeps the active resource name and handoff understandable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await page.locator('.intro-actions [data-action="start"]').click();
  await expect(page.locator('.component-label[data-node="api"]')).toBeVisible();
  await expect(page.locator('.component-label[data-node="api"]')).toContainText(
    "Control API",
  );
  await expect(page.locator("#step-handoff .handoff-route")).toBeVisible();
  await expect(page.locator("#step-handoff .handoff-payload")).toBeVisible();
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(
    page.locator('.component-label[data-node="runs"]'),
  ).toBeVisible();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-handoff",
    "api:runs",
  );
  await expect(page.locator("#step-handoff")).toContainText("Run service");
  const handoff = (await page.locator("#step-handoff").boundingBox())!;
  expect(handoff.x).toBeGreaterThanOrEqual(0);
  expect(handoff.x + handoff.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/site/architecture-mobile-handoff.png",
    fullPage: true,
  });
});

test("handles a failed catalogue load without an endless loading state", async ({
  page,
}) => {
  await page.route("**/architecture/data.json", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Retry loading" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Read the architecture documentation" }),
  ).toBeVisible();
});

test("keeps the complete desktop working surface within a laptop viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await ready(page);
  const bounds = await page
    .locator(".explosion-dock, .journey-panel, .explorer-footer, #system-list")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
      }),
    );
  for (const rect of bounds) {
    expect(rect.bottom).toBeLessThanOrEqual(720);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(1280);
  }
  await page.screenshot({ path: "test-results/site/architecture-laptop.png" });
});

test("supports a mobile component journey without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await page.getByRole("button", { name: "Browse systems" }).click();
  const coveredLabels = await page.evaluate(() => {
    const panel = document.querySelector(".systems-panel")!;
    const bounds = panel.getBoundingClientRect();
    return Array.from(document.querySelectorAll(".scene-label:not([hidden])"))
      .map((label) => {
        const rect = label.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })
      .filter(
        ({ x, y }) =>
          x > bounds.left &&
          x < bounds.right &&
          y > bounds.top &&
          y < bounds.bottom,
      )
      .map(({ x, y }) => panel.contains(document.elementFromPoint(x, y)));
  });
  expect(coveredLabels.length).toBeGreaterThan(0);
  expect(coveredLabels.every(Boolean)).toBe(true);
  await page.locator('.system-row[data-select="execution"]').click();
  await expect(page.locator("#detail-title")).toHaveText("Execution");
  await page.getByRole("button", { name: "Look inside execution" }).click();
  await expect(page.locator("#scene-host")).toHaveAttribute(
    "data-view",
    "isolated",
  );
  await page
    .getByRole("button", { name: "Inspect Codex runner in 3D" })
    .click();
  await expect(page.locator("#detail-title")).toHaveText("Codex runner");
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Assemble", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/site/architecture-mobile.png",
    fullPage: true,
  });
});
