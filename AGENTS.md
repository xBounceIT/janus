  # Repository Guidelines                                                                                                                                                             
                                                                                                                                                                                      
  ## Project Structure & Module Organization                                                                                                                                          
  - `src/` contains the Vite + TypeScript UI (`main.ts`, `api.ts`, `types.ts`, `styles.css`).                                                                                         
  - `src-tauri/` contains the Tauri backend entrypoint (`src/main.rs`, `src/commands.rs`, `src/state.rs`) and app config.                                                             
  - `src-tauri/crates/` is a Rust workspace with focused crates: `domain`, `storage`, `secrets`, `protocols/ssh`, `protocols/rdp`, and `import_export`.                               
  - `fixtures/` holds sample data used by import/export flows (for example `fixtures/sample-mremoteng.xml`).                                                                          
  - `docs/` includes manual validation steps such as `docs/smoke-test.md`.                                                                                                            
                                                                                                                                                                                      
  ## Build, Test, and Development Commands                                                                                                                                            
  - `npm ci` installs Node dependencies from `package-lock.json`.                                                                                                                     
  - `npm run dev` starts the frontend-only Vite server.                                                                                                                               
  - `npm run tauri dev` launches the desktop app in development mode.                                                                                                                 
  - `npm run build` runs TypeScript checks and builds frontend assets into `dist/`.                                                                                                   
  - `cargo test --manifest-path src-tauri/Cargo.toml --workspace` runs all Rust tests.                                                                                                
  - `cargo fmt --check --manifest-path src-tauri/Cargo.toml` verifies Rust formatting.                                                                                                
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` enforces warning-free Rust code.                                                                 
                                                                                                                                                                                      
  ## Coding Style & Naming Conventions                                                                                                                                                
  - TypeScript uses 2-space indentation and strict compiler settings (`tsconfig.json`).                                                                                               
  - Prefer explicit types for payloads crossing the UI/backend boundary.                                                                                                              
  - Rust follows `rustfmt` defaults; use `snake_case` for functions/modules and `PascalCase` for types.                                                                               
  - Keep names domain-specific and consistent with existing command patterns (for example `ssh_session_open`, `rdp_launch`).                                                          
                                                                                                                                                                                      
  ## Testing Guidelines                                                                                                                                                               
  - Place Rust integration tests in crate-level `tests/` folders (example: `src-tauri/crates/storage/tests/storage_crud.rs`).                                                         
  - Favor behavior-focused tests for storage, secrets, and import/export boundaries.                                                                                                  
  - Re-run smoke checks in `docs/smoke-test.md` when touching end-to-end flows.                                                                                                       
  - Do not open a PR until `cargo test` passes across the workspace.                                                                                                                  
                                                                                                                                                                                      
  ## Commit & Pull Request Guidelines                                                                                                                                                 
  - Current history is minimal (`Initial commit`), so use clear imperative commit subjects.
  - Recommended commit format: `area: short summary` (example: `storage: add node delete guard`).                                                                                     
  - PRs should include purpose, key changes, and test evidence (commands executed and outcomes).                                                                                      
  - Include screenshots/GIFs for UI changes and link related issues.                                                                                                                  
                                                                                                                                                                                      
  ## Security & Configuration Tips                                                                                                                                                    
  - Never commit real credentials, vault passphrases, or machine-specific secrets.                                                                                                    
  - Keep fixtures sanitized and non-sensitive.                                                                                                                                        
  - Verify Windows dependencies (`ssh`, `mstsc.exe`, `cmdkey`) before testing protocol features.