import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { label: { type: "string" } } });
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const label = values.label || pkg.version;
if (process.platform !== "win32") throw new Error("Setup 需要在 Windows 上构建");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(label))
  throw new Error("发布标签必须是版本号，如 0.0.0-beta.6");
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (branch !== "main" || dirty) throw new Error("Setup 必须从干净的本地 main 构建");

const candidates = [
  process.env.INNO_SETUP_COMPILER,
  ...["ProgramFiles", "ProgramFiles(x86)"].flatMap((variable) =>
    process.env[variable]
      ? ["Inno Setup 7", "Inno Setup 6"].map((directory) => path.join(process.env[variable], directory, "ISCC.exe"))
      : [],
  ),
].filter(Boolean);
let compiler;
for (const candidate of candidates) {
  if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) {
    compiler = candidate;
    break;
  }
}
if (!compiler) throw new Error("请安装 Inno Setup 6.5+，或设置 INNO_SETUP_COMPILER 为 ISCC.exe 的完整路径");

const releaseDirectory = path.join(root, "release");
const name = `DitaList-${label}-windows-x64-Setup`;
const installer = path.join(releaseDirectory, `${name}.exe`);
await fs.mkdir(releaseDirectory, { recursive: true });
if (await fs.stat(installer).then(() => true, () => false))
  throw new Error(`安装包已存在，先归档再构建：${installer}`);
const staging = await fs.mkdtemp(path.join(releaseDirectory, ".setup-"));
const payload = path.join(staging, "payload");
let succeeded = false;
try {
  execFileSync(process.execPath, [path.join(root, "scripts/package-win.mjs"), "--output", payload], { cwd: root, stdio: "inherit" });
  const info = JSON.parse(await fs.readFile(path.join(payload, "build-info.json"), "utf8"));
  execFileSync(compiler, [
    "/Qp", `/DPayloadDir=${payload}`, `/DAppVersion=${pkg.version}`,
    `/O${releaseDirectory}`, `/F${name}`,
    path.join(root, "scripts/installer/DitaList.iss"),
  ], { cwd: root, stdio: "inherit" });
  const bytes = await fs.readFile(installer);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(`${installer}.sha256`, `${sha256}  ${path.basename(installer)}\n`, "ascii");
  const receipt = {
    ...info,
    releaseLabel: label,
    installer: path.basename(installer),
    installerBytes: bytes.length,
    installerSha256: sha256,
    compilerSha256: createHash("sha256").update(await fs.readFile(compiler)).digest("hex"),
    uninstallDataPolicy: "preserve",
  };
  await fs.writeFile(`${installer}.build-info.json`, JSON.stringify(receipt, null, 2), "utf8");
  succeeded = true;
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (succeeded) {
    // Only this invocation's newly created staging tree is disposable.
    const actual = await fs.realpath(staging);
    const parent = await fs.realpath(releaseDirectory);
    if (path.dirname(actual) !== parent || !path.basename(actual).startsWith(".setup-"))
      throw new Error(`临时目录路径异常，已保留：${staging}`);
    await fs.rm(actual, { recursive: true });
  } else {
    console.error(`构建未完成，诊断目录保留在 ${staging}`);
  }
}
