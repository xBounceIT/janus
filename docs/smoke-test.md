# Janus MVP Smoke Test

1. Launch app with a fresh app data directory and verify setup wizard appears before the main UI.
2. Complete setup wizard with a passphrase and confirm the app transitions to the main UI.
3. Restart the app and verify setup wizard is skipped (main UI appears with unlock modal and blurred background).
4. Unlock vault and create one SSH and one RDP connection.
5. Open SSH tab and verify no stray line/character appears at the top; confirm output stream/prompt appears without app-injected startup banner text.
6. Open the same SSH connection again and verify a second independent tab/session is created for the same target.
7. Middle-click an SSH tab and verify the tab closes.
8. Send input in an SSH terminal and confirm backend receives it.
9. In a connected SSH tab, click the SFTP button beside the tab close button and verify the SFTP modal opens.
10. Right-click the same SSH tab and verify `Open SFTP` appears in the tab context menu (disabled when the tab is not connected).
11. In the SFTP modal, verify the left pane (`My PC`) loads the local home directory and the right pane loads the remote directory.
12. Verify double-click navigates into folders in both panes and `Up` navigates to the parent folder.
13. Create, rename, and delete a test file/folder in the local pane.
14. Create, rename, and delete a test file/folder in the remote pane.
15. Upload a local test file to the remote pane and confirm it appears after refresh.
16. Download a remote test file to the local pane and confirm it appears after refresh.
17. Close the SSH tab while the SFTP modal is open and verify the modal closes cleanly.
18. Launch RDP node and confirm an embedded RDP session appears in the tab workspace.
19. Import `fixtures/sample-mremoteng.xml` in dry-run and apply modes.
20. Export XML and confirm output file is written.
21. Lock vault and verify a secret-backed action fails with lock error.
