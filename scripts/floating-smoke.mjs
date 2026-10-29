import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createEmptyData, createTask, localDate, addDays } from '../src/core/domain.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report=process.env.DIDA_FLOATING_REPORT_DIR || path.join(root, 'reports', 'floating-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
const executable=process.env.DIDA_UI_ELECTRON_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
const dataDir=path.join(report,'electron-data-'+Date.now());
const dataFile=path.join(dataDir,'database.json');
await fs.mkdir(dataDir,{recursive:true});
const data=createEmptyData();
data.settings.accent='#e13e39';
data.tasks=[
  createTask({title:'今天待办',dueDate:localDate()}),
  createTask({title:'逾期待办',dueDate:addDays(localDate(),-1),time:'09:00',reminder:'at-time'}),
  createTask({title:'明天待办',dueDate:addDays(localDate(),1)}),
  createTask({title:'已完成',dueDate:localDate(),completedAt:new Date().toISOString()}),
  createTask({title:'已删除',dueDate:localDate(),deletedAt:new Date().toISOString()}),
];
await fs.writeFile(dataFile,JSON.stringify(data));
const env={...process.env,DIDA_LOCAL_HEADLESS:'1',DIDA_LOCAL_DATA_DIR:dataDir,DIDA_LOCAL_DESKTOP_DIR:path.join(dataDir,'desktop'),DIDA_LOCAL_MCP_PIPE:'\\\\.\\pipe\\DitaListFloating-'+randomUUID(),DIDA_LOCAL_MCP_PORT:'0'};
delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath:executable,args:process.env.DIDA_UI_ELECTRON_EXE ? [] : [root],env,timeout:60000});
const checks=[];
const errors=[];
const result={executable,dataDir,nativeVisibility:'show/hide/focus/isVisible are stubbed; bounds, preload, IPC, production React and disk saves are real',checks,errors};
try{
  const page=await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(String(error)));
  await page.locator('.app-shell').waitFor();
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
  await app.evaluate(({app,BrowserWindow})=>{
    const stub=w=>{
      w.__testVisible=false;
      w.show=()=>{w.__testVisible=true;w.emit('show');};
      w.showInactive=w.show;
      w.hide=()=>{w.__testVisible=false;w.emit('hide');};
      w.focus=()=>{};
      w.isVisible=()=>w.__testVisible;
    };
    BrowserWindow.getAllWindows().forEach(stub);
    app.on('browser-window-created',(_event,w)=>stub(w));
  });
  await page.locator('.rail-bottom button[aria-label="设置"]').click();
  const toggle=page.getByRole('checkbox',{name:'显示悬浮球',exact:true});
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(),false);
  await toggle.click();
  const floating=app.windows().find(p=>p!==page)||await app.waitForEvent('window',{predicate:p=>p!==page});
  assert.ok(floating);
  floating.setDefaultTimeout(10000);
  floating.on('pageerror',error=>errors.push(String(error)));
  await floating.locator('.floating-orb').waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('label.setting-row')].some(el=>el.textContent.includes('显示悬浮球')&&el.querySelector('input').checked));
  const readState=()=>floating.evaluate(()=>window.didaLocal.getFloatingState());
  let state=await readState();
  assert.equal(state.todayCount,2);
  assert.equal(state.hasReminder,true);
  assert.equal(state.expanded,false);
  const bounds=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('floating.html')).getBounds());
  const initialBounds=await bounds();
  assert.equal(initialBounds.width,68);
  assert.equal(initialBounds.height,68);
  checks.push('settings toggle shows collapsed ball; count excludes completed/deleted/future and includes overdue');
  await floating.locator('.floating-orb').click();
  const input=floating.getByRole('textbox',{name:'快速添加任务'});
  await input.fill('保留这一份草稿');
  await input.press('Escape');
  await toggle.click();
  await page.waitForFunction(()=>[...document.querySelectorAll('label.setting-row')].some(el=>el.textContent.includes('显示悬浮球')&&!el.querySelector('input').checked));
  await toggle.click();
  await page.waitForFunction(()=>[...document.querySelectorAll('label.setting-row')].some(el=>el.textContent.includes('显示悬浮球')&&el.querySelector('input').checked));
  assert.equal(await page.evaluate(()=>window.didaLocal.getFloatingVisible()),true);
  await floating.locator('.floating-orb').click();
  assert.equal(await input.inputValue(),'保留这一份草稿');
  await input.fill('自动延展'.repeat(180));
  await floating.waitForTimeout(300);
  const longBounds=await bounds();
  assert.equal(longBounds.width,580);
  assert.ok(longBounds.height<=320);
  assert.ok(await input.evaluate(el=>el.scrollHeight>el.clientHeight));
  checks.push('hide/show and collapse preserve draft; real window bounds follow long textarea');
  await input.fill('悬浮球保存闭环');
  await input.press('Enter');
  await floating.waitForFunction(()=>document.querySelector('.floating-orb').getAttribute('aria-expanded')==='false');
  const disk=JSON.parse(await fs.readFile(dataFile,'utf8'));
  assert.equal(disk.tasks.filter(t=>t.title==='悬浮球保存闭环').length,1);
  assert.equal((await readState()).todayCount,3);
  assert.equal(await page.evaluate(()=>window.didaLocal.getFloatingVisible()),true);
  assert.equal(await floating.locator('textarea').inputValue(),'');
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html')).__testVisible),false);
  checks.push('save acknowledgement follows real disk write; collapse keeps ball visible and main window hidden');
  await floating.waitForTimeout(300);
  const corner=await app.evaluate(({BrowserWindow,screen})=>{
    const area=screen.getPrimaryDisplay().workArea;
    const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('floating.html'));
    const bounds={x:area.x+20,y:area.y+20,width:68,height:68};w.setBounds(bounds);return bounds;
  });
  await floating.evaluate(()=>window.didaLocal.resizeFloating(68,68));
  await floating.waitForFunction(()=>document.querySelector('main').dataset.anchorX==='left'&&document.querySelector('main').dataset.anchorY==='top');
  await floating.locator('.floating-orb').click();
  await input.fill('贴近屏幕边缘也要保持位置'.repeat(60));
  await floating.waitForTimeout(300);
  const expandedCorner=await bounds();
  assert.equal(expandedCorner.x,corner.x);assert.equal(expandedCorner.y,corner.y);
  await input.press('Escape');
  checks.push('top-left expansion keeps the original window corner');
  await floating.evaluate(()=>window.didaLocal.closeFloating());
  await page.waitForFunction(()=>[...document.querySelectorAll('label.setting-row')].some(el=>el.textContent.includes('显示悬浮球')&&!el.querySelector('input').checked));
  await page.evaluate(()=>window.didaLocal.openFloating());
  await input.waitFor();
  assert.equal((await readState()).expanded,true);
  checks.push('external close updates settings; quick-add IPC opens expanded input');
  await input.fill('记录 #'+ 'a'.repeat(201));
  await input.press('Enter');
  await floating.getByRole('status').filter({hasText:'任务格式无效'}).waitFor();
  await input.press('Escape');
  await floating.locator('.floating-orb').click();
  await floating.getByRole('status').filter({hasText:'任务格式无效'}).waitFor();
  assert.equal(await floating.getByRole('button',{name:'添加任务',exact:true}).isDisabled(),true);
  checks.push('invalid task receives immediate error; collapse preserves its explanation');
  await app.evaluate(({dialog})=>{
    dialog.showMessageBox=async()=>({response:1});
  });
  await fs.rename(dataFile,dataFile+'.before-failure');
  await fs.mkdir(dataFile);
  await input.fill('保存失败保留草稿');
  await input.press('Enter');
  await floating.getByRole('status').filter({hasText:'保存失败'}).waitFor();
  assert.equal(await input.inputValue(),'保存失败保留草稿');
  assert.equal(await floating.getByRole('button',{name:'添加任务',exact:true}).isDisabled(),true);
  assert.equal(JSON.parse(await fs.readFile(dataFile+'.before-failure','utf8')).tasks.some(t=>t.title==='保存失败保留草稿'),false);
  await fs.rmdir(dataFile);
  await fs.rename(dataFile+'.before-failure',dataFile);
  checks.push('failed disk write retains draft, reports error and prevents immediate duplicate retry');
  assert.deepEqual(errors,[]);
  result.initialBounds=initialBounds;
  result.longBounds=longBounds;
  result.status='passed';
}catch(error){result.status='failed';result.error=error.stack||String(error);throw error;}
finally{
  await fs.writeFile(path.join(report,'floating-electron-result.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(report,'floating-electron-'+path.basename(dataDir)+'.json'),JSON.stringify(result,null,2));
  if((await fs.stat(dataFile).catch(()=>null))?.isDirectory()) {
    await fs.rmdir(dataFile);
    await fs.rename(dataFile+'.before-failure',dataFile);
  }
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});
  await app.close();
  console.log(JSON.stringify({status:result.status,checks,dataDir,error:result.error}));
}
