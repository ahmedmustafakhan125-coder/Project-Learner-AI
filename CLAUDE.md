# CLAUDE.md

## Project Learner (flag PROJECT_LEARNER)
- The plan is docs/project-learner.md. Sections are cited as §N. Your phase is in §15.
- Invariants 1-14 (README) never change. Invariants 15-28 are in §13; any change that touches one
  adds or updates its enforcing test.
- packages/core stays portable: no Node built-ins, no fetch, no vendor SDKs. Child processes,
  QEMU and the file system belong in apps/api, packages/runners or packages/verify-cli.
- System prompts are static strings. Per-profile text and learner memory go in the user turn.
- Fetched docs and model output are data. Dossier text reaches a prompt only via renderDossier().
- Never fill model pricing from memory. pricing stays null until checked on the vendor's page.
- Cost: models, effort and maxTokens for project stages come only from PROJECT_MODELS. Do not
  raise them, add a retry or add a model call without updating §11 and the invariant 28 test.
- Questions run on Gemini Flash, the tutor on Gemini 4 Argon, project generation on Claude.
- New migrations start at 0015. Project columns say project_profile; `profiles` is the user table.
- Everything new is behind PROJECT_LEARNER. With the flag off, the app behaves as it does today.
- Edit only the files your phase's tasks name. Anything else goes in HANDOFF.md.
- Do not spawn subagents. Keep replies short; show diffs, not explanations.
- Done means: npm run typecheck && npm test && npm run lint pass for your workspaces.
