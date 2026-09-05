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
  await page.getByText("Implementation · 3 sources", { exact: true }).click();
  await expect(page.locator(".source-link").first()).toHaveAttribute(
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
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(page.locator("#step-title")).toHaveText(
    "Authenticate the request",
  );
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
