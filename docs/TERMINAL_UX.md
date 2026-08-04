# Forge terminal UX

Forge has two terminal renderers over one coding engine and one typed UI event
stream:

- **Workspace** is the default on an interactive terminal. It is a persistent,
  full-screen Textual application with a transcript, visible plan, grouped
  activity, changed-file sidebar, composer, status line, diff browser, session
  browser, settings, command palette, and approval dialogs.
- **Classic** is the scrollback-native Rich and prompt-toolkit renderer. It is
  selected automatically for redirected output, `TERM=dumb`, CI, and terminals
  that should not use a full-screen interface. It can also be selected
  explicitly.

The agent, policy, verification, undo, session, and evidence implementations do
not depend on either renderer.

## Renderer selection

```bash
# Automatic: workspace on a real TTY, classic otherwise.
forge

# Explicit selection.
forge --ui workspace
forge --ui classic
forge chat --ui workspace

# Session or shell preference.
FORGE_UI=classic forge
```

Repository configuration is also supported:

```yaml
product:
  ui_renderer: auto       # auto, workspace, classic
  ui_density: normal      # focus, normal, verbose
```

Precedence is CLI, `FORGE_UI`, `forge.yaml`, then automatic terminal detection.
If the Textual renderer cannot import, Forge names the problem and falls back to
classic mode. An invalid renderer value exits with an actionable error.

## Product principles

1. **The coding turn is the primary unit.** A request owns its plan, activity,
   verification, review, changed files, and outcome.
2. **Persistent state stays visible.** Project, branch, model, connection,
   interaction mode, permission mode, context, throughput, and changed-file
   count do not have to be rediscovered in transcript output.
3. **Evidence is available without becoming noise.** Reads are grouped,
   consequential actions remain explicit, and raw evidence is expandable with
   `Ctrl-A` or `/activity`.
4. **Approvals explain consequences.** The exact diff or command, scope, and
   recovery boundary are visible before authority is granted.
5. **The classic renderer remains first-class.** SSH, logs, accessibility tools,
   CI, and users who prefer native scrollback are not second-class workflows.
6. **Color is semantic and supplemental.** Most chrome is neutral. Amber is the
   Forge accent; green means verified success, red means failure or danger, and
   yellow means warning or pending authority.
7. **Raw model protocol stays hidden.** Renderers consume typed events and never
   expose planner or executor JSON as the product interface.

## Workspace layout

```text
┌─ FORGE ─ project ─ branch ─────────────────── model ─ connected ┐
│                                                                │
│  YOU                                                           │
│  Fix the parser and add regression tests.                      │
│                                                                │
│  CURRENT TURN                              ┌─ PLAN ───────────┐ │
│  IMPLEMENTING                              │ ✓ Inspect parser │ │
│  ✓ Investigated repository                │ ● Implement fix  │ │
│  ✓ Edited src/parser.py                    │ ○ Verify         │ │
│  ● pytest -q                               ├─ ACTIVITY ───────┤ │
│                                            │ model/executor   │ │
│                                            │ 8.1 tok/s        │ │
│                                            ├─ CHANGES ────────┤ │
│                                            │ M parser.py +18-5│ │
│                                            └───────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│ Ask Forge to inspect, explain, fix, or build…                  │
│ Enter send · Ctrl-J newline · Tab complete · Ctrl-K commands   │
├────────────────────────────────────────────────────────────────┤
│ auto · ask · qwen3.5-9b · ctx 24% · 2 files changed · working  │
└────────────────────────────────────────────────────────────────┘
```

At widths below 96 columns the sidebar disappears and the current turn retains
its plan count, phase, important activity, and outcome in the main transcript.
The composer shrinks on short terminals. Modal surfaces use nearly the full
viewport on narrow displays.

## Keyboard map

| Key | Action |
| --- | --- |
| `Enter` | Submit the composer or activate a selected item |
| `Ctrl-J` | Insert a newline in the composer |
| `Tab` | Complete slash commands, arguments, or `@paths` |
| `Ctrl-K` | Search the command palette |
| `Ctrl-D` | Open the tracked and untracked diff browser |
| `Ctrl-A` | Open expandable activity and evidence |
| `Ctrl-S` | Search and manage sessions |
| `Ctrl-,` | Open interaction, permission, and density settings |
| `F2` | Cycle focus, normal, and verbose activity density |
| `Esc` | Close a modal or return focus to the composer |
| `Ctrl-Q` | Quit Forge |

Slash commands remain available and are shared with classic mode. Workspace-only
`/activity` opens the evidence drawer.

## Typed event architecture

The coding core publishes renderer-neutral events:

```text
TaskStarted
PhaseChanged
PlanUpdated
RoleStarted / RoleProgress / RoleFinished
ToolStarted / ToolFinished
VerificationCompleted
ReviewCompleted
FilesChanged
ApprovalRequested / ApprovalResolved
TaskCompleted
```

`EventHub` fans events out and retains bounded history. `WorkspaceState` is a
pure reducer responsible for grouping observations, plan state, activity
visibility, verification, review, and changed-file status. The classic hook
protocol is translated at one compatibility boundary instead of being parsed
throughout every renderer.

This division is intentional:

```text
CodingAgent / Chat
        │
        ▼
typed UI events
   ├── Workspace renderer  Textual
   ├── Classic renderer    Rich + prompt-toolkit
   └── future adapters     editor or machine UI
```

## Activity density and evidence

- **Focus** hides successful low-level inspection and retains verification,
  review, warnings, and failures.
- **Normal** groups successful reads, searches, listings, and Git checks while
  showing mutations and commands individually.
- **Verbose** shows every retained activity group.

The activity drawer uses expandable sections. It displays targets and captured
command or tool output without forcing the main transcript to become a log
viewer.

## Diff workspace

The diff browser presents a file table with added and deleted line counts and a
syntax-highlighted per-file patch. Tracked changes come from `git diff` with
external diff drivers disabled. Untracked UTF-8 files receive bounded synthetic
patches; binary and oversized files are identified without embedding their
contents. `.forge/` evidence is excluded from the user diff.

## Sessions

The session browser supports:

- search and preview;
- resume;
- recoverable rename;
- fork under a new or generated name;
- move to repository-local `.forge/sessions/.trash/` rather than permanent
  deletion.

The active session cannot be trashed until another session is selected or a fork
is created. Session IDs remain bounded to letters, numbers, `_`, and `-`.

## Approvals

Edit approvals show the exact patch. Command approvals show the command, one-run
scope, and the limit of `/undo`. Users can allow once, allow the action kind for
the current session, deny, or deny with an instruction. Unlisted commands cannot
receive durable session approval. Permission modes remain authoritative before a
modal is opened:

- `plan`: refuse edits and commands;
- `ask`: ask for edits and commands;
- `edits`: apply edits, ask for commands;
- `full`: run allowlisted work unattended and refuse unlisted commands.

## Classic renderer

Classic mode preserves native scrollback, terminal selection, redirected output,
ASCII fallback, and prompt-toolkit history. It keeps one transient activity row,
groups successful inspection, and renders consequential diffs and approvals as
Rich panels. It uses the same agent, plan, policy, verification, and session
implementation as workspace mode.

## Accessibility and deterministic behavior

- `NO_COLOR=1` and `FORGE_ASCII=1` remain supported by classic mode.
- Workspace meaning is not encoded by color alone; labels and glyphs identify
  all states.
- Non-interactive commands do not enter Textual and retain deterministic output.
- Complete evidence remains under `.forge/runs/` regardless of renderer or
  density.
- Renderer and state-reducer behavior are tested headlessly across wide and
  narrow terminal sizes.
