# RDP Crash Debug (Windows LocalDumps)

Use this when `janus.exe` exits with a native exception (for example `0xc000041d`) during embedded RDP startup.

## 1. Enable LocalDumps for `janus.exe`

Run PowerShell as Administrator:

```powershell
New-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\janus.exe" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\janus.exe" -Name DumpFolder -PropertyType ExpandString -Value "%LOCALAPPDATA%\CrashDumps" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\janus.exe" -Name DumpType -PropertyType DWord -Value 2 -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\janus.exe" -Name DumpCount -PropertyType DWord -Value 10 -Force | Out-Null
```

`DumpType=2` captures full memory dumps.

## 2. Reproduce Once

1. Start the app in dev mode.
2. Trigger the RDP session open flow.
3. Wait for the crash.

Expected dump location:

`%LOCALAPPDATA%\CrashDumps\janus.exe.*.dmp`

## 3. Analyze in WinDbg

Open the dump in WinDbg and run:

```text
!analyze -v
.ecxr
k
lmv m mstscax
```

Capture:

1. Exception code and failing instruction/module
2. Top frames around callback/activation path
3. Whether failure occurs in `SetClientSite`, `DoVerb`, or event/callback dispatch

## 4. Correlate with Janus Logs

Match dump timestamp with backend stage logs in `janus_protocol_rdp::sta_thread`:

1. `create_host_window`
2. `co_create_activex`
3. `set_client_site`
4. `do_verb_inplace_activate`
5. `configure_properties`
6. `connect_event_sink`
7. `connect_call`

If stage logging stops before completion, that stage is the primary suspect.
