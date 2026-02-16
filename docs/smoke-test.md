# Janus MVP Smoke Test

1. Launch app with a fresh app data directory and verify setup wizard appears before the main UI.
2. Complete setup wizard with a passphrase and confirm the app transitions to the main UI.
3. Restart the app and verify setup wizard is skipped (main UI opens directly).
4. Unlock vault and create one SSH and one RDP connection.
5. Open SSH tab and verify output stream appears.
6. Send input in terminal and confirm backend receives it.
7. Launch RDP node and confirm `mstsc.exe` starts.
8. Import `fixtures/sample-mremoteng.xml` in dry-run and apply modes.
9. Export XML and confirm output file is written.
10. Lock vault and verify a secret-backed action fails with lock error.
