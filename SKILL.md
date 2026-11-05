---
name: ui-council
description: Improve a web app's UI with a hill-climb loop. Each round screenshots the app, runs objective design checks and AI-slop checks, and has a council of three AI judges (Codex CLI, fresh Claude subagents, Gemini through the Antigravity CLI) score it blind against reference apps and compare it with the last accepted round. A taste exam checks each judge against the user's own picks first, and judges with poor taste stop counting. The builder makes or declines every change the judges ask for, marks each change on the next screenshots, reverts changes the judges call worse, and repeats until every judge and check passes. Use for /ui-council, "run the UI council", "hill climb the design", or making an app's UI look better with multi-model design review.
argument-hint: "[goal, e.g. threshold 9.5 or focus on the settings page]"
---

# UI council

Hill-climb a web app's UI. Each round has five steps:

1. Screenshot the app and run objective checks on each page. Mark every change made for this round on a copy of the screenshots.
2. A council of AI judges scores the screenshots against reference apps, without knowing which product is yours. Each judge lists the exact changes it wants.
3. The same judges compare this round with the last accepted round, without knowing which version is newer.
4. You keep or revert the round. Then you make or decline every change the judges asked for, and record each one.
5. Repeat until every judge and every check passes.

The judges are the Codex CLI, fresh Claude subagents, and the Antigravity CLI (`agy`) running a Gemini model. Every judge judges every round. You are the builder: you make the changes. The Claude judges are separate subagents with a fresh context. They never see your work in progress, and you never judge your own work.

The helper script does the mechanical parts. Run it from the project root:

```bash
node ~/.claude/skills/ui-council/council.mjs <command>
```

Below, `council <command>` is short for that line. Run it with no command to see the usage.

## Setup (first run in a project)

1. **Git branch.** The project must be a git repository. If the working tree has uncommitted changes, ask the user to commit or stash them first. Do not do it for them. Tell the user the loop works on a new branch and commits after each round, then create the branch: `git switch -c ui-council/<short-name>`. Never push. Never merge.
2. Run `council init`. It creates `council/` with `config.json`, `style.md`, `taste.md`, `notes.md`, `refs/` and a `.gitignore`. Existing files are kept.
3. **Design language.** Fill in `council/style.md` from the project itself, so the council improves this design and never swaps it for a generic one. Read the project's design sources: design tokens, theme files, Tailwind config, global CSS, fonts, key components, and any brand or design docs. Look at the running screens. Write down the aesthetic (for example futuristic, playful kindergarten, pixel-art retro, editorial), the signature elements, color, type, shape and texture, imagery, and the deliberate choices that a generic reviewer might wrongly call flaws. Show it to the user and ask them to correct it. If the project has no clear design language yet, ask the user what they want it to be.
4. Fill in `council/config.json` with the user:
   - `product`: the app's name. Judges never see it, because prompts use letters.
   - `screens`: the name and URL of each key screen. Use 3 to 6 screens. Ask the user which screens matter if it is not clear. A screen can also set `waitForSelector`, `waitMs` or `fullPage`.
   - `themes`: `["light", "dark"]` emulates the system color scheme. If the app switches themes with a URL parameter, put `{theme}` in the URL. If the app has only one theme, use `["light"]`.
   - `viewport`, `threshold` (default 9), `maxRounds` (default 8). A decent app usually needs 3 to 8 rounds. A very rough one can need 20 or more. Each round uses all three judges' quota, so agree the number with the user.
   - `checks`: the objective checks. `contrast` and `overflow` require zero failures. `maxFontSizes`, `maxFontFamilies`, `maxFontWeights` and `maxRadii` cap how many distinct values the pages use. Set a limit to `null` to turn it off. Set limits that fit the design language: for example, a pixel-art site may need a pixel display font and a separate body font. If round 1 is far over a limit, ask the user whether the limit fits the app before you start.
   - `checks.tells`: AI-slop tells found in the page itself, such as headings that end with a period, eyebrow labels above headings, long ALL CAPS lines, negative letter-spacing, Instrument Serif, monospace outside code, many italics, large gradient backgrounds, many pills, and section numbers like "01 ·". They are warnings, never gates. If the design language uses one on purpose, the user can list its name in `checks.allowTells`, for example `["mono-overuse"]` for a terminal-style site.
   - `judges`: every judge listed here judges every round.
   - `models`: optional model overrides. `agy` defaults to `gemini-4-argon-high`. `agy models` lists the choices. Keep a Gemini model for `agy`, so the council has three different providers.
