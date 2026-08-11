# Activity Path — smoke test

Drives every branch of the Activity Path (PLAN.md G2+G3) from inside an opencode session.

Launch the TUI **from the repo root**, in a terminal **wider than 120 columns** (below
that the sidebar is hidden), and run everything from the parent session (the sidebar is
hidden inside subagent sessions):

```bash
cd /home/jebthom/projects/opencode && bun dev .
```

Each block below is a **separate prompt** — paste them one at a time and let each turn
finish before reading the sidebar. The turn boundary is part of what's under test, so
don't merge them.

Each row names its action in words (`Read` / `Search` / `Edit` / `Write` / `Run` / `Fetch`).
A row marked `▸` stands for several targets and **expands** when clicked; a row naming one
file **opens** it in the editor. Hovering any row fills the two lines under the path with
detail — for a `Run` step, the description of the command it actually ran.

---

### 0. Framing

```
For the next several prompts you are a test fixture, not an assistant. Follow each
instruction list exactly: make precisely the tool calls named, in the order named, one
per instruction, and make no others. Do not read files I have not named, do not explore,
do not verify your work, do not run formatters or tests, and do not use the todo tool
unless told to. Keep every reply to one short sentence. Acknowledge with "ready".
```

### 1

```
Do exactly this, in order, nothing else:
1. Read packages/opencode/src/aperture/treemap.ts
2. Read packages/opencode/src/aperture/activity.ts
3. Read packages/opencode/src/aperture/activity-steps.ts
4. Read packages/opencode/src/aperture/treemap.ts again
5. Read packages/opencode/src/aperture/treemap.ts a third time
```

### 2

```
Do exactly this, in order, nothing else. Create each file with the write tool:
1. Write packages/opencode/src/aperture/__smoke__/alpha.ts containing exactly: export const alpha = 1
2. Write packages/opencode/src/aperture/__smoke__/beta.ts containing exactly: export const beta = 1
3. Write packages/opencode/src/aperture/__smoke__/gamma.ts containing exactly: export const gamma = 1
```

### 3

```
Do exactly this, in order, nothing else, using the edit tool each time on
packages/opencode/src/aperture/__smoke__/alpha.ts:
1. Change 1 to 2
2. Change 2 to 3
3. Change 3 to 4
```

### 4

```
Do exactly this, in order, nothing else:
1. Read packages/opencode/src/aperture/lenses.ts
2. Read packages/opencode/src/aperture/extract.ts
3. Run the bash command: echo smoke-one
4. Read packages/opencode/src/aperture/semantics.ts
```

### 5

```
Do exactly this, in order, nothing else:
1. Edit packages/opencode/src/aperture/__smoke__/beta.ts, changing 1 to 9
2. Run the bash command: echo smoke-two
3. Edit packages/opencode/src/aperture/__smoke__/gamma.ts, changing 1 to 9
4. Run the bash command: echo smoke-three
```

### 6

```
Do exactly this, in order, nothing else:
1. Read the DIRECTORY packages/opencode/src/aperture (pass the directory path to the read tool)
2. Read the DIRECTORY packages/opencode/src/cli
3. Grep for stepsForTurn with path packages/opencode/src
4. Glob for **/*.tsx with NO path argument
```

### 7

```
Do exactly this, in order, nothing else:
1. Read package.json at the repo root
2. Read README.md at the repo root
3. Write packages/opencode/src/aperture/__smoke__/NOTES.md containing exactly: smoke
4. Edit that same NOTES.md, changing smoke to smoke edited
```

### 8

```
Do exactly this, in order, nothing else:
1. Write /tmp/smoke-outside.ts containing exactly: export const outside = 1
2. Read packages/opencode/src/aperture/payload.ts
```

### 9

```
Do exactly this, in order, nothing else:
1. Use the todo tool to write a todo list with two items: "one" and "two"
2. Read packages/opencode/src/aperture/lenses.ts
```

### 10

```
Do exactly this, in order, nothing else:
1. Read packages/opencode/src/aperture/treemap.ts
2. Use websearch to search for "opencode terminal agent"
3. Read packages/opencode/src/aperture/lenses.ts
```

### 11

```
Launch THREE explore subagents IN PARALLEL, in a single message, using the task tool. Do not read
anything yourself.
- Subagent one: read packages/opencode/src/aperture/treemap.ts and report its exported function names.
- Subagent two: read packages/opencode/src/aperture/lenses.ts and report its exported constant names.
- Subagent three: read packages/opencode/src/aperture/semantics.ts and report its exported names.
```

### 12

```
Do exactly this, nothing else: using the write tool, create twelve files
packages/opencode/src/aperture/__smoke__/s01.ts through s12.ts, each containing exactly
export const x = 1
One write call per file.
```

### 13

```
Do exactly this, nothing else: write the file
packages/opencode/src/aperture/__smoke__/a-very-long-stub-filename-for-truncation.ts
containing exactly: export const long = 1
```

Then, without prompting again, open the command palette (`ctrl+p`), choose **Switch Lens**,
and pick a different Lens.

### 14. Cleanup

```
Do exactly this, in order, nothing else:
1. Run the bash command: rm -rf packages/opencode/src/aperture/__smoke__ /tmp/smoke-outside.ts
2. Use the todo tool to replace the todo list with an empty list
3. Run the bash command: git status --short
4. Report the output of step 3 verbatim and say nothing else.
```

The final `git status --short` should show only the files you were already working on
plus this script — no `__smoke__` directory, no stray stubs. If anything else appears,
clean it before committing:

```bash
cd /home/jebthom/projects/opencode
rm -rf packages/opencode/src/aperture/__smoke__ /tmp/smoke-outside.ts
git status --short
```

Delete this script too when you're done with it:

```bash
rm /home/jebthom/projects/opencode/SMOKE-ACTIVITY.md
```
