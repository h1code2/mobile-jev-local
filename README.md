# Mobile Jev Local

**One goal. A real Android phone. Jev makes the decisions.** — now over your own USB/Wi-Fi-connected device through adb, no cloud device account required.

A fork of [droidrun/mobile-jev](https://github.com/droidrun/mobile-jev) that adds a **local adb transport**. The decision loop, candidate discovery, safety validation, CLI, studio, and traces are unchanged; only the device layer differs.

|                   | Original (Mobilerun)            | This fork (adb)                                                        |
| ----------------- | ------------------------------- | ---------------------------------------------------------------------- |
| Device            | Cloud Android via Mobilerun API | Your own device via `adb` (`uiautomator dump` / `input` / `screencap`) |
| Account           | Mobilerun API key + device ID   | None — just USB debugging authorized                                   |
| Model             | TypeSafe Jev (cloud)            | TypeSafe Jev (cloud)                                                   |
| Text verification | Server-side `accepted` mode     | Local read-back via re-observation                                     |
| Everything else   | —                               | Identical loop, validation, CLI, studio, traces                        |

TypeSafe still powers decisions (`TYPESAFE_API_KEY` needed for `run`/studio). Direct CLI commands (`observe`, `tap`, `type`, …) need no keys at all.

## Run it

Requirements: **Node.js 22.16+**, **pnpm 10.30.1**, **adb** (`platform-tools`), one Android device with USB debugging authorized.

```sh
git clone <this-repo> && cd mobile-jev-local
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Set `DEVICE_TRANSPORT=adb` in `.env.local`, plug in your phone, then:

```sh
pnpm devices      # list adb devices (auto-picks when exactly one is connected)
pnpm doctor       # connection, UI tree, and focus/keyboard checks
pnpm agent observe   # print the indexed UI state
pnpm agent screenshot --out artifacts/screen.png
```

Drive the agent exactly as upstream — preview one decision, or execute a whole goal:

```sh
pnpm agent run "Turn on dark theme in Android Settings."            # preview
pnpm agent run "Turn on dark theme in Android Settings." \
  --execute --steps 20 --trace artifacts/dark-theme.jsonl           # execute + trace
pnpm demo dark-theme --reset                                        # verified demo run
```

Direct controls work too: `pnpm agent tap 300 500`, `pnpm agent type "hello" --clear`, `pnpm agent back`.

### How the local transport works

- **Observe**: `uiautomator dump /dev/tty` is parsed into the same a11y-tree schema the cloud API returns; `dumpsys window` / `dumpsys input_method` supply the foreground package and keyboard state. Screen size is derived from the tree bounds.
- **Act**: `input tap|swipe|text|keyevent`, `keycombination` for select-all+delete, `monkey -p …` to launch observed apps. Text is shell-quoted for the on-device shell and control characters become space keystrokes, like the cloud transport.
- **Safety unchanged**: every dispatch is preceded by a fresh observation, stale decisions are rejected before input, executed actions are logged before the next read, and `accepted` text mode verifies the complete field value locally by re-reading the tree.
- **Trade-offs vs cloud**: `uiautomator dump` takes ~0.5–2 s per observation (the cloud reads are faster) and can fail on animated screens; the agent's retry budget handles transient dumps. For heavier use, mount an accessibility-service based tree provider later — `AdbDevice` is the only class that would change.

### Environment

| Variable                              | Purpose                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `DEVICE_TRANSPORT`                    | `adb` (local) or `mobilerun` (cloud, default)                         |
| `ANDROID_SERIAL`                      | Local device serial; auto-picked when exactly one device is connected |
| `MOBILERUN_TEXT_COMPLETION_MODE`      | `accepted` (default, local read-back) or `committed`                  |
| `TYPESAFE_API_KEY` / `TYPESAFE_MODEL` | Only needed for `run`, demo, and studio                               |

All upstream Mobilerun variables still apply when `DEVICE_TRANSPORT=mobilerun`.

## The studio

`pnpm dev` starts the same studio on **http://127.0.0.1:3040**. In adb mode the device panel reports connection, app, and observation state; the live pixel stream remains a Mobilerun feature, so the video stage shows status instead of streaming.

## Development

```sh
pnpm check       # tests (81), lint, typecheck, formatting, production build
pnpm build && pnpm start
```

CI stays offline: tests drive the adb transport through an injected fake, never a real device.

#### Non-ASCII text input

Android's `input text` only synthesizes ASCII; Chinese, accented Latin, or emoji need the open-source [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard) IME:

```sh
adb install ADBKeyboard.apk
```

After installation, the agent enables and switches to ADBKeyBoard automatically when non-ASCII text is needed. Without it, non-ASCII `--text` values fail with a clear setup instruction. ASCII-only goals (like `pnpm demo dark-theme`) work with no extra setup.

| Directory                      | Purpose                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `scripts/mobile-agent/`        | Device transports (Mobilerun + adb), Jev policy, executor, CLI and tests |
| `scripts/mobile-agent/adb.mjs` | adb exec wrapper, uiautomator XML parsing, shell quoting                 |
| `apps/jev-studio/`             | Next.js studio, device credentials route, SSE and task lifecycle         |
| `scripts/doctor.mjs`           | Configuration and device connectivity checks for both transports         |

MIT licensed; dependencies retain their respective licenses.
