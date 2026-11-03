import { expect, test } from "playwright/test";

test("FiGrid draws every grid line (tile edges used to drop every 4th row/column line)", async ({ page }) => {
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  await page.waitForTimeout(300);
  const gaps = await page.evaluate(() => {
    const canvas = document.querySelector("#grid canvas, canvas#grid") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const scan = (horizontal: boolean) => {
      const len = horizontal ? canvas.height : canvas.width;
      const at = Math.round((horizontal ? 260 : 300) * dpr); // inside the body, away from headers
      const hits: number[] = [];
      for (let i = Math.round(60 * dpr); i < len - 10; i++) {
        const [r, g, b] = horizontal ? ctx.getImageData(at, i, 1, 1).data : ctx.getImageData(i, at, 1, 1).data;
        if (r! < 240 && g! < 240 && b! < 240 && (!hits.length || i - hits.at(-1)! > 3)) hits.push(i);
      }
      const d = hits.slice(1).map((v, k) => v - hits[k]!);
      return { n: hits.length, min: Math.min(...d), max: Math.max(...d) };
    };
    return { rows: scan(true), cols: scan(false) };
  });
  console.log(JSON.stringify(gaps));
  expect(gaps.rows.n).toBeGreaterThan(10);
  expect(gaps.rows.max).toBeLessThan(gaps.rows.min * 1.5);
  expect(gaps.cols.max).toBeLessThan(gaps.cols.min * 1.5);
});
