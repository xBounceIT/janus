# Janus MVP Smoke Test

1. Launch app and initialize vault with passphrase.
2. Unlock vault and create one SSH and one RDP connection.
3. Open SSH tab and verify output stream appears.
4. Send input in terminal and confirm backend receives it.
5. Launch RDP node and confirm `mstsc.exe` starts.
6. Import `fixtures/sample-mremoteng.xml` in dry-run and apply modes.
7. Export XML and confirm output file is written.
8. Lock vault and verify a secret-backed action fails with lock error.