5. Make sure the dev server is running and every URL loads.
6. If screens need a login, ask the user to run this, log in, and close the window:
   ```bash
   npx -y playwright@1.61.1 open --save-storage council/auth.json <login-url>
   ```
   Then set `"storageState": "council/auth.json"`. That file holds session cookies. Never print it or commit it. `init` already adds it to `council/.gitignore`.
7. Ask the user for screenshots of 1 to 3 apps they admire, ideally ones close to this product's design language. Save them as `council/refs/<app>--<screen>.png`, for example `linear--board.png`, with no spaces in the name. Their size should match `viewport`. Without references the loop still runs, but judges score too high. Tell the user this.
8. Write any notes about this product from the user into `council/notes.md`, for example "Too grayscale: keep the brand color on primary actions." Judges and you both follow these notes.
9. Show the user `council/taste.md`. It holds the taste rules every judge applies in any style: the UX and UI basics, fidelity to the design language, and the generic AI-template tells that cost points. Edit it only as the user asks. `init` copies the skill's current rules into the project, and the project keeps its own copy after that. Later changes to the skill's `taste.md` do not reach it. Ask the user before you copy a newer version over it.
10. Check the CLIs with `codex --version` and `agy --version`. Remove any missing judge from `judges`. If `agy` is not signed in, ask the user to run `agy` once in a terminal and sign in with their Google account. The old Gemini CLI (`gemini`) no longer accepts Google AI Pro or free accounts. It works only with a paid `GEMINI_API_KEY`. Add `gemini` to `judges` only if the user has one. Never ask the user to paste a key into the chat.

If the user gave a goal in the arguments, apply it to the config (for example a higher threshold) or to the screen list.

The first `capture` or `exam build` installs a pinned Playwright into the skill folder. This happens once.

## Taste exam (before round 1)

The exam checks that each judge's taste matches the user's. Judges that fail it are shown in the tally, but never count toward a pass, a vote, or the issue list.

The built-in answers assume the original screens are decent, since an uglified copy of a broken screen is not reliably worse. If the app is still very rough, run round 1, make the first round of fixes, and take the exam on round 2's screens instead.

1. **Build.** Run `council exam build`. It needs the dev server running. It makes pairs of the same screen: the real screen against an uglified copy, either with a clear flaw (low contrast, cramped spacing, mixed radii, mixed fonts, misalignment) or with a generic AI-template tell (indigo gradients, glows, tiny uppercase labels, glass, emoji). It also makes "made generic" pairs: the screen with its own design language swapped for a stock template look. These test whether a judge values the product's language or drifts toward generic. They only have a built-in answer with `council exam build --trusted`. Use `--trusted` only when the current screens already carry their design language well, for example after a council pass, or when the user says so. Otherwise only the user's picks answer them. If the design language uses an AI tell on purpose (for example neon glows for a futuristic look), add that recipe to `exam.skip` in the config, for example `["shadows-glow"]`. From the second run on, the exam also adds real before/after pairs from past rounds.
2. **The user's picks.** Ask the user to open `council/exam/index.html` in a browser (on macOS: `open council/exam/index.html`) and pick the better screen in each pair. It takes about two minutes. At the end the page shows a code. When they paste it, run `council exam answer <code>`. Never take the exam for the user. If they skip it, the judges are checked against the built-in answers only. Tell them so.
3. **The judges take it.** In parallel:
   - Codex and agy: `council exam run codex agy`, with Bash `run_in_background: true`.
   - Claude: run `council exam prompt claude 1` and `council exam prompt claude 2`. Pass each output word for word to its own new `general-purpose` subagent.

   Each judge takes the exam twice, with every pair swapped and in a new order. That measures consistency as well as agreement.
4. **Score.** Run `council exam score`. A judge is fit when it agrees with the right answers at least 75% of the time and gives the same answer on both passes at least 75% of the time. The right answer is the user's pick when there is one, otherwise the built-in answer. Show the user the table.
5. **Act on the result.**
   - If the user preferred an uglified "AI tell" version, the score lists it. Ask whether `council/taste.md` should change. If they say yes, edit it, then retake the judge part (step 3 and 4). Their picks are kept.
   - If a judge is unfit, suggest another model for it in `models` (for `agy`, `agy models` lists the choices), then retake the judge part for that judge.
   - If no judge is fit, stop and ask the user.

