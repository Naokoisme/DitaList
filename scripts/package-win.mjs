import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { rcedit } from "rcedit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { output: { type: "string" } } });
const branch = execFileSync("git", ["branch", "--show-current"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (branch !== "main" || dirty)
  throw new Error("Windows 包必须从干净的本地 main 构建");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const releaseDirectory = path.join(root, "release");
const output = path.resolve(root, values.output || "release/DitaList");
const relativeOutput = path.relative(releaseDirectory, output);
if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput))
  throw new Error("打包目录必须位于项目 release 目录内");
try {
  await fs.access(output);
  throw new Error(
    `交付目录已存在：${output}。先核验并归档上一包，脚本不会覆盖。`,
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await fs.access(path.join(root, "dist", "index.html"));
await fs.mkdir(output, { recursive: true });
const runtime = path.join(root, "node_modules", "electron", "dist");
await fs.cp(runtime, output, {
  recursive: true,
  filter: (source) => path.basename(source) !== "default_app.asar",
});
await fs.rename(
  path.join(output, "electron.exe"),
  path.join(output, "DitaList.exe"),
);
const executable = path.join(output, "DitaList.exe");
const application = path.join(output, "resources", "app");
await fs.mkdir(application, { recursive: true });
await fs.cp(path.join(root, "dist"), path.join(application, "dist"), {
  recursive: true,
});
await fs.cp(path.join(root, "electron"), path.join(application, "electron"), {
  recursive: true,
});
await fs.cp(path.join(root, "mcp"), path.join(application, "mcp"), {
  recursive: true,
});
const runtimeModules = path.join(application, "node_modules");
await fs.mkdir(path.join(runtimeModules, "@modelcontextprotocol"), { recursive: true });
const serverRealDir = await fs.realpath(
  path.join(root, "node_modules", "@modelcontextprotocol", "server"),
);
const zodRealDir = await fs.realpath(path.join(root, "node_modules", "zod"));
let coreRealDir;
try {
  coreRealDir = await fs.realpath(
    path.join(root, "node_modules", "@modelcontextprotocol", "core"),
  );
} catch {
  coreRealDir = await fs.realpath(
    path.join(serverRealDir, "..", "core"),
  );
}
for (const [packageName, sourceDir] of [
  ["@modelcontextprotocol/server", serverRealDir],
  ["@modelcontextprotocol/core", coreRealDir],
  ["zod", zodRealDir],
]) {
  await fs.cp(sourceDir, path.join(runtimeModules, packageName), {
    recursive: true,
    dereference: true,
  });
}
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    await rcedit(executable, {
      "version-string": {
        CompanyName: "Naoko",
        FileDescription: "DitaList",
        InternalName: "DitaList",
        OriginalFilename: "DitaList.exe",
        ProductName: "DitaList",
        ProductVersion: "0.0.0",
        LegalCopyright: "Copyright © 2026 Naoko",
      },
      "file-version": "0.0.0.0",
      "product-version": "0.0.0.0",
      icon: path.join(root, "dist", "icon.ico"),
    });
    break;
  } catch (error) {
    if (attempt === 4) throw error;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
await fs.writeFile(
  path.join(application, "package.json"),
  JSON.stringify(
    {
      name: "dida-local",
      productName: "DitaList",
      version: "0.0.0",
      main: "electron/main.cjs",
    },
    null,
    2,
  ),
  "utf8",
);
const hash = createHash("sha256")
  .update(await fs.readFile(executable))
  .digest("hex");
const info = {
  product: "DitaList",
  sourceSha,
  builtAt: new Date().toISOString(),
  executable: "DitaList.exe",
  executableSha256: hash,
  defaultData: "%APPDATA%\\DidaLocal\\data\\database.json",
  cloud: false,
};
await fs.writeFile(
  path.join(output, "build-info.json"),
  JSON.stringify(info, null, 2),
  "utf8",
);
await fs.writeFile(
  path.join(output, "使用说明.txt"),
  "双击「DitaList.exe」启动。\r\n任务保存在 %APPDATA%\\DidaLocal\\data，退出和重新打开后继续保留。\r\n备份请使用程序设置中的导出功能；导入时合并任务并保留已有内容。\r\n程序无云服务器，不自动在电脑和手机之间同步。\r\n关闭主窗口后程序会留在右下角托盘；需要退出时请使用托盘菜单。\r\n",
  "utf8",
);
const files = [];
async function inventory(directory) {
  for (const item of (
    await fs.readdir(directory, { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) await inventory(target);
    else if (
      item.name !== "build-info.json" &&
      item.name !== "files.sha256.json"
    ) {
      const bytes = await fs.readFile(target);
      files.push({
        path: path.relative(output, target).replaceAll("\\", "/"),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
await inventory(output);
info.payloadSha256 = createHash("sha256")
  .update(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
  .digest("hex");
info.fileCount = files.length;
info.totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
await fs.writeFile(
  path.join(output, "files.sha256.json"),
  JSON.stringify(files, null, 2),
  "utf8",
);
await fs.writeFile(
  path.join(output, "build-info.json"),
  JSON.stringify(info, null, 2),
  "utf8",
);
console.log(JSON.stringify(info, null, 2));
