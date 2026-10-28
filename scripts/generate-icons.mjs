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
  await page.setContent(
    `<style>html,body{margin:0;width:256px;height:256px;background:transparent}svg{width:256px;height:256px;display:block}</style>${svg}`,
  );
  const png = await page.locator("svg").screenshot({ omitBackground: true });
  await fs.writeFile(path.join(root, "public", "icon.png"), png);
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory.writeUInt16LE(1, 10);
  directory.writeUInt16LE(32, 12);
  directory.writeUInt32LE(png.length, 14);
  directory.writeUInt32LE(22, 18);
  await fs.writeFile(
    path.join(root, "public", "icon.ico"),
    Buffer.concat([directory, png]),
  );
  console.log("Generated local application icons from public/icon.svg.");
} finally {
  await browser.close();
}
