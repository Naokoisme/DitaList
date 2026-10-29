#ifndef PayloadDir
  #error PayloadDir must point to a validated Windows package
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId=Naoko.DitaList
AppName=DitaList
AppVersion={#AppVersion}
AppPublisher=Naoko
AppPublisherURL=https://github.com/Naokoisme/DitaList
AppSupportURL=https://github.com/Naokoisme/DitaList/issues
AppUpdatesURL=https://github.com/Naokoisme/DitaList/releases
DefaultDirName={localappdata}\Programs\DitaList
DefaultGroupName=DitaList
DisableProgramGroupPage=yes
DisableDirPage=no
UsePreviousAppDir=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayIcon={app}\DitaList.exe
SetupIconFile={#PayloadDir}\resources\app\dist\icon.ico
OutputBaseFilename=DitaList-Setup
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
SetupMutex=Naoko.DitaList.Setup
; Closing the main window leaves the tray running. Ask for a normal exit instead.
CloseApplications=no
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimplified.AppRunning=请先在系统托盘中右键 DitaList 图标，选择“退出 DitaList”，再继续。关闭主窗口后程序仍会在托盘运行。
english.AppRunning=Please right-click DitaList in the system tray and choose Quit DitaList before continuing. Closing the main window leaves the app running in the tray.
chinesesimplified.ProcessCheckFailed=无法确认 DitaList 是否已退出。请重试，或重新启动电脑后再运行安装程序。
english.ProcessCheckFailed=Setup could not check whether DitaList has exited. Please retry, or restart Windows before running Setup again.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DitaList"; Filename: "{app}\DitaList.exe"; WorkingDir: "{app}"; AppUserModelID: "Naoko.DitaList"
; The portable app can also update this link. Uninstall removes it only if it still points here.
Name: "{userdesktop}\DitaList"; Filename: "{app}\DitaList.exe"; WorkingDir: "{app}"; AppUserModelID: "Naoko.DitaList"; Tasks: desktopicon; Flags: uninsneveruninstall

[Run]
Filename: "{app}\DitaList.exe"; Description: "{cm:LaunchProgram,DitaList}"; Flags: nowait postinstall skipifsilent

[Code]
function GetCurrentProcessId: Cardinal;
  external 'GetCurrentProcessId@kernel32.dll stdcall';
function ProcessIdToSessionId(ProcessId: Cardinal; var SessionId: Cardinal): Boolean;
  external 'ProcessIdToSessionId@kernel32.dll stdcall';

function RunningAppMessage: String;
var
  Locator, Services, Processes: Variant;
  SessionId: Cardinal;
begin
  Result := '';
  try
    if not ProcessIdToSessionId(GetCurrentProcessId, SessionId) then
      RaiseException('Could not identify the current Windows session');
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery(Format(
      'SELECT ProcessId FROM Win32_Process WHERE Name = ''DitaList.exe'' AND SessionId = %d', [SessionId]));
    if Processes.Count > 0 then
      Result := CustomMessage('AppRunning');
  except
    Log(GetExceptionMessage);
    Result := CustomMessage('ProcessCheckFailed');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := RunningAppMessage;
end;

function InitializeUninstall: Boolean;
var
  Message: String;
begin
  Message := RunningAppMessage;
  Result := Message = '';
  if not Result then
    SuppressibleMsgBox(Message, mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Shell, Shortcut: Variant;
  ShortcutPath: String;
begin
  if CurUninstallStep = usUninstall then begin
    ShortcutPath := ExpandConstant('{userdesktop}\DitaList.lnk');
    if FileExists(ShortcutPath) then begin
      try
        Shell := CreateOleObject('WScript.Shell');
        Shortcut := Shell.CreateShortcut(ShortcutPath);
        if CompareText(Shortcut.TargetPath, ExpandConstant('{app}\DitaList.exe')) = 0 then
          DeleteFile(ShortcutPath);
      except
        Log('Desktop shortcut ownership could not be checked; shortcut retained');
      end;
    end;
  end;
end;
