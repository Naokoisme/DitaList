#ifndef PayloadDir
  #error PayloadDir must point to a validated preview payload
#endif
#ifndef WebViewBootstrapperURL
  #define WebViewBootstrapperURL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
#endif

[Setup]
AppId=Naoko.DitaList.RustPreview
AppName=DitaList Rust Preview
AppVersion=0.0.0
AppPublisher=Naoko
DefaultDirName={localappdata}\Programs\DitaList Rust Preview
DefaultGroupName=DitaList Rust Preview
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
UsePreviousAppDir=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayIcon={app}\DitaListRust.exe
SetupIconFile={#PayloadDir}\icon.ico
OutputBaseFilename=DitaList-Rust-Preview-Setup
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
SetupMutex=Naoko.DitaList.RustPreview.Setup
CloseApplications=no
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\check-webview-signature.ps1"; Flags: dontcopy

[Icons]
Name: "{group}\DitaList Rust Preview"; Filename: "{app}\DitaListRust.exe"; WorkingDir: "{app}"; AppUserModelID: "Naoko.DitaList.RustPreview"
Name: "{userdesktop}\DitaList Rust Preview"; Filename: "{app}\DitaListRust.exe"; WorkingDir: "{app}"; AppUserModelID: "Naoko.DitaList.RustPreview"; Tasks: desktopicon; Flags: uninsneveruninstall

[Run]
Filename: "{app}\DitaListRust.exe"; Parameters: "--main"; Description: "{cm:LaunchProgram,DitaList Rust Preview}"; Flags: nowait postinstall skipifsilent

[Code]
var DownloadPage: TDownloadWizardPage;

function InstalledWebView: Boolean;
var Version: String;
begin
  #ifdef TestMissingWebView
    Result := False;
  #else
    Result := (RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
    if not Result then Result := (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
  #endif
end;

function RunningMessage: String;
var Locator, Services, Processes: Variant;
begin
  Result := '';
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name = ''DitaListRust.exe''');
    if Processes.Count > 0 then Result := '请先从托盘退出 DitaList Rust Preview，再继续安装。关闭主窗口后后台仍在运行。';
  except
    Result := '无法确认预览版是否已退出，请重试。';
  end;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('安装 WebView2', 'DitaList 需要 Microsoft WebView2。正在下载联网安装器…', nil);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; Bootstrapper, SignatureScript: String;
begin
  Result := RunningMessage;
  if Result <> '' then Exit;
  if FileExists(ExpandConstant('{app}\DitaList.exe')) then begin
    Result := '此目录包含日用 DitaList，请为 Rust Preview 选择独立目录。';
    Exit;
  end;
  if InstalledWebView then Exit;
  DownloadPage.Clear;
  DownloadPage.Add('{#WebViewBootstrapperURL}', 'MicrosoftEdgeWebview2Setup.exe', '');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
      Bootstrapper := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
      ExtractTemporaryFile('check-webview-signature.ps1');
      SignatureScript := ExpandConstant('{tmp}\check-webview-signature.ps1');
      if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -File "' + SignatureScript + '" -Path "' + Bootstrapper + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then begin
        Result := '无法验证 WebView2 安装器的 Microsoft 签名。安装尚未开始，请重试或从 Microsoft 官网安装 WebView2。';
        Exit;
      end;
      if not Exec(Bootstrapper, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code) or ((Code <> 0) and (Code <> 3010)) then begin
        Result := 'WebView2 安装失败。请检查网络或先手动安装 Microsoft WebView2，然后重试。';
        Exit;
      end;
      NeedsRestart := Code = 3010;
      if not InstalledWebView then Result := '尚未检测到 WebView2，请安装运行时或重启后再次运行 Setup。';
    except
      Result := 'WebView2 下载失败或已取消，DitaList 尚未安装。请检查网络后重试。' + #13#10 + GetExceptionMessage;
      Log(Result);
    end;
  finally
    DownloadPage.Hide;
  end;
end;

function InitializeUninstall: Boolean;
var Message: String;
begin
  Message := RunningMessage;
  Result := Message = '';
  if not Result then SuppressibleMsgBox(Message, mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Shell, Shortcut: Variant; ShortcutPath: String;
begin
  if CurUninstallStep = usUninstall then begin
    ShortcutPath := ExpandConstant('{userdesktop}\DitaList Rust Preview.lnk');
    if FileExists(ShortcutPath) then begin
      try
        Shell := CreateOleObject('WScript.Shell');
        Shortcut := Shell.CreateShortcut(ShortcutPath);
        if CompareText(Shortcut.TargetPath, ExpandConstant('{app}\DitaListRust.exe')) = 0 then DeleteFile(ShortcutPath);
      except
        Log('Shortcut ownership unknown; retaining shortcut');
      end;
    end;
  end;
end;
