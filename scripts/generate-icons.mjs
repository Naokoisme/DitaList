import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = await fs.readFile(path.join(root, "public", "icon.svg"), "utf8");
const browser = await chromium.launch({
  executablePath:
    process.env.DIDA_UI_CHROME ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 256, height: 256 },
    deviceScaleFactor: 1,
  });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
    );
    images.push(await page.locator("svg").screenshot({ omitBackground: true }));
  }
  await fs.writeFile(path.join(root, "public", "icon.png"), images.at(-1));
  // ICO 中保留每个实际像素尺寸，避免托盘和任务栏缩小 256px 位图后模糊。
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index] === 256 ? 0 : sizes[index];
    directory[entry + 1] = directory[entry];
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  await fs.writeFile(
    path.join(root, "public", "icon.ico"),
    Buffer.concat([directory, ...images]),
  );
  console.log("Generated local application icons from public/icon.svg.");
} finally {
  await browser.close();
}