Retake the judge part whenever `taste.md`, `notes.md`, the prompts or the models change. `tally` says when the exam is out of date.

## Loop

Round 1 is the baseline, before any change. For round N:

1. **Capture.** Run `council capture N`. Screenshots go to `council/rounds/N/shots/`. With `fullPage`, each screen is cut into viewport-sized tiles for the judges (`tiles: true`, the default), so they see text at real size instead of shrunk to fit an image limit. The full-page image for people goes to `council/rounds/N/full/`. The objective checks go to `council/rounds/N/checks.json`. If a screen fails, fix the URL or the server. Do not remove the screen.
   From round 2 on, capture refuses to run until every request in `council/rounds/N/changes.json` is answered (step 4). It then draws each change, as a numbered blue box, on a copy of the screenshots in `council/rounds/N/marked/`. Judges only ever see the clean screenshots. If capture warns that a change's selector matched nothing, fix that selector and capture again.
   Before you judge, look at the full and marked screenshots yourself. If a change broke something, such as text that now wraps, an overflow, or a size under the check limits, fix it now. Fold the fix into the round's commit with `git commit --amend --no-edit`, update the `commit` field, and capture again. One commit per round keeps a revert clean. Never amend a commit from an earlier round.
2. **Judge.** Run every judge in every round. Start them all in parallel:
   - Codex and agy: run `council judge N`. Use Bash with `run_in_background: true`, because it can take several minutes. From round 2 on, each judge also compares this round with the last accepted round.
   - Claude scoring: run `council prompt N claude`. Pass its output word for word as the prompt of a new `general-purpose` subagent.
   - Claude comparison, from round 2 on: run `council prompt N claude-compare`. Pass its output word for word to a second new `general-purpose` subagent.

   Each Claude prompt must go to its own fresh subagent, so one never sees the other's images. Never judge in this session. Long prompts can instead be saved to a file (for example `council/rounds/N/claude.prompt.md`) and given to the subagent as "Read this file and follow it exactly. Apart from that file, read only the screenshots it lists." That keeps your own context small.
3. **Tally.** Run `council tally N`. It prints our scores, the checks, the comparison votes, and a `NEXT:` line. Do exactly what `NEXT:` says:
   - `PASS`: go to Finish.
   - `run judge X`: judge X has no result for this round. Every judge that passed the taste exam must score every round, so run it on the same screenshots, then tally again. Do not capture again. If a judge's CLI keeps failing, stop and tell the user. Never continue with fewer judges unless the user says so.
   - `rerun judge X` or `run the comparison for X`: that output is missing or invalid. Run it again.
   - `REGRESSION`: the judges prefer the last accepted round. Revert this round's commit with `git revert --no-edit <hash>`, and note it in the `commit` field of this round's `changes.json`. Then plan different fixes (step 4) and continue with round N+1. Do not retry the same changes.
   - `run fixes N`: go to step 4.
   - `Stuck: <category>` at the end of `NEXT`: that category stayed under the threshold, with almost no gain, over the last three accepted rounds. Small fixes have stopped moving it. In the next round, make one structural change for each stuck category instead of more nudges. For example: one shared column grid for every section, one spacing scale with gaps between sections clearly larger than gaps inside them, or a redrawn icon set in one style. Record it in `extra` unless a request already covers it, and tell the user about it in your round summary.
   - `STOP: max rounds`: if it says to revert, revert first. Then go to Finish and report that the council did not pass.

   Then run `council gallery` to refresh `council/gallery/index.html`.
