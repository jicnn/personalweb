---
publishDate: 2026-10-04
draft: false
featured: true
title: "From an IR Remote Requirement to a Boot-Start APK — A Complete Development Log of Remote Customization on an S905L2 Android 9 TV Box"
excerpt: "On an Amlogic S905L2 Android 9 TV box, a 16KB hand-built (Gradle-free) APK runs remotecfg automatically at boot. Three iterations cut through BOOT_COMPLETED background limits, init.rc service name collisions, boot-time races, and the ps/grep trap."
tags: ['Android', 'Amlogic', 'apk-build', 'embedded', 'ir-remote', 'boot-autostart']
categories: ['embedded', 'android']
---

> Device: Amlogic S905L2 TV box / Android 9 (armv7) / rooted / reachable over network ADB
> Goal: Automatically run `remotecfg -c /data/remote.cfg -t /data/remote.tab -d` after boot so the IR remote works with custom key mappings
> Result: A 16KB Gradle-free, hand-built APK (v1.2) that works fully automatically at boot
> Keywords: `BOOT_COMPLETED`, `startForegroundService`, `aapt2/d8/apksigner`, `remotecfg`, `init.rc`, boot race

---

## Table of Contents

1. [Background and Requirements](#1-background-and-requirements)
2. [Know Your Opponent: The Amlogic IR Remote Framework](#2-know-your-opponent-the-amlogic-ir-remote-framework)
3. [Solution Selection: Why "APK + BOOT_COMPLETED"](#3-solution-selection-why-apk--boot_completed)
4. [The APK Project, File by File](#4-the-apk-project-file-by-file)
5. [The Gradle-Free Hand-Build Pipeline](#5-the-gradle-free-hand-build-pipeline)
6. [Three Iterations of Debugging](#6-three-iterations-of-debugging)
7. [Comparison with Community Approaches](#7-comparison-with-community-approaches)
8. [Key Takeaways and Pitfall Checklist](#8-key-takeaways-and-pitfall-checklist)
9. [Appendix: Full Source and Deployment Commands](#9-appendix-full-source-and-deployment-commands)
10. [References](#10-references)

---

## 1. Background and Requirements

### 1.1 The raw requirement

I have an Android TV box based on the Amlogic S905L2 SoC, running a third-party Android 9 (API 28) ROM, armv7 architecture. Developer mode is on and it is reachable over network ADB (`adb connect 192.168.1.104:5555`). The system ships with `su` (at `/system/xbin/su`; `id` reports `uid=0(root) context=u:r:su:s0` — the typical "built-in privileged su" of a userdebug ROM).

The requirement is one sentence:

> **After boot (once /data is mounted), automatically run once: `remotecfg -c /data/remote.cfg -t /data/remote.tab -d`.**

The two config files live at the root of the `/data` partition:

- `/data/remote.cfg` — remote protocol parameters (work mode, repeat-key switch, debug switch, etc.)
- `/data/remote.tab` — scancode-to-Linux-keycode mapping table

My initial thought was naive: "It's just running a command at boot, right?" As it turned out, that single command dragged in a whole chain of deep-water issues: **Android 8.0 background execution limits, the init.rc duplicate-service-name mechanism, the Amlogic remote framework's "upload-and-exit" model, and the trap of process matching with ps**. Development went through three versions (v1.0 → v1.2), each overturning a previous assumption.

### 1.2 Translating the requirement into technical terms

The requirement actually implies four technical constraints:

| # | Constraint | Technical point |
|---|------------|-----------------|
| 1 | "After boot" | Needs a boot-time hook: the `BOOT_COMPLETED` broadcast, an init.rc service, or a Magisk boot script |
| 2 | "After /data is mounted" | `BOOT_COMPLETED` satisfies this naturally (it is sent after /data is mounted and the user is unlocked), but polling for file existence is kept as insurance |
| 3 | "Run remotecfg" | The binary is already on the device at `/vendor/bin/remotecfg`; a normal app has no access to `/data/remote.cfg`, so it must run as root → `su -c` |
| 4 | "It must be an APK" | The user explicitly wants APK delivery: installable, removable, no flashing required |

Point 3 deserves elaboration: the `/data` root is `root:root 0711` under the Linux permission model. An ordinary app process (the `untrusted_app` SELinux domain) cannot even `stat` those two config files. So the execution chain inside the app is necessarily:

```text
app process (u0_aXX) → fork → exec "su" → su privilege escalation → sh -c "remotecfg ..." → runs as root
```

This also explains why the APK cannot work without root — it is essentially a "boot script manager for rooted boxes."

### 1.3 Deliverable definition

- Minimal APK: minSdk 21 (Android 5+ compatible), targetSdk 28 (matching Android 9, avoiding extra constraints of higher targets)
- No UI dependency: the UI is just a log view plus a "Run now" button, used for troubleshooting
- Full-chain logging: exit code, stdout, and stderr of every exec call are persisted to disk for on-site inspection
- No build-toolchain dependency: source code plus a set of shell commands is enough to rebuild on any machine with the Android SDK installed

---

## 2. Know Your Opponent: The Amlogic IR Remote Framework

Before writing any automation script, understand how the target program works — otherwise you lose all direction when troubleshooting. This section explains the Amlogic IR framework and parses the two config files. It consolidates the CoreELEC Wiki remote.conf tutorial and the classic LibreELEC forum thread "Create remote.conf from scratch."

### 2.1 The full chain: from physical IR light to Android key events

```text
Remote control (NEC IR protocol)
   │  infrared light
   ▼
Box IR receiver
   │  electrical pulses
   ▼
Kernel meson-ir driver (Amlogic IR decoder, hardware/software decoding)
   │  /dev/input/eventX  ← raw scancodes
   ▼
remotecfg userspace tool (reads scancodes, looks up the remote.tab mapping table)
   │  injects mapped Linux keycodes (via uinput or direct write)
   ▼
Android Input subsystem → apps receive key events
```

`remotecfg` is a userspace tool shipped with the Amlogic BSP. On this device it is at `/vendor/bin/remotecfg` (about 11KB, a native binary for the toybox-like environment). Its core responsibility is one thing: **loading the mapping "remote physical scancode → Android keycode" into the system**.

### 2.2 remote.cfg fields explained

Our device's `/data/remote.cfg`:

```ini
work_mode = 0
repeat_enable = 1
debug_enable = 1
max_frame_time = 2000
```

Based on the official Amlogic annotations circulated in the LibreELEC thread (they appear almost verbatim in every community remote.conf tutorial):

| Field | Meaning | Notes |
|-------|---------|-------|
| `work_mode` | 0: software decoding / 1: hardware decoding | In software mode remotecfg measures pulse widths itself; hardware mode relies on the SoC's IR hardware decoder registers (the `reg_*` parameters) |
| `repeat_enable` | Enable long-press repeat | 1 = holding a direction key scrolls continuously |
| `release_delay` | Key-release report delay (ms) | How long after release the kernel waits before reporting the release event to userspace |
| `debug_enable` | Debug switch | 1 = print parse results at runtime (this is why our logs show `map_size = 12`, etc.) |
| `custom_code`/`factory_code` | Remote manufacturer code | Format: `custom_code(16bit) + index_code(16bit)`, e.g. `0xff000001 = 0xff00 + 0001`. It must match the manufacturer code actually emitted by the remote, otherwise every key is "not found" |

Our cfg does not specify `custom_code` (program output shows `custom_name =`, `custom_code = 0xff00`, i.e. default/table values), because newer remotecfg versions allow the `custom_code` to be written into the header of the `.tab` file while `remote.cfg` only manages protocol-layer parameters. Older community tutorials (for the Android-6-era single-file `remote.conf` layout) put `factory_code` and the key table in one file — both layouts are common in community material and are essentially the same.

### 2.3 Parsing the remote.tab key table

Our `/data/remote.tab`:

```text
custom_code = 0xff00

key_begin
0x46 103
0x16 108
0x47 105
0x15 106
0x55 28
0x04 139
0x40 158
0x14 115
0x10 114
0x18 116
0x4e 102
0x5b 113
key_end
```

Each line is a `scancode Linux-keycode` pair:

| Scancode | Keycode | Linux name | Actual function |
|----------|---------|------------|-----------------|
| 0x46 | 103 | KEY_UP | Up |
| 0x16 | 108 | KEY_DOWN | Down |
| 0x47 | 105 | KEY_LEFT | Left |
| 0x15 | 106 | KEY_RIGHT | Right |
| 0x55 | 28 | KEY_ENTER | OK |
| 0x04 | 139 | KEY_MENU | Menu |
| 0x40 | 158 | KEY_BACK | Back |
| 0x14 | 115 | KEY_VOLUMEUP | Volume + |
| 0x10 | 114 | KEY_VOLUMEDOWN | Volume − |
| 0x18 | 116 | KEY_POWER | Power |
| 0x4e | 102 | KEY_HOME | Home |
| 0x5b | 113 | KEY_MUTE | Mute |

Keycodes use the standard Linux input event codes (`input-event-codes.h`). The CoreELEC Wiki tutorial provides a complete "capture codes → look up → fill the table" workflow: first capture each key's raw scancode with `ir-keytable -t` or kernel logs, then fill the table against the keycode header. The `key[0] = 0x460067` printed at remotecfg startup is exactly the internal representation of "scancode 0x46 → keycode 0x67 (103)".

### 2.4 A counterintuitive mechanism: remotecfg is an uploader, not a daemon

This is the **single most important insight** of the whole project, and the key to the v1.2 investigation later.

According to older community tutorials (posts from around 2017), remotecfg is a resident userspace daemon listening on `/dev/input`. But testing on this device overturned that impression:

- After manually running `remotecfg ... -d`, the command returns immediately with `exit=0`, printing the fully parsed key table;
- Afterward, neither `ps -A` nor walking `/proc/*/cmdline` shows **any process named remotecfg**;
- Yet the remote immediately works with the custom mappings and **keeps working** (we verified it still works after more than 10 minutes).

Conclusion: this remotecfg build **uploads the key table to the kernel IR subsystem and then exits** (the "daemonize" semantics of `-d` produce no resident process in this implementation). The kernel maintains the mapping. The "last upload" determines the active keymap — and this model directly shapes the boot-timing fix later.

> Lesson: **community tutorials age**. Amlogic BSP tools behave very differently across chips and ROM eras (old S905 firmware vs newer S905L2 firmware). Always trust what you measure on your own device.

### 2.5 Where do scancodes come from: the NEC protocol and the code-capture workflow

To write your own `remote.tab`, the first question is "what is each key's scancode?" This touches the bottom layer of IR remotes, the NEC protocol: each key press emits a burst of 38kHz-carrier-modulated IR pulses consisting of a "leader code + 16-bit customer code (custom_code) + 8-bit key code + 8-bit bitwise-inverted key code + stop code." The kernel meson-ir driver decodes this pulse train into two numbers: the **customer code** (the `custom_code = 0xff00` in remote.tab, used to distinguish remote brands) and the **key code** (the `0x46`, `0x16`, etc. in the first column).

There are two mature code-capture toolchains in the community:

- **Android side**: temporarily set `debug_enable = 1` in `remote.cfg`, run remotecfg, then press keys; the kernel log (`dmesg`) prints each key's "wrong custom code" or raw scancode — the classic LibreELEC thread uses exactly this `dmesg -c`-clear-then-press method to capture keys one by one;
- **Linux/CoreELEC side**: `ir-keytable -t` shows raw scancodes and mapped keycodes in real time, a much nicer experience; the CoreELEC Wiki walks through this route.

After capturing the scancodes, the second column takes Linux input event codes (`KEY_UP=103`, `KEY_ENTER=28`, etc. from `input-event-codes.h`). This header is universal across the community, and a searchable copy is maintained in CoreELEC's GitHub repos. Once you understand that "the scancode is just the remote's physical number, the keycode is the semantic meaning in Android's eyes," every line of `remote.tab` loses its mystery.

### 2.6 remotecfg command-line reference

Combining tests on this device with community sources, the common invocation forms:

```bash
remotecfg <remote.conf>                        # old single-file mode (conf+tab merged)
remotecfg -c <cfg> -t <tab>                    # new split-file mode (used by this ROM)
remotecfg -c <cfg> -t <tab> -d                 # -d: daemonize semantics (here: upload then exit)
```

We use `-d` mainly to match the user-specified target command; testing confirms that with it, the upload succeeds and the exit code is 0 on this device. If you replicate this project on another box, run the `-d` form manually once and watch the process list to determine whether your remotecfg is the "resident" or "uploading" kind — that decides your boot-timing strategy (the resident kind additionally requires care about su-session process-group cleanup; the uploading kind only needs correct ordering).

---

## 3. Solution Selection: Why "APK + BOOT_COMPLETED"

There are at least three mainstream approaches to "run a root command at boot," each with fans in the blogosphere. Compare first, choose second.

### 3.1 Three candidates

| Approach | Principle | Pros | Cons |
|----------|-----------|------|------|
| A. init.rc service | Drop an rc file defining a service into `/system/etc/init/` | System-level timing, no app, root by nature | Requires remounting/editing /system; redone after OTA/ROM changes; a bad rc can prevent boot; hard to adjust dynamically |
| B. Magisk module script | Magisk's `service.sh`/`post-fs-data.sh` run at boot | Leaves the system partition untouched; flexible scripts | Depends on Magisk being present and its version behavior; this device's su is ROM-built-in, not Magisk, so it does not apply; script debugging is painful |
| C. APK + BOOT_COMPLETED broadcast | The app registers for the boot broadcast and starts a service to run the command | Install/uninstall = deploy/remove; UI for logs; exactly the delivery form the user wants | Constrained by Android 8.0+ background execution limits (the protagonist later); depends on root authorization cooperation |

A notable fact about this device: **someone already tried approach A in the ROM** — `/system/etc/init/load_remote.rc` does exactly that (see §6.3), but it is silently ignored by init because of a duplicate service name, making it dead weight. This demonstrates the fragility of approach A: your rc file may silently fail due to name collision, SELinux, or syntax, and it vanishes on ROM updates.

We ultimately chose approach C while absorbing approach A's lesson: **build "sweep + timing control" logic into the APK — don't race the ROM's own services; make sure we take the field last.**

### 3.2 Our stance on "service keep-alive" approaches

Chinese-community blog posts about "boot autostart" are mostly about **Service keep-alive** (dual-process guardians, JobScheduler resurrection, foreground-service elevation, listening to eight kinds of system broadcasts — representative material includes CSDN's "Android Service keep-alive methods summarized" and the open-source HelloDaemon/ServiceDaemon projects). This article deliberately goes the other way:

- Our task is **one-shot** — after uploading the keymap the process should exit; "keep-alive" is meaningless or even harmful;
- Our Service lifespan is measured in seconds: `startForegroundService` → `startForeground` (satisfy the 5-second rule) → do the work → `stopForeground` + `stopSelf`;
- The only thing that needs to "persist" is the result (the keymap in the kernel), not the process.

This distinction is worth thinking through for anyone building boot tasks: **do you need to keep the process alive, or the effect it produces?** If the latter, the right design is "ensure successful execution + verify + exit," not permanent memory residency.

---

## 4. The APK Project, File by File

### 4.1 Structure overview

```text
RemoteCfgBoot/
├── AndroidManifest.xml              # component declarations and permissions
├── res/
│   ├── drawable/ic_launcher.png     # launcher icon (generated via PowerShell System.Drawing)
│   └── values/strings.xml           # app name
├── src/com/local/remotecfgboot/
│   ├── BootReceiver.java            # boot broadcast receiver
│   ├── RunService.java              # foreground service + core execution logic + logging
│   └── MainActivity.java            # log viewer + manual trigger
├── build/                           # intermediate build artifacts (generated by script)
└── RemoteCfgBoot.apk                # final artifact (16KB)
```

Three Java files, about 400 lines total. No Gradle project files, no dependency libraries, no androidx — everything built into the API 28 `android.jar` is enough.

### 4.2 AndroidManifest.xml

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.local.remotecfgboot"
    android:versionCode="3"
    android:versionName="1.2">

    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="28"/>

    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>

    <application
        android:label="@string/app_name"
        android:icon="@drawable/ic_launcher"
        android:allowBackup="false">

        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>

        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED"/>
                <action android:name="android.intent.action.QUICKBOOT_POWERON"/>
            </intent-filter>
        </receiver>

        <service android:name=".RunService" android:exported="false"/>
    </application>
</manifest>
```

Item by item:

- **`minSdkVersion=21, targetSdkVersion=28`**: targetSdk is the "declare which era of behavior you're compatible with" switch. Declaring 28 means the system treats us under Android 9 rules — background service limits apply (the root cause of the v1.0 failure), but Android 10+ restrictions like background-activity-start limits and foreground-service-type declarations do not. For an Android 9 box, 28 is the most fitting value.
- **`RECEIVE_BOOT_COMPLETED`**: a normal permission, granted at install; the ticket to receiving the boot broadcast. Without it, `BootReceiver` never fires.
- **`FOREGROUND_SERVICE`**: a normal permission added in API 28; the ticket to call `startForeground()`. v1.0 missed it; v1.1 added it.
- **`QUICKBOOT_POWERON`**: some box/TV ROMs (especially Amlogic and HiSilicon) broadcast this private action on "fast boot" paths instead of standard `BOOT_COMPLETED`. Listening for both is standard TV-box practice.
- **receiver `exported="true"`**: `BOOT_COMPLETED` is a system broadcast; the receiver must be open to the outside so the system process can deliver it. Optional when targetSdk < 31, but explicit declaration is good hygiene.
- **service `exported="false"`**: the service is started only by our own receiver/activity, never exposed.

### 4.3 BootReceiver.java — the boot entry point

```java
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }
        RunService.appendLog(context, "received " + action);
        Intent svc = new Intent(context, RunService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                // Android 8+: must use startForegroundService and go foreground within 5s
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception e) {
            RunService.appendLog(context, "startForegroundService failed: " + e);
            // Fallback: do the work directly inside the broadcast window via goAsync
            final BroadcastReceiver.PendingResult pr = goAsync();
            final Context app = context.getApplicationContext();
            new Thread(() -> {
                try { RunService.runOnce(app, false); }
                finally { pr.finish(); }
            }, "remotecfg-fallback").start();
        }
    }
}
```

Three design points:

1. **`startForegroundService` is the front door on Android 8.0+**. The official "Background Execution Limits" doc is clear: background apps cannot `startService`, but `startForegroundService` is exempt — at the price that the service must call `startForeground()` within 5 seconds of creation, or the system ANRs and stops it.
2. **`goAsync()` fallback**: if some deeply customized ROM blocks even `startForegroundService` (rare but real), do the work directly on a thread inside the broadcast window. `goAsync()` extends the receiver's lifetime from milliseconds to roughly 10 seconds (the foreground-broadcast timeout ceiling); you must return control with `pr.finish()`. This is a one-shot fuse; the normal path never reaches it.
3. **Logging precedes everything**: the boot moment is fleeting — get the first log line to disk before doing anything else.

### 4.4 RunService.java — foreground service and core logic

This is the body of the app, explained in four parts.

**(a) The correct foreground-service posture**

```java
@Override
public int onStartCommand(Intent intent, int flags, int startId) {
    final boolean manual = intent != null && intent.getBooleanExtra("manual", false);

    Notification n = new Notification.Builder(this, CHANNEL_ID)   // API 26+
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("RemoteCfg")
            .setContentText("Running remotecfg ...")
            .setOngoing(true)
            .build();
    startForeground(1, n);   // must be called immediately in onStartCommand to meet the 5s rule

    new Thread(() -> {
        try { runOnce(this, manual); }
        finally { stopForeground(true); stopSelf(); }
    }, "remotecfg-runner").start();
    return START_NOT_STICKY;
}
```

- The notification channel (`NotificationChannel`) is created in `onCreate`; mandatory on API 26+, otherwise the notification cannot be posted;
- `IMPORTANCE_MIN` keeps the notification silent and unobtrusive;
- As soon as the work is done, leave foreground and stop the service — no resource hoarding. **The foreground notification is only a pass to cross the "background limits" checkpoint, not a feature.**

**(b) The runOnce timing design (v1.2 final logic)**

```java
public static void runOnce(Context c, boolean manual) {
    long start = SystemClock.elapsedRealtime();

    // 1. Wait until both config files on /data are ready (up to 10 tries × 3s)
    for (int i = 1; i <= 10; i++) {
        Result r = runSu(c, "test -f /data/remote.cfg -a -f /data/remote.tab && echo READY", 8000);
        if (r.exitCode == 0 && r.out.contains("READY")) break;
        sleep(3000);
    }

    // 2. Boot path: wait for all ROM-bundled remote instances to finish so ours is the last upload
    if (!manual) {
        long settle = 15000 - (SystemClock.elapsedRealtime() - start);
        if (settle > 0) sleep(settle);
    }

    // 3. Sweep + two-round upload
    runSu(c, "killall remotecfg", 5000);
    String[] bins = {"/vendor/bin/remotecfg", "remotecfg",
                     "/system/bin/remotecfg", "/system/xbin/remotecfg"};
    boolean anyOk = false;
    for (int round = 0; round < 2; round++) {
        if (round > 0) sleep(3000);
        for (String bin : bins) {
            Result r = runSu(c, bin + " -c /data/remote.cfg -t /data/remote.tab -d", 20000);
            if (r.exitCode == 0) { anyOk = true; break; }
        }
    }
    // 4. Fallback when su is unavailable: direct exec (for an app installed into priv-app)
    ...
}
```

Each step has a clear reason to exist:

- **File-wait loop**: at `BOOT_COMPLETED` time /data is theoretically mounted, but the config files might be placed there later by the user; also the file check must go through `su` — the app itself cannot `stat` files at the `/data` root, and plain `File.exists()` always returns false (another common pitfall).
- **15-second settle delay**: the ROM's four remotecfg instances start en masse around `sys.boot_completed=1` (see §6.3), loading empty configs. If we raced ahead, we'd be overwritten. **The last battle decides the war**, so let the bullets fly first.
- **`killall remotecfg`**: wipe any lingering instances before uploading — double insurance.
- **Two-round upload**: rounds 3 seconds apart; even if some system instance straggles in after our first round, the second round still closes the show. Within a round, candidate paths are tried in order and `exit=0` wins.
- **Candidate path table**: `/vendor/bin/remotecfg` is the path actually present on this device (found during reconnaissance); the bare name `remotecfg` relies on the su session's PATH; the other two are conventional locations. Multiple candidates with the measured one first — no code changes needed when porting to other boxes.
- **Direct-exec fallback**: if the app is later preinstalled into `/system/priv-app` (a common move in box customization), the process itself holds root-level privileges and needs no su at all. This branch lets the same APK run in both deployment forms.

**(c) Process-pipe handling in runSu**

```java
private static Result runSu(Context c, String shellCmd, long timeoutMs) {
    Process p = new ProcessBuilder("su", "-c", shellCmd).start();
    StreamGobbler outG = new StreamGobbler(p.getInputStream());
    StreamGobbler errG = new StreamGobbler(p.getErrorStream());
    outG.start(); errG.start();
    boolean finished = p.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
    if (!finished) { p.destroyForcibly(); /* log timeout (su may be awaiting authorization) */ }
    ...
}
```

Two must-answer questions:

- **Why Gobbler threads?** The child process's stdout/stderr pipe buffers are only a few KB; remotecfg printing the whole key table plus su's own output easily fills them. If nobody drains them, the child blocks writing the pipe while the parent blocks in `waitFor` — a classic deadlock. Two daemon threads continuously draining the pipes are the simplest reliable fix.
- **Why a timeout?** On first root invocation, if the su implementation has interactive authorization (the Magisk dialog), `su` silently waits for the user to tap Allow. A 20-second timeout plus the upper retry loop distinguishes "waiting for authorization" from "real failure": seeing `timeout (su may be awaiting authorization)` in the log tells you to go tap the dialog.

**(d) Logging system**

`appendLog` writes timestamped lines to `getExternalFilesDir()/remotecfg_boot.log` (falling back to internal `getFilesDir()` when external storage is unavailable) and mirrors each line to logcat via `Log.i`. The file lands in `/sdcard/Android/data/com.local.remotecfgboot/files/`, retrievable with a single adb `cat` — far more efficient than chasing logcat every time.

### 4.5 MainActivity.java — UI written in code

The screen is just a title, two buttons (Run now / Clear log), and a scrolling log pane, built entirely in Java code (`LinearLayout` + `Button` + `TextView` + `ScrollView`) with no layout XML — one fewer resource file and the smallest possible resource tree for the Gradle-free build. In `onResume` a `Handler` refreshes the log content every 2 seconds; in `onPause` the refresh stops — standard Android lifecycle discipline.

Looking back at this UI, three design decisions are worth expanding on:

**(a) The "Run now" button is not just a debug feature — it's an operations interface.** The button starts the service with `putExtra("manual", true)`, and `runOnce`, seeing the manual flag, **skips both the 15-second settle delay and the boot file-wait loop** — because a manual trigger by definition happens when the device has fully booted and the config files are already in place; waiting another 15 seconds would be pure waste. This turns the validation cycle after editing `/data/remote.tab` into: adb push the config → open the app → tap the button → try the remote. No reboot, no adb shell; the time-to-effect shrinks from "minutes-long reboot" to "seconds." Had the app been a "boot black box," every iteration in Chapter 6 would have required a device restart and taken at least three times longer.

**(b) The log pane uses a monospace font (`Typeface.MONOSPACE`).** Log content is timestamped event sequences; the user's most common action is scanning for "how many seconds elapsed between boot and SUCCESS, what exit code did exec return." Proportional fonts have variable-width digits that defeat vertical alignment; in monospace the log is naturally tabular. This is the same reason terminal emulators use monospace — any text read line-by-line with vertical alignment expectations has only one correct typeface.

**(c) Handler polling rather than Service-to-Activity broadcasts.** The more "proper" approach would be for the Service to push each log line to the Activity in real time via `LocalBroadcastManager` or Messenger, but that requires androidx (violating the zero-dependency stance) or hand-writing a Binder. Our log is already a file on disk, so the Activity simply re-reads the file tail every 2 seconds — **using "file reading" instead of "inter-process communication" in a single-process app is zero-cost and the least bug-prone option**. A 2-second delay is imperceptible for log viewing. This is also old embedded-debugging wisdom: anything that can be a file should be communicated through a file; real-time IPC is worth its complexity only when truly needed.

---

## 5. The Gradle-Free Hand-Build Pipeline

### 5.1 Why not Gradle

This is one of the most share-worthy parts of the project. Several excellent community practices exist for comparison:

- shkhuz's "An android app from scratch": building with bare `aapt`/`javac`/`d8`, arguing that "to understand the system you must build from first principles," and noting that an empty Android Studio project is already 40-50MB with nearly a thousand files;
- kotlowski's "Building an Android App Without Gradle or Android Studio": observing that "most developers have built hundreds of apps without ever building one by hand";
- Chapters 1–4 of "Extending Android Builds": a hand-build script aligned step-by-step with AGP tasks, an advanced track.

There is also a pragmatic reason: **the dev machine is Windows with only JDK 17 and an existing Android SDK (build-tools 35.0.0 + platforms android-35)** — no Gradle, no Android Studio, and neither is needed. For a "single-module, zero-dependency, minSdk 21" micro-project, Gradle's wrapper download, AGP version matching, and incremental caches are pure overhead. An APK is fundamentally just a ZIP containing a resource table, DEX bytecode, and a signature — every layer of the toolchain should serve that fact.

### 5.2 Toolchain inventory

| Tool | Source | Purpose |
|------|--------|---------|
| JDK 17 | System | `javac` compilation, `jar` packaging, `keytool` key generation |
| aapt2 | build-tools/35.0.0 | Resource compilation and linking |
| d8 | build-tools/35.0.0 | JVM bytecode → Android DEX bytecode |
| zipalign | build-tools/35.0.0 | 4-byte alignment of uncompressed resources (prerequisite for .so loading and resource mmap) |
| apksigner | build-tools/35.0.0 | v1/v2 signing |
| platforms/android-35/android.jar | SDK platforms | **Compile-time classpath only** (API symbols); the device system provides implementations at runtime |

One easily misunderstood point: we compile against android-35's `android.jar` while `targetSdkVersion=28` — `android.jar` provides compile-time symbols only; `targetSdk` decides runtime behavior. The two are decoupled, so we don't need to download platforms;android-28.

### 5.3 The seven-step pipeline (Windows PowerShell transcript)

```powershell
$BT  = "$SDK\build-tools\35.0.0"
$AJ  = "$SDK\platforms\android-35\android.jar"

# ① Resource compilation: res/ XML/PNG → binary .flat bundled into res.zip
& "$BT\aapt2.exe" compile --dir res -o build\res.zip

# ② Resource linking: merge manifest and resources, produce APK skeleton + R.java + resources.arsc
& "$BT\aapt2.exe" link -o build\base.apk -I "$AJ" `
    --manifest AndroidManifest.xml --java build\gen `
    --min-sdk-version 21 --target-sdk-version 28 build\res.zip

# ③ Java compilation: sources + generated R.java → JVM .class
javac -encoding UTF-8 -source 1.8 -target 1.8 -Xlint:-options `
    -classpath "$AJ" -d build\classes `
    build\gen\com\local\remotecfgboot\R.java src\com\local\remotecfgboot\*.java

# ④ Bytecode translation: .class → classes.dex
& "$BT\d8.bat" --release --lib "$AJ" --min-api 21 --output build\dex `
    (Get-ChildItem build\classes\com\local\remotecfgboot\*.class | % FullName)

# ⑤ Merge: stuff the dex into the APK (an APK is a ZIP)
jar -uf build\base.apk -C build\dex classes.dex

# ⑥ Alignment: 4-byte align
& "$BT\zipalign.exe" -f 4 build\base.apk build\aligned.apk

# ⑦ Sign: debug keystore, dual v1+v2 signature
& "$BT\apksigner.bat" sign --ks "$env:USERPROFILE\.android\debug.keystore" `
    --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android `
    --out RemoteCfgBoot.apk build\aligned.apk
& "$BT\apksigner.bat" verify RemoteCfgBoot.apk
```

Principles and pitfalls per step:

- **aapt2's compile/link two-stage design** is the core improvement over old aapt (compile yields intermediate `.flat`; link assigns resource IDs `0x7f…` uniformly and validates the manifest). `--java build\gen` makes it also emit `R.java` — without it, the `R.drawable.ic_launcher` references in Java cannot compile. `-I "$AJ"` is essential: system classes and resources referenced by the manifest are validated against android.jar.
- **javac `-source/-target 1.8`**: d8 can handle newer class file formats, but Android 9's ART supports Java 8 features (lambdas, default methods) most robustly through desugaring. `-Xlint:-options` silences the "source value 8 is obsolete" noise.
- **d8 `--min-api 21`** declares the minimum target API, steering desugaring and instruction rewrites. Output `classes.dex` is about 13KB.
- **jar -uf append**: the base.apk from `aapt2 link` already contains `AndroidManifest.xml`, `resources.arsc`, and `res/`; only the dex is missing. `jar -uf` updates the ZIP in place. targetSdk 30+ mandates "resources.arsc must be uncompressed and aligned," which doesn't apply at targetSdk 28 — but watch for it on new projects before zipalign.
- **zipalign before signing**: apksigner's v2 signature protects the entire ZIP byte range; align-then-sign gives you both (sign-then-align destroys the v2 signature — the easiest ordering trap in hand building).
- **When debug.keystore is missing**, generate one with `keytool -genkeypair` (`-alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US"`), structurally identical to Android Studio's default debug key. Upgrade installs require consistent signatures, so all three iterations use the same key.

Final artifact: **RemoteCfgBoot.apk, 16KB**. Compared to multi-MB outputs of empty Gradle projects, that is the power of zero dependencies.

### 5.4 Mapping to the Gradle/AGP pipeline

| Manual step | Corresponding AGP Task |
|-------------|------------------------|
| aapt2 compile | inside `:app:mergeResources` / `:app:compileReleaseResources` |
| aapt2 link | `:app:processReleaseResources` |
| javac | `:app:compileReleaseJavaWithJavac` |
| d8 | `:app:dexBuilderRelease` |
| jar -uf + zipalign | `:app:mergeReleaseAssets` + `:app:zipalignRelease` |
| apksigner | `:app:validateSigningRelease` + inside `:app:assembleRelease` |

Once you understand the manual pipeline, that long task list in Gradle build logs is no longer a black box.

### 5.5 What's inside the APK: dissecting the artifact

Let's deconstruct the final product and verify "an APK is a ZIP":

```text
RemoteCfgBoot.apk (16 KB)
├── AndroidManifest.xml      # compiled to binary XML (can't cat it; use aapt2 dump)
├── resources.arsc           # resource index table (string/drawable ID → offset mapping)
├── classes.dex              # DEX bytecode of all Java code (about 13KB)
├── res/drawable-*/ic_launcher.png
└── META-INF/
    ├── MANIFEST.MF          # v1 (JAR) signature: SHA-1 digest of every file
    ├── CERT.SF / CERT.RSA   # signature of the digest manifest + certificate
    └── (the v2 signing block lives in a special region before the ZIP central directory, not an entry)
```

Two points about the signing mechanisms are worth expanding:

- **v1 signing (JAR Signing)** covers only the individual ZIP entries; an attacker could append unsigned files to the APK without v1 noticing (part of the famous Janus vulnerability family). **v2 signing (APK Signing Scheme)** digests the entire file content and writes it into the APK signing block; any byte change fails verification. Android 7.0+ checks both, and on Android 9 the v2 signature must be intact — the root of the "zipalign before signing" iron rule: alignment changes file bytes and must happen before signing.
- **Why d8 instead of old dx**: dx is officially deprecated; d8 produces smaller, faster DEX, natively supports Java 8 desugaring, and ships with build-tools 26+. For a manual pipeline the invocation is nearly identical — there's no reason to use the old tool.

`aapt2 dump badging RemoteCfgBoot.apk` also verifies the manifest as expected (package name, permissions, launchable activity, SDK versions). It is the final self-check before signing; after every iteration we ran it to confirm the version number actually changed — avoiding the low-level accident of "edited code, forgot to bump versionCode, install -r rejected."

---

## 6. Three Iterations of Debugging

This is the core of the article. Three iterations, three failure modes, each driven through the scientific path of "hypothesis → evidence → reproduction → fix → verification."

### 6.1 v1.0: installed fine, nothing happened at boot

**Symptom**: after the first install and a manual reboot, the in-app log showed:

```text
received android.intent.action.BOOT_COMPLETED
startService failed: java.lang.IllegalStateException: Not allowed to start
service Intent { cmp=com.local.remotecfgboot/.RunService }: app is in background
uid UiRecord{7b0dcd6 u0a38 RCVR idle change:idle|uncached procSeq:0}
```

**Good news**: the broadcast was received — the `RECEIVE_BOOT_COMPLETED` permission and receiver registration were correct.
**Bad news**: `startService` was rejected on the spot.

**Anatomy** (per the official "Background Execution Limits" doc): since Android 8.0, background apps are forbidden from calling `startService` to create a background service (`IllegalStateException`); the system defines "foreground" as having a visible activity, a foreground service, or being bound by another foreground app. By design, an app receiving `BOOT_COMPLETED` is put on a **temporary allowlist** that permits the call — but this is "system benevolence," not a contractual guarantee, and ROMs (especially heavily modified TV-box ROMs) implement it unevenly. This device is in the "doesn't implement it" camp.

**Fix (v1.1)**: switch to `startForegroundService()`, the API purpose-built for background scenarios — exempt from the background restriction, at the price of calling `startForeground()` with a foreground notification within 5 seconds. To do that:

1. Add `<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>` to the manifest;
2. Call `startForeground(1, notification)` as the first line of `onStartCommand`;
3. Call `stopForeground(true)` + `stopSelf()` when done — the notification flashes for a few seconds and disappears, an acceptable cost of the approach;
4. Wrap the receiver's `startForegroundService` call in try-catch; on failure, `goAsync()` and execute directly in the broadcast window as the last fuse.

### 6.2 v1.1: the command "succeeded," but the remote didn't change

**Symptom**: after reboot the log looked flawless:

```text
received android.intent.action.BOOT_COMPLETED
==== BOOT trigger ====
wait[1] exit=0 out=READY err=
exec: su -c "remotecfg -c /data/remote.cfg -t /data/remote.tab -d"
  exit=0 out=cfgdir = /data/remote.cfg work_mode = 0 ... map_size = 12
      key[0] = 0x460067 key[1] = 0x16006c ...(full 12-key table)
```

Exit code 0, and remotecfg even printed our fully parsed key table. **But the IR remote didn't change at all** — instead, "open the app, tap 'Run now,' and only then does the remote switch to the custom mappings."

The lesson of this round is methodological: **`exit=0` proves only that the process ran to completion, not that the effect took hold.** Between successful execution and actual effect lay a whole unknown territory. Time for real reconnaissance — fortunately the device had network ADB, so the dev machine could inspect the scene directly.

### 6.3 v1.2 investigation: a five-instance race and the ps-matching trap

**Step 1: getprop to map the system's remote services.**

```bash
adb shell "getprop | grep -i remote"
# [init.svc.load_remote]:  [stopped]
# [init.svc.remotecfg]:    [stopped]
# [init.svc.remotecfg7]:   [stopped]
# [init.svc.remotecfg8]:   [stopped]
# [ro.boottime.load_remote]:  [12933563504]   ← started about 12.9s after kernel start
# [ro.boottime.remotecfg]:    [12921906088]
# ...
```

Four `init.svc.*` properties mean the ROM contains four remote-related init services, all started around 12.9 seconds into boot, all stopped now.

**Step 2: read the rc definitions and reconstruct the boot-time battle.**

In `/vendor/etc/init/hw/init.amlogic.rc` (the main Amlogic platform rc):

```bash
service remotecfg  /vendor/bin/remotecfg /vendor/etc/remote.conf      # class main, oneshot
service remotecfg7 /vendor/bin/remotecfg -t /vendor/etc/remote.tab7   # class main, oneshot
service remotecfg8 /vendor/bin/remotecfg -t /vendor/etc/remote.tab8   # class main, oneshot

# Custom IR Remote Auto-Load
service load_remote /vendor/bin/remotecfg -c /vendor/etc/custom_remote.cfg -t /vendor/etc/custom_remote.tab
    oneshot
on property:sys.boot_completed=1
    start load_remote

# Direct Force Load Remote CFG
on boot
    exec -- /vendor/bin/remotecfg -c /vendor/etc/custom_remote.cfg -t /vendor/etc/custom_remote.tab
```

And `/system/etc/init/load_remote.rc` conspicuously contains another copy:

```bash
service load_remote /vendor/bin/remotecfg -c /data/remote.cfg -t /data/remote.tab
    class main
    user root
    group root
    oneshot
on property:sys.boot_completed=1
    start load_remote
```

Clearly the ROM author (or a previous modifier) intended approach A — "load the /data remote config at boot" — but it **never takes effect**: Android 9's init parses rc files in a fixed order (/init.rc and its imports → /system/etc/init → /vendor/etc/init); the name `load_remote` was first registered by `init.amlogic.rc` pointing at the **custom_remote (empty) config** version, and the later `/system/etc/init/load_remote.rc` is **ignored outright due to the duplicate service name**. This is the classic "I wrote an rc file but nothing happened" trap.

More dramatically, `custom_remote.cfg` and `custom_remote.tab` are **empty files** on the device. So at boot up to five remotecfg instances launch in sequence: the `on boot` exec, `load_remote`, `remotecfg/7/8` (class main), plus our app — **they race within a few seconds around `sys.boot_completed=1`, and whoever uploads last owns the keymap**. Our app sprinted within 1 second of the broadcast and was then overwritten by some system instance (or chain of them) — perfectly explaining "exit=0 but the remote didn't change."

**Step 3: the trap in ps inspection.**

To determine "is the daemon alive," I ran:

```bash
adb shell "ps -A | grep -i remote"
```

The output included a line `u0_a51 ... com.local.remotecfgboot` — that's **our own app process**! The package name contains the string "remotecfg," so grep matched it. Then I wrote a polling script counting `ps -A | grep remotecfg | grep -v grep | wc -l`, which consistently reported 1 — I briefly believed the daemon was stably alive, contradicting another observation of "gone after 3 seconds," and the investigation descended into confusion.

After waking up, I switched to a **full cmdline scan** to eliminate name-based misdirection:

```bash
for d in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < $d/cmdline 2>/dev/null)
  case "$c" in *remotecfg*) echo "$d: $c";; esac
done
```

Result: **zero matches** apart from the app itself. This remotecfg build leaves **no resident process at all** after uploading the keymap (see §2.4); both "gone after 3s" and "alive after 30s" were misreadings induced by grep — the truth is it was never resident, yet the remote kept working precisely because the keymap lives in the kernel.

> This is the experience I most want to share: **in embedded troubleshooting, suspect your observation tools first.** `ps | grep` is the handiest weapon and the one most likely to feed you poisoned bullets — package-name matches, grep self-matching, and `wc` in a pipe can all turn one into zero or one into three.

**Step 4: nail the model with a user test.** I ran remotecfg manually via adb (a few minutes earlier during the investigation) and asked the user to test with the physical remote: **the custom mappings were active and stayed active**. Combining "no process" with "durable effect" nailed the model: upload into the kernel, exit, last upload wins.

Looking back, what actually worked in this investigation was a plain checklist where each question mapped to one evidence-gathering action:

| Question | Evidence action | Conclusion |
|----------|-----------------|------------|
| Who else manages the remote? | `getprop \| grep remote` | 4 init services |
| When do they start? | `ro.boottime.*` | 12.9s into boot, same window as BOOT_COMPLETED |
| What configs do they load? | Read the rc files | custom_remote (empty files) |
| Why didn't our rc work? | Grep service names everywhere | Duplicate name ignored by init |
| Is the daemon alive? | Full `/proc/*/cmdline` scan | Never resident |
| Is the effect durable? | Timed user tests | Durable; upload takes effect immediately |
| Who overwrote whom? | Timing alignment analysis | Last upload wins |

The pattern in this table is worth remembering: **every step of embedded debugging should be "one falsifiable question + one single-variable evidence command,"** not the voodoo loop of "reboot and see." The entire v1.2 investigation took under an hour because network ADB let every hypothesis be verified or falsified within 30 seconds.

**Step 5: the targeted fix (v1.2 final).**

Since the decisive factor is "upload last," a four-part fix:

1. **15-second settle delay** (boot path only): wait for all system instances to finish; we don't sprint — we close the show;
2. **`killall remotecfg` sweep**: send off any surviving instances before uploading;
3. **Two-round upload**: two rounds 3 seconds apart against any latecomer;
4. **Candidate paths led by `/vendor/bin/remotecfg`**: the measured shortest path first.

**Step 6: closed-loop verification.** Rebuild, reinstall, `adb reboot`, then pull the log after boot:

```text
23:33:25 received BOOT_COMPLETED
23:33:25 ==== BOOT trigger ====
23:33:25 wait[1] exit=0 out=READY
23:33:25 boot settle delay 14s
23:33:40 exec(round0): su -c "/vendor/bin/remotecfg -c /data/remote.cfg -t /data/remote.tab -d"  exit=0 (12-key table)
23:33:43 exec(round1): su -c "/vendor/bin/remotecfg ..."  exit=0
23:33:43 SUCCESS
```

The user confirmed the physical remote mappings were correct. **Fully automatic, maintenance-free, effective at boot** — goal achieved.

---

## 7. Comparison with Community Approaches

### 7.1 The three schools of Amlogic remote customization

Synthesizing the CoreELEC Wiki, LibreELEC forums, and Chinese communities, there are three technical routes for changing remote mappings:

| School | Platform | Principle | Pros | Limits |
|--------|----------|-----------|------|--------|
| **remotecfg + remote.cfg/tab** (this article) | Android firmware | Userspace tool decodes NEC etc., maps by table, injects | Natively supported on Android, no kernel changes; config in `/data` is editable anytime | Competes with ROM-bundled services (the main pitfall here); BSP version behavior varies |
| **ir-keytable + rc_maps.cfg** | CoreELEC/LibreELEC (Linux) | The kernel RC core maintains the keymap; `ir-keytable -a` loads it | Standardized; `-t` capture is excellent UX; decoupled from userspace | Linux-class firmwares only; driver support is incomplete under Android BSPs |
| **Kernel dts / built-in keymap modification** | Deep customization | Edit the device tree or IR driver's built-in table | Once and for all, no userspace dependency | Requires rebuilding the kernel; highest barrier |

Notable points of convergence: the LibreELEC thread's "remotecfg remote.conf hot reload" (edit and apply instantly without rebooting) is the same move as our "Run now" button; the CoreELEC workflow of "capture with `ir-keytable -t`, then fill the table" applies equally on Android — the first column of `/data/remote.tab` was obtained that way.

### 7.2 The community map of boot-autostart approaches

Chinese-community material (CSDN keep-alive surveys, HelloDaemon, ServiceDaemon) catalogs over a dozen techniques: BOOT_COMPLETED, START_STICKY, foreground-service elevation, dual-process AIDL guardians, JobScheduler resurrection, account-sync resurrection, push-channel resurrection, vendor whitelist guidance… These target **resident services surviving the mincemeat of background-task killing on domestic ROMs**.

The essential difference for our scenario bears repeating: **a one-shot task with a persistent result**. So the solution space collapses to two routes:

- System level: init.rc / Magisk scripts (no background restrictions whatsoever, but no UI, no logs, easily wiped by ROM updates);
- App level: BOOT_COMPLETED + startForegroundService (our choice, complete with logs and manual trigger; depends on root for privileged commands).

There is also the WorkManager school in official docs (`setExpedited` expedited jobs, persistent scheduling, automatic resumption after reboot), suited to "deferred, constrained, retryable" background work; but WorkManager's post-reboot resumption has minute-level delays and no immediacy guarantee, which loses to BOOT_COMPLETED for "take effect ASAP after boot." The minSdk 21 + zero-dependency stance also makes a hand-written broadcast preferable to pulling in androidx.

Expanding on WorkManager's exclusion, there are actually three layers:

1. **Timing layer**: WorkManager's persistent jobs are resumed after reboot at the system's discretion, depending on idle/charging/network constraints; the docs explicitly say execution is not exact or immediate. Our benchmark is the ROM's own init services, which finish uploading within a dozen seconds. A slower app means the remote "does nothing" for the first minute or two after boot — perceptually a failure.
2. **Permission layer**: even when resumed, `su -c remotecfg` still passes through runtime `su` authorization. WorkManager runs in a system-scheduled process context far from the foreground UI — if the authorization dialog is ignored after first install, the job silently retries and fails in the background while the user has no idea. On the BOOT_COMPLETED path at least we have a log file.
3. **Mental-model layer**: WorkManager solves "the task must reliably complete"; our core difficulty is "the task must run at the right time and in the right order" — the settle delay, killall sweep, and two-round retry are hand-written timing controls regardless of the scheduling framework. The framework protects the floor; it cannot save timing.

A fourth school often mentioned: the rumor that **static `BOOT_COMPLETED` receivers are restricted under "implicit broadcast exceptions" on Android 11+** — in fact `BOOT_COMPLETED` has always been on the exemption list. The real things to watch are domestic-ROM autostart managers (requiring the user to grant "autostart") and unknown-source app policies on TV systems. This device runs a near-AOSP Amlogic box system with no such trouble, but readers replicating on Xiaomi/Huawei-style ROMs should check the autostart whitelist first.

### 7.3 Compared with other "hand-built APK" posts

| Dimension | shkhuz "An android app from scratch" | kotlowski's post | eab.2bab "Building An Apk Manually" | This article |
|-----------|--------------------------------------|------------------|--------------------------------------|--------------|
| Platform | Linux | Linux/WSL | Ubuntu/macOS | **Windows PowerShell** |
| Resource tool | old aapt | aapt2 | aapt2 | **aapt2** |
| Example complexity | Hello World | Hello World | Template project | **Real functional app (service/receiver/notification/subprocess)** |
| Iteration | One-shot | One-shot | Teaching-oriented | **Three versions + real-device debugging loop** |

All three references demonstrate the pipeline at the "Hello World" level; this article pushes it to a real deliverable: version iterations, signature management (same key across versions for `install -r` upgrades), and a complete "build → install → reboot → pull logs → regression" loop. The value of hand-building is not replacing Gradle — it's that **when Gradle breaks, you know what's underneath**.

---

## 8. Key Takeaways and Pitfall Checklist

1. **BOOT_COMPLETED ≠ service launch permission**. On Android 8.0+, background `startService` throws `IllegalStateException`; the temporary allowlist is not honored on some custom ROMs. `startForegroundService` + `startForeground` within 5 seconds is the contractual approach.
2. **The foreground notification is a pass, not a feature** — call `stopForeground + stopSelf` immediately when done.
3. **`goAsync()` is emergency-only for ~10 seconds**; you must call `PendingResult.finish()` on timeout or face a broadcast ANR.
4. **A normal app cannot stat files at the /data root**; `File("/data/remote.cfg").exists()` is always false — existence checks must run through `su` with `test -f`.
5. **Child pipes must be drained** or waitFor deadlocks; first-time su authorization may wait forever, so timeouts are mandatory.
6. **`ps | grep` lies**: keyword-containing package names and grep self-matches pollute observation. Scanning `/proc/*/cmdline` is more reliable.
7. **Android 9 init rejects duplicate service names**: later rc service definitions are silently ignored. Before adding an rc file, `grep -rn "service name" /system/etc/init /vendor/etc/init` for collisions.
8. **remotecfg (on this device) is an uploader, not a daemon**; the keymap lives in the kernel and the process exiting does not undo it. BSP versions differ — always measure.
9. **Boot init services launch en masse around `sys.boot_completed=1`**, in nearly the same window as BOOT_COMPLETED — app-level boot tasks competing with system services need delay + sweep + double-insurance retry.
10. **`exit=0` ≠ in effect**. Automated tasks need observable verification (here: logs + physical key tests).
11. **zipalign before apksigner** or the v2 signature is destroyed; a consistent debug signature across versions is required for `adb install -r` upgrades.
12. **Network ADB is the TV-box developer superpower**: scrcpy/escrcpy screen mirroring + adb shell on-site reconnaissance + remote install/reboot loop, all without touching the device.

### 8.1 The general principles behind some pitfalls

Some items deserve individual treatment because they are universal system-design knowledge, not just "this ROM's quirks."

**On the design philosophy of background limits**: Android 8.0's background service restriction is a product decision, not a technical defect — the system cannot distinguish "valuable background work" from "services stealing data," so it demands that all background work go through either JobScheduler (system-scheduled, battery-friendly) or a foreground service (user-visible, responsibility on you). `startForegroundService` is the front door opened by this policy; the temporary allowlist is mere benevolence, and the reliability gap between the two on third-party ROMs is enormous. For TV-box development, default to the front door.

**On init.rc service name collisions**: init parses rc files in a first-registered-wins, swallow-the-rest fashion — the first definition lands in the service table; later same-name sections are silently discarded (with just one ERROR line to logd). No error to the author, no crash, no user-visible trace beyond `init.svc`. Hence the mandatory "service-name collision check" before adding rc files, and the practical rule of brand-prefixing component names (had we taken the rc route, the service should be `load_remote_data`, not `load_remote`).

**On su sessions and process groups**: although remotecfg ultimately proved to be an upload-type tool with no survival concerns, this pitfall is worth recording: most su implementations (Magisk, daemonsu family) clean up child process groups/sessions after the authorized command exits; a backgrounded `su -c "xxx &"` without the double insurance of `setsid`/`nohup` may be reaped along with the su session. The robust form for a persistent root process is:

```bash
su -c "setsid nohup <command> > /dev/null 2>&1 &"
```

**On the toxicity of observation tools**: the three traps of `ps | grep` (keyword in package names, grep self-matching, ambiguous `wc -l` semantics) are all instances of one problem — the observation contaminates the observed. More robust alternatives are case-matching against the full contents of `/proc/<pid>/cmdline` (see the §6.3 script) or precise `pgrep -f` patterns. In any automation script that "counts processes," two extra lines to exclude false positives always pay off.

### 8.2 An action checklist for readers with similar needs

If you also have an Amlogic box whose IR remote you want to customize (or on which you want to run a command at boot), follow this order to avoid every pitfall in this article:

1. **Confirm the privilege environment**: `adb shell su -c id` — is root available, where is su, is interactive authorization required?
2. **Map the remote-service landscape**: `getprop | grep -i remote` + `grep -rn remotecfg /system/etc/init /vendor/etc/init`; list all competitors and their config files;
3. **Determine the remotecfg type**: run the target command manually and immediately scan `/proc/*/cmdline` to tell resident from uploading;
4. **Manually validate the config**: confirm the remote works right after execution and keeps working until reboot — only then automate;
5. **Choose the automation approach**: this APK if you want a UI/removability; a Magisk module script if Magisk is available; init.rc if you can edit the system partition and accept redoing it after ROM changes (remember the collision check);
6. **The boot-path trio**: delay (wait for system instances) + sweep (killall) + two-round retry (insurance), with logging throughout;
7. **Closed-loop verification**: after reboot, read the log first, then press the remote — both log SUCCESS and physical key behavior must pass.

---

## 9. Appendix: Full Source and Deployment Commands

### 9.1 Project file tree

```text
RemoteCfgBoot/
├── AndroidManifest.xml
├── res/
│   ├── drawable/ic_launcher.png
│   └── values/strings.xml
├── src/com/local/remotecfgboot/
│   ├── BootReceiver.java
│   ├── RunService.java
│   └── MainActivity.java
└── build.sh (PowerShell build script, see §5.3)
```

### 9.2 RunService.java (v1.2 complete core)

```java
public class RunService extends Service {
    private static final String CHANNEL_ID = "remotecfg_run";

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "remotecfg",
                    NotificationManager.IMPORTANCE_MIN));
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        final boolean manual = intent != null && intent.getBooleanExtra("manual", false);
        Notification n = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL_ID)
                        .setSmallIcon(R.drawable.ic_launcher)
                        .setContentTitle("RemoteCfg")
                        .setContentText("Running remotecfg ...")
                        .setOngoing(true).build()
                : new Notification.Builder(this)
                        .setSmallIcon(R.drawable.ic_launcher)
                        .setContentTitle("RemoteCfg")
                        .setContentText("Running remotecfg ...")
                        .setOngoing(true).build();
        startForeground(1, n);

        final Context ctx = this;
        new Thread(() -> {
            try { runOnce(ctx, manual); }
            finally { stopForeground(true); stopSelf(); }
        }, "remotecfg-runner").start();
        return START_NOT_STICKY;
    }

    public static void runOnce(Context c, boolean manual) {
        long start = android.os.SystemClock.elapsedRealtime();
        appendLog(c, "==== " + (manual ? "MANUAL" : "BOOT") + " trigger ====");

        // 1. Wait until the /data config files are ready (must check via su; the app cannot stat /data)
        boolean filesReady = false;
        for (int i = 1; i <= 10 && !filesReady; i++) {
            Result r = runSu(c, "test -f /data/remote.cfg -a -f /data/remote.tab && echo READY", 8000);
            appendLog(c, "wait[" + i + "] exit=" + r.exitCode + " out=" + r.out.trim());
            if (r.exitCode == 0 && r.out.contains("READY")) filesReady = true;
            else sleep(3000);
        }

        // 2. Boot path: 15s settle so all ROM-bundled remote instances finish before our final upload
        if (!manual) {
            long settle = 15000 - (android.os.SystemClock.elapsedRealtime() - start);
            if (settle > 0) { appendLog(c, "boot settle delay " + settle/1000 + "s"); sleep(settle); }
        }

        // 3. Sweep + two-round upload
        runSu(c, "killall remotecfg", 5000);
        String[] bins = {"/vendor/bin/remotecfg", "remotecfg",
                         "/system/bin/remotecfg", "/system/xbin/remotecfg"};
        boolean anyOk = false;
        for (int round = 0; round < 2; round++) {
            if (round > 0) sleep(3000);
            for (String bin : bins) {
                String cmd = bin + " -c /data/remote.cfg -t /data/remote.tab -d";
                appendLog(c, "exec(round" + round + "): su -c \"" + cmd + "\"");
                Result r = runSu(c, cmd, 20000);
                appendLog(c, "  exit=" + r.exitCode + " out=" + r.out.trim() + " err=" + r.err.trim());
                if (r.exitCode == 0) { anyOk = true; break; }
            }
        }

        // 4. Fallback: direct exec without su when the app holds high privileges (priv-app)
        if (!anyOk) {
            for (String bin : bins) {
                if (!bin.startsWith("/")) continue;
                try {
                    Process p = new ProcessBuilder(bin, "-c", "/data/remote.cfg",
                            "-t", "/data/remote.tab", "-d").redirectErrorStream(true).start();
                    boolean fin = p.waitFor(20, java.util.concurrent.TimeUnit.SECONDS);
                    int code = fin ? p.exitValue() : -1;
                    if (!fin) p.destroyForcibly();
                    if (code == 0) { anyOk = true; break; }
                } catch (Exception e) { appendLog(c, "direct exec failed: " + e); }
            }
        }
        appendLog(c, anyOk ? "SUCCESS" : "FAILED: all attempts failed");
    }

    private static Result runSu(Context c, String shellCmd, long timeoutMs) {
        Result r = new Result();
        try {
            Process p = new ProcessBuilder("su", "-c", shellCmd).start();
            StreamGobbler outG = new StreamGobbler(p.getInputStream());
            StreamGobbler errG = new StreamGobbler(p.getErrorStream());
            outG.start(); errG.start();
            boolean fin = p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS);
            if (!fin) { p.destroyForcibly(); r.exitCode = -1; r.err = "timeout (su may be awaiting authorization)"; }
            else r.exitCode = p.exitValue();
            outG.join(1000); errG.join(1000);
            r.out = outG.text.toString(); r.err += errG.text.toString();
        } catch (Exception e) { r.exitCode = -1; r.err = String.valueOf(e); }
        return r;
    }

    private static class Result { int exitCode = -1; String out = "", err = ""; }

    private static class StreamGobbler extends Thread {
        private final java.io.InputStream is;
        final StringBuilder text = new StringBuilder();
        StreamGobbler(java.io.InputStream is) { this.is = is; setDaemon(true); }
        @Override public void run() {
            try (BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"))) {
                String line;
                while ((line = br.readLine()) != null) synchronized (text) { text.append(line).append('\n'); }
            } catch (IOException ignored) {}
        }
    }

    public static void appendLog(Context c, String line) { /* timestamp + Log.i + file persistence */ }
    public static File logFile(Context c)   { /* getExternalFilesDir preferred, internal storage fallback */ }
    public static String readLog(Context c) { /* displayed by MainActivity */ }
}
```

(`BootReceiver` and `MainActivity` are in §4.3 / §4.5; `AndroidManifest.xml` is in §4.2.)

### 9.3 Deployment and maintenance cheat sheet

```bash
# Install/upgrade (overwrite works with a consistent signature)
adb connect <box-ip>:5555
adb install -r RemoteCfgBoot.apk

# Verify boot behavior: pull the log after reboot
adb shell su -c "cat /sdcard/Android/data/com.local.remotecfgboot/files/remotecfg_boot.log"

# Refresh manually after changing mappings (no reboot needed)
adb shell am startservice -n com.local.remotecfgboot/.RunService --ei manual true
# Or just tap "Run now" in the app UI

# Investigate remote competitors
adb shell "getprop | grep -i remote"
adb shell su -c "grep -rn remotecfg /system/etc/init /vendor/etc/init"
```

### 9.4 Known limitations and future directions

- Depends on root (su); priv-app deployment may require `seclabel` or SELinux policy adjustments;
- The 15-second settle delay is a conservative value measured on this device's ROM; tune it from the logs when porting;
- Could read a "custom delay config" from the app's private directory to externalize timing parameters;
- If a future ROM raises the targetSdk floor to 30+, `resources.arsc` alignment and foreground-service-type declarations become new constraints.

Elaboration on several limitations:

**On the nature of the root dependency.** The app's privilege boundary has exactly one point — `su -c` to run remotecfg and `test -f`. Root here is not "bypassing permissions" but a **cross-boundary read/write pass**: under the Android security model an ordinary app simply cannot touch the `/data` root (the system data area), no matter what permissions it declares. A future root-free version would not rely on permission magic but on moving the config files somewhere the app can access (e.g. `getExternalFilesDir()`) and then making the system remotecfg read from there — which loops back to init.rc modification. You cannot save effort on both ends.

**On the fragility of the settle delay.** 15 seconds is measured from "the five init instances on this ROM start around 12.9 seconds" (see the `ro.boottime.*` data in §6.3). Its essence is **trading time for certainty** — there is no atomic signal telling you "the last competitor has finished." A more engineered approach would poll: run `getprop init.svc.remotecfg` via su every second until its value becomes `stopped`, then wait 2 more seconds, shrinking the fixed delay to the actual needed time. The app doesn't do this layer, deliberately keeping complexity within an explainable range.

**On a heads-up for targetSdk 30+.** Android 11 mandates `resources.arsc` compression alignment (beyond zipalign, aapt2 link needs matching `--min-sdk-version` parameters); Android 14 requires foreground services to declare a type (e.g. `dataSync`) plus the corresponding permission. These don't affect this article's core skeleton (broadcast + foreground service + su), but they add two parameters to the Chapter 5 pipeline. Here the benefit of hand-building shows: **when a step changes, you see exactly where.**

---

## 10. References

1. Android official docs — "Background Execution Limits": <https://developer.android.com/about/versions/oreo/background> (Android 8.0 background service limits and the `startForegroundService` 5-second rule)
2. Android official docs — "AAPT2": <https://developer.android.com/tools/aapt2> (aapt2 compile/link two-stage resource compilation, command-line usage)
3. Android official docs — "WorkManager": <https://developer.android.com/topic/libraries/architecture/workmanager> (persistent background work and restart-resumption semantics)
4. CoreELEC Wiki — "Walk through: Create an Amlogic remote.conf file": <https://wiki.coreelec.org/remote:rr_walkthrough> (factory_code = custom_code(16bit)+index_code(16bit) structure, IRMP capture workflow)
5. LibreELEC forum — "Create remote.conf from scratch" (ippon, 2017): <https://forum.libreelec.tv/thread/3581-create-remote-conf-from-scratch/> (full official field annotations for remote.conf, the `remotecfg remote.conf` hot-reload trick)
6. CoreELEC forum PDF — "How Configure a Remote Control In CoreELEC Using Windows and Putty": <https://discourse.coreelec.org/uploads/default/original/1X/00c45cd5a77202251eb427fd3299d7a43df8b68a.pdf> (ir-keytable -t capture → rc_maps.cfg, the kernel-side approach)
7. shkhuz — "An android app from scratch": <https://shkhuz.github.io/blog/an-android-app-from-scratch.html> (a complete Linux pipeline and motivation for Gradle-free hand-built APKs)
8. kotlowski — "Building an Android App Without Gradle or Android Studio": <https://kotlowski.hashnode.dev/building-an-android-app-without-gradle-or-android-studio.md> (semantics of each aapt2 → javac → d8 step)
9. 2BAB (El Zhang) — "Extending Android Builds", Chapters 1–4, "Building An Android App by Hand": <https://eab.2bab.com/doc/01/1-4-Build-An-Apk-Manually.html> (a manual build script aligned with AGP tasks; Ubuntu/macOS)
10. CSDN — "Summary of Android Service keep-alive methods" and the open-source projects HelloDaemon / ServiceDaemon: a panorama of resident-service keep-alive approaches (differentiation from our scenario discussed in §7.2)

---

*The end. If this article saved you a detour, feel free to borrow its troubleshooting mindset — above all this line: suspect your observation tools before you suspect the system.*
