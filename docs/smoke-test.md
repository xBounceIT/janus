# Janus MVP Smoke Test

1. Launch app with a fresh app data directory and verify setup wizard appears before the main UI.
2. Complete setup wizard with a passphrase and confirm the app transitions to the main UI.
3. Restart the app and verify setup wizard is skipped (main UI appears with unlock modal and blurred background).
4. Unlock vault and create one SSH and one RDP connection.
5. Open SSH tab and verify no stray line/character appears at the top; confirm output stream/prompt appears without app-injected startup banner text.
6. Open the same SSH connection again and verify a second independent tab/session is created for the same target.
7. Middle-click an SSH tab and verify the tab closes.
8. Send input in an SSH terminal and confirm backend receives it.
9. Launch RDP node and confirm `mstsc.exe` starts.
10. Import `fixtures/sample-mremoteng.xml` in dry-run and apply modes.
11. Export XML and confirm output file is written.
12. Lock vault and verify a secret-backed action fails with lock error.