4. **The change list.** Run `council fixes N`. It writes `council/rounds/<N+1>/changes.json` with every request from round N, each with an id: objective check failures, screens that got worse, every issue from every judge (with the screen, where on it, the problem and the fix), and the AI-slop tells. Answer every request:
   - **done**: set `"status": "done"`, write in `did` exactly what you changed, with values (for example "Basket line text 16px to 18px, color #6b5a48 to #4a3a2a"), and add `marks`: one or more `{ "screen": "<screen name>", "selector": "<CSS selector of the changed element>" }`, so capture can box it.
   - **declined**: set `"status": "declined"` and write the reason in `did`. Decline only when the request conflicts with `council/style.md` or `council/notes.md`, reverses a change the blind vote kept, asks for the opposite of another judge's request (do one, decline the other, and say which), or is a tell the design language calls for. Never decline a request because it is hard. When judges ask for the same change, mark each one done, write "Same change as <id>" in the later ones, and give them the same marks.

   Changes nobody asked for go in `extra`, with `did` and `marks`. Work in this order:
   - every objective check failure,
   - requests on screens that got worse,
   - requests that several judges raised,
   - high-severity requests,
   - the weakest category in the tally,
   - the AI-slop tells.

   Fix root causes in shared styles, design tokens and components. Avoid one-off patches on a single screen. Every fix stays inside the design language in `council/style.md` and follows `council/taste.md`. Improve how the language is carried out. Never fix a problem by making the design more generic, and never fix one problem by adding an AI-template tell.

   Measure spacing and alignment in the page, not by eye. Read element edges with `getBoundingClientRect()` in a browser before and after the change, and write the numbers in `did`, for example "hero image and Visit block both start at x=801". When judges ask for the same control in two places, reuse the existing component instead of building a lookalike.
5. **Change the code.** Keep the app working. Run the project's own typecheck, lint and tests if it has them.
6. **Commit.** Commit only app changes, never `council/`:
   ```bash
   git add -A -- . ':(exclude)council'
   git commit -m "ui-council: round <N+1> changes"
   ```
   Then put the commit hash in the `commit` field of `council/rounds/<N+1>/changes.json`.
7. **Next round.** Go back to step 1 with round N+1, with every judge.

### Every judge, every round

The three judges see different things, so each round needs all of them. A pass needs every fit judge to pass in the same round, with every check passing. Judges that failed the taste exam are shown but never count. A judge with no result blocks the tally. It is not skipped.

## Rules

- Never tell any judge which product is the user's, the threshold, or that there is a target score. The prompts hide all three on purpose. Do not add them.
- Change only the app. Never edit the reference images, the threshold, the check limits, the taste rules, the rubric, the judge prompts, or the screen list to make a round pass. Only the user changes those.
- Never answer the taste exam for the user, and never mark a judge fit or unfit by hand.
- The design language belongs to the user. Change `council/style.md` only when the user asks, never to make a round pass.
- Never remove content or features to make a screen look cleaner, unless the user asks.
- Judges are read-only. Claude judges are always new subagents with a fresh context.
- Answer every request. Each one is done (with what you changed and a mark) or declined (with the reason). Never drop one silently.
- Scores are noisy. The same screenshot can get different scores. Trust what several judges agree on. An issue that only one judge raises gets lower priority, but it is still answered. Judges sometimes ask for the opposite of what they asked for a few rounds earlier. Let the blind before/after vote settle it: decline the reversal and say which round's vote kept the current version.
- The AI-slop tells are one designer's list, so weigh them as one opinion. Remove a tell unless the design language calls for it. `checks.allowTells` belongs to the user, like the check limits.
- Claude judges must not run commands. If this environment has an agent type limited to the Read and Write tools, use it for judge subagents.
- When `notes.md` and a judge disagree, follow `notes.md`.
- Git: work only on the `ui-council/...` branch. Undo with `git revert`, never with `git reset --hard` or a force push. Never push or merge.
- Each round uses the user's Codex, Claude and Antigravity (Google AI) quota. Do not raise `maxRounds` without asking.

## Finish

1. Run `council history` to show scores, checks and votes per round, and `council gallery` for the page with every round. Give the user its path: `council/gallery/index.html`.
2. Show the user round 1 and the final round screenshots for the same screens, and the marked screenshots of the last round. Give the file paths.
3. Summarize: the number of rounds, how the scores changed, the main changes, any reverted rounds, and where judges still disagree.
4. Tell the user the branch name. They decide whether to merge it.
5. Ask the user for a taste check. Write their notes into `council/notes.md`. If they want to go further, raise `threshold` (for example to 9.5) and continue from the next round number.
6. Offer a fresh taste exam (`council exam build`). It now includes this run's real before/after pairs, so the user's picks keep teaching the council their taste.
