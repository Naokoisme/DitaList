import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Candidate packages exclude optional UI diagnostics and source maps.
process.env.VITE_DITALIST_DRAG_TRACE = '0';
process.env.DITALIST_SOURCE_MAPS = '0';
// Isolation overlays are for local verification; distributable candidates use the checked-in identity.
delete process.env.TAURI_CONFIG;
const run = (exe, args, capture = false) => execFileSync(exe, args, {cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'});
if (run('git', ['status', '--porcelain'], true).trim()) throw new Error('请先记录独立仓库源码提交，再生成可追溯候选。');
const source = run('git', ['rev-parse', 'HEAD'], true).trim();
run('cargo', ['build', '--locked', '--release', '-p', 'ditalist-mcp']);
run('node', ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--no-bundle']);
const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const output = path.join(root, 'release', `${stamp}-${source.slice(0, 12)}`);
const payload = path.join(output, 'DitaList-Rust-Preview');
await fs.mkdir(payload, {recursive: true});
for (const binary of ['DitaListRust.exe', 'ditalist-mcp.exe']) await fs.copyFile(path.join(root, 'target/release', binary), path.join(payload, binary));
await fs.copyFile(path.join(root, 'public/icon.ico'), path.join(payload, 'icon.ico'));
await fs.writeFile(path.join(payload, '使用说明.txt'), '双击 DitaListRust.exe 启动原生悬浮栏，点击今天打开主界面。\r\nCtrl+Alt+Space 打开快速输入；主窗口关闭后保留30秒再释放，托盘退出才结束后台。\r\n预览版数据：%APPDATA%\\DitaListRustPreview\\data。不会读取或迁移日用版数据。\r\nMCP 默认关闭，在设置开启并复制配置；请保留 ditalist-mcp.exe 与主程序同目录。\r\n本候选需要 Windows x64 与 WebView2。缺少运行时请使用 Setup 联网补装。\r\n');
const files = [];
for (const name of (await fs.readdir(payload)).sort()) {
  const bytes = await fs.readFile(path.join(payload, name));
  files.push({path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
}
const build = {product:'DitaList Rust Preview', version:'0.0.0', sourceCommit:source, baseline:'1d51ac981db7ea1db0266a58ea72908dba698b7e', increments:['81f307e192ac58e2a45e70e2c7f65b781cf142dd'], builtAt:new Date().toISOString(), files};
await fs.writeFile(path.join(payload, 'build-info.json'), JSON.stringify(build, null, 2));
const inno = process.env.ISCC || 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe';
run(inno, [`/DPayloadDir=${payload}`, `/O${output}`, path.join(root, 'scripts/installer/DitaListRust.iss')]);
const zip = path.join(output, 'DitaList-Rust-Preview-Portable.zip');
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath ${psQuote(payload)} -DestinationPath ${psQuote(zip)} -CompressionLevel Optimal`]);
const artifacts=[];
for (const name of ['DitaList-Rust-Preview-Portable.zip', 'DitaList-Rust-Preview-Setup.exe']) {
  const bytes=await fs.readFile(path.join(output,name));
  artifacts.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await fs.writeFile(path.join(output,'artifacts.json'),JSON.stringify({sourceCommit:source,builtAt:build.builtAt,artifacts},null,2));
console.log(JSON.stringify({output,sourceCommit:source,artifacts},null,2));
