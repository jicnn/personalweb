---
publishDate: 2026-10-04
draft: false
featured: true
title: "从一个红外遥控需求到开机自启 APK —— S905L2 安卓 9 盒子遥控定制完整开发实录"
excerpt: "在 Amlogic S905L2 安卓 9 盒子上，用一个 16KB 免 Gradle 手工构建 APK 实现开机自动执行 remotecfg。三轮迭代踩穿 BOOT_COMPLETED 后台限制、init.rc 服务重名、开机竞争与 ps 匹配陷阱。"
tags: ['Android', 'Amlogic', 'APK构建', '嵌入式', '红外遥控', '开机自启']
categories: ['embedded', 'android']
---

> 设备：Amlogic S905L2 电视盒子 / Android 9 (armv7) / 已 root / 网络ADB可达
> 目标：开机后自动执行 `remotecfg -c /data/remote.cfg -t /data/remote.tab -d`，让红外遥控按自定义键位工作
> 成果：一个 16KB 的免 Gradle 手工构建 APK（v1.2），开机全自动生效
> 本文关键词：`BOOT_COMPLETED`、`startForegroundService`、`aapt2/d8/apksigner`、`remotecfg`、`init.rc`、开机竞争

---

## 目录

1. [背景与需求分析](#1-背景与需求分析)
2. [先弄懂"对手"：Amlogic 红外遥控框架](#2-先弄懂对手amlogic-红外遥控框架)
3. [方案选型：为什么是"APK + BOOT_COMPLETED"](#3-方案选型为什么是apk--boot_completed)
4. [APK 工程结构逐文件解析](#4-apk-工程结构逐文件解析)
5. [无 Gradle 手工构建流水线](#5-无-gradle-手工构建流水线)
6. [三轮迭代调试实录](#6-三轮迭代调试实录)
7. [网络同类方案整合与对比](#7-网络同类方案整合与对比)
8. [关键知识点与踩坑清单](#8-关键知识点与踩坑清单)
9. [附录：完整源码与部署命令](#9-附录完整源码与部署命令)
10. [参考资料](#10-参考资料)

---

## 1. 背景与需求分析

### 1.1 需求的原貌

手头有一台 Amlogic S905L2 方案的安卓电视盒子，刷的是 Android 9（API 28）的第三方 ROM，armv7 架构，开发者模式开着，能通过网络 ADB 连接（`adb connect 192.168.1.104:5555`），系统内置了 `su`（位于 `/system/xbin/su`，`id` 显示 `uid=0(root) context=u:r:su:s0`，是 userdebug 型调试 ROM 常见的"内置越权 su"）。

需求一句话就能说清：

> **开机后（/data 挂载完成后）自动执行一次 `remotecfg -c /data/remote.cfg -t /data/remote.tab -d`。**

其中两个配置文件在 `/data` 分区根目录：

- `/data/remote.cfg` —— 遥控协议参数（工作模式、重复键开关、调试开关等）
- `/data/remote.tab` —— 扫描码到 Linux 键值的映射表

我最初的想法很天真："不就是开机跑条命令吗？"事实证明，这条命令背后牵出了 **Android 8.0 后台执行限制、init.rc 服务重名机制、Amlogic 遥测框架的"上传即退出"模型、ps 匹配陷阱** 等一连串深水区问题。整个开发经历了三个版本迭代（v1.0 → v1.2），每一轮都推翻一次认知。

### 1.2 把需求翻译成技术语言

拆解这条需求，实际上隐含了四个技术约束：

| # | 约束 | 对应的技术点 |
|---|------|-------------|
| 1 | "开机后" | 需要一个开机时机钩子：`BOOT_COMPLETED` 广播，或 init.rc 服务，或 Magisk 开机脚本 |
| 2 | "/data 挂载后" | `BOOT_COMPLETED` 天然满足（系统在 /data 挂载、用户解锁后才发），但保险起见仍需轮询确认文件存在 |
| 3 | "运行 remotecfg" | 二进制已在设备 `/vendor/bin/remotecfg`，普通 app 无权访问 `/data/remote.cfg`，必须以 root 身份执行 → `su -c` |
| 4 | "是一个 APK" | 用户明确要 APK 形态交付：可安装、可卸载、不依赖刷机 |

第 3 条值得展开：`/data` 根目录在 Linux 权限模型下是 `root:root 0711`，普通 app 进程（`untrusted_app` SELinux 域）连 `stat` 那两个配置文件都做不到。所以 app 内部的执行链路必然是：

```text
app 进程 (u0_aXX) → fork → exec "su" → su 提权 → sh -c "remotecfg ..." → root 身份执行
```

这也解释了为什么这个 APK 离不开 root 环境——它本质上是"给有 root 的盒子用的开机脚本管理器"。

### 1.3 交付物定义

- 最小化 APK：minSdk 21（兼容 Android 5+），targetSdk 28（匹配 Android 9，规避更高 target 才有的额外限制）
- 无界面依赖：UI 仅保留一个日志窗口和"立即执行"按钮，用于排查
- 全链路日志：每一步 exec 的退出码、stdout、stderr 都落盘，现场可查
- 免构建工具链依赖：源码 + 一套 shell 命令即可在任何装了 Android SDK 的机器上重新构建

---

## 2. 先弄懂"对手"：Amlogic 红外遥控框架

写任何自动化脚本之前，先搞清楚目标程序的工作机理，否则排查问题时会完全失去方向。这一节先讲 Amlogic 平台的红外遥控框架，再解析两个配置文件——这部分参考并整合了 CoreELEC Wiki 的 remote.conf 编写教程和 LibreELEC 论坛的经典帖《Create remote.conf from scratch》。

### 2.1 整体链路：从物理红外到 Android 按键事件

```text
遥控器 (NEC 红外协议)
   │  红外光
   ▼
盒子 IR 接收头
   │  电平脉冲
   ▼
内核 meson-ir 驱动（Amlogic IR 解码器，硬件/软件解码）
   │  /dev/input/eventX  ← 原始扫描码 (scancode)
   ▼
remotecfg 用户态程序（读取扫描码，查 remote.tab 映射表）
   │  注入映射后的 Linux keycode（uinput 或直接写入）
   ▼
Android Input 子系统 → 应用收到按键事件
```

`remotecfg` 是 Amlogic BSP 自带的用户态工具，位于本文设备上的 `/vendor/bin/remotecfg`（约 11KB，静态链接 toybox 环境的原生二进制）。它的核心职责就一件事：**把"遥控器物理扫描码 → Android 键值"的映射关系加载进系统**。

### 2.2 remote.cfg 字段逐项解析

我们设备上的 `/data/remote.cfg` 内容：

```ini
work_mode = 0
repeat_enable = 1
debug_enable = 1
max_frame_time = 2000
```

对照 LibreELEC 论坛帖中流传的 Amlogic 官方注释（这段注释在社区所有 remote.conf 教程里几乎原文出现），各字段含义：

| 字段 | 含义 | 说明 |
|------|------|------|
| `work_mode` | 0:软件解码模式 / 1:硬件解码模式 | 软件模式下 remotecfg 自己测量脉冲宽度解码；硬件模式依赖 SoC 的 IR 硬件解码器寄存器（`reg_*` 系列参数） |
| `repeat_enable` | 是否启用长按连发 | 1 = 长按方向键会连续滚动 |
| `release_delay` | 松键上报延迟（ms） | 按键松开后内核延迟多久向用户层上报 release 事件 |
| `debug_enable` | 调试开关 | 1 = 执行时打印解析结果（这正是我们日志里能看到 `map_size = 12` 等输出的原因） |
| `custom_code`/`factory_code` | 遥控器厂商码 | 格式为 `custom_code(16bit) + index_code(16bit)`，例如 `0xff000001 = 0xff00 + 0001`。它必须和遥控器实际发出的厂商码一致，否则所有按键"查无此人" |

我们的 cfg 里没有写 `custom_code`（程序输出显示 `custom_name =`、`custom_code = 0xff00`，取了默认/表内值），这是因为较新的 remotecfg 版本允许把 `custom_code` 写进 `.tab` 文件头部，`remote.cfg` 只管协议层参数。社区老教程（面向 Android 6 时代的 `remote.conf` 单文件方案）则是 `factory_code` 与键表写在同一个文件里——两种文件布局在社区资料里都常见，本质相同。

### 2.3 remote.tab 键表解析

我们的 `/data/remote.tab`：

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

每一行是 `扫描码 Linux键值` 对：

| 扫描码 | 键值 | Linux 键名 | 实际功能 |
|--------|------|-----------|---------|
| 0x46 | 103 | KEY_UP | 方向上 |
| 0x16 | 108 | KEY_DOWN | 方向下 |
| 0x47 | 105 | KEY_LEFT | 方向左 |
| 0x15 | 106 | KEY_RIGHT | 方向右 |
| 0x55 | 28 | KEY_ENTER | OK 确认 |
| 0x04 | 139 | KEY_MENU | 菜单 |
| 0x40 | 158 | KEY_BACK | 返回 |
| 0x14 | 115 | KEY_VOLUMEUP | 音量+ |
| 0x10 | 114 | KEY_VOLUMEDOWN | 音量- |
| 0x18 | 116 | KEY_POWER | 电源 |
| 0x4e | 102 | KEY_HOME | 主页 |
| 0x5b | 113 | KEY_MUTE | 静音 |

键值采用 Linux 标准输入事件码（`input-event-codes.h`），CoreELEC Wiki 的教程里给出了完整的"抓码 → 查表 → 填表"工作流：先用 `ir-keytable -t` 或内核日志抓出每个按键的原始扫描码，再对照键值头文件填表。remotecfg 启动时打印的 `key[0] = 0x460067` 正是"扫描码 0x46 → 键值 0x67(103)"的内部表示。

### 2.4 一个颠覆直觉的机理：remotecfg 是"上传器"不是"守护进程"

这是整个项目**最重要的一条认知**，也是后文 v1.2 排查的关键钥匙。

按社区教程的老说法（2017 年前后的帖子），remotecfg 是一个用户态守护进程，常驻后台监听 `/dev/input`。但本文设备上的实测推翻了这个印象：

- 手动执行 `remotecfg ... -d` 后，命令立即返回 `exit=0`，打印完整键表解析结果；
- 之后无论用 `ps -A` 还是遍历 `/proc/*/cmdline`，都**找不到任何名为 remotecfg 的进程**；
- 但遥控器立即按自定义键位工作，且**持续有效**（我们验证了间隔 10 分钟以上依然生效）。

结论：这个版本的 remotecfg 把键表**上传给内核 IR 子系统后就退出**了（`-d` 参数的"daemonize"语义在这个实现里并不产生常驻进程），键值映射由内核维持。"最后一次上传"决定生效的键表——这个模型直接决定了后文开机时序修复的设计。

> 教训：**社区教程的结论有时效性**。Amlogic 的 BSP 工具在不同芯片/不同 ROM 年代行为差异很大（S905 老固件 vs S905L2 新固件），一切以你设备上的实测为准。

### 2.5 扫描码从哪来：NEC 协议与"抓码"工作流

要自己写一张 `remote.tab`，第一个问题是"每个按键的扫描码是多少"。这涉及红外遥控最底层的 NEC 协议：遥控器每按一个键，会发出一串 38kHz 载波调制的红外脉冲，由"引导码 + 16 位用户码（custom_code）+ 8 位键码 + 8 位键码反码 + 结束码"组成。内核的 meson-ir 驱动把这段脉冲解码成两个数：**用户码**（即 remote.tab 里的 `custom_code = 0xff00`，用来区分不同品牌的遥控器）和**键码**（表里第一列的 `0x46`、`0x16` 等）。

抓码的方法在社区有两套成熟工具：

- **Android 侧**：临时把 `remote.cfg` 的 `debug_enable` 设为 1，执行 remotecfg 后按遥控器，内核日志（`dmesg`）会打印每个按键的"wrong custom code"或原始扫描码——LibreELEC 论坛经典帖正是用 `dmesg -c` 清缓存再按键的方法逐键抓码；
- **Linux/CoreELEC 侧**：`ir-keytable -t` 直接实时显示原始扫描码和已映射的键值，体验更好，CoreELEC Wiki 的教程完整演示了这条路线。

拿到扫描码后，第二列要填的是 Linux 输入事件码（`input-event-codes.h` 中的 `KEY_UP=103`、`KEY_ENTER=28` 等）。这份头文件全社区通用，CoreELEC 的 GitHub 仓库里维护着一份可检索的副本。理解了"扫描码只是遥控器的物理编号，键值才是 Android 眼中的语义"，`remote.tab` 的每一行就再无神秘感可言。

### 2.6 remotecfg 命令行参数速查

综合本设备实测与社区资料，remotecfg 的常用调用形态：

```bash
remotecfg <remote.conf>                        # 老式单文件模式（conf+tab 合一）
remotecfg -c <cfg> -t <tab>                    # 新式分离模式（本设备 ROM 采用）
remotecfg -c <cfg> -t <tab> -d                 # -d：daemonize 语义（本设备实测为"上传后退出"）
```

本项目选择 `-d` 参数主要是遵从用户给定的目标命令；实测证明带上它在本设备上依然上传成功且退出码为 0。如果你在其他盒子上复刻本项目，建议先手动跑一次带 `-d` 的命令并观察进程列表，确认你的 remotecfg 属于"常驻型"还是"上传型"——这决定了开机时序策略（常驻型还要额外考虑 su 会话清理对进程组的影响，上传型则只需要考虑执行顺序）。

---

## 3. 方案选型：为什么是"APK + BOOT_COMPLETED"

"开机后执行一条 root 命令"至少有三种主流方案，社区博客各有拥趸。先对比再选型。

### 3.1 三种候选方案

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| A. init.rc 服务 | 在 `/system/etc/init/` 放一个 rc 文件定义 service | 系统级时机、无需 app、root 天然 | 需要重挂 /system 改文件；OTA/换ROM 后要重做；改错 rc 可能开不了机；不易动态调整 |
| B. Magisk 模块脚本 | Magisk 的 `service.sh`/`post-fs-data.sh` 在开机时执行 | 不动系统分区；脚本灵活 | 依赖 Magisk 存在及版本行为；本文设备的 su 是 ROM 内置而非 Magisk，不适用；脚本排障体验差 |
| C. APK + BOOT_COMPLETED 广播 | app 注册开机广播，收到后启动服务执行命令 | 安装/卸载即部署/撤除；有 UI 可查日志；交付形态正是用户要的 | 受 Android 8.0+ 后台执行限制约束（后文主角）；依赖 root 授权配合 |

这台设备值得注意的一个事实：ROM 里**已经有人尝试过方案 A**——`/system/etc/init/load_remote.rc` 正是这么做的（详见第 6.3 节），但它因为服务重名被 init 忽略了，形同虚设。这恰恰反证了方案 A 的脆弱性：你写的 rc 文件可能因为重名、SELinux、语法等原因静默失效，而且 ROM 升级就丢。

最终选择方案 C，同时吸收方案 A 的教训：**APK 里内建"清场 + 时序控制"逻辑，不与 ROM 自带服务抢跑，而是确保自己最后一个上场**。

### 3.2 对"保活"类方案的态度

中文社区关于"开机自启"的博客，绝大多数篇幅其实在讲 **Service 保活**（双进程守护、JobScheduler 拉活、前台服务提权、监听八种系统广播等，代表性文章如 CSDN 的《Android Service保活的几种方法总结》和开源项目 HelloDaemon）。本文刻意反向而行：

- 我们的任务是**一次性**的——上传键表后进程就该退出，"保活"毫无意义甚至有害；
- 我们的 Service 生命周期以秒计：`startForegroundService` → `startForeground`（满足 5 秒规则）→ 干活 → `stopForeground` + `stopSelf`；
- 唯一需要"持久"的是结果（内核里的键表），不是进程。

这个区别值得所有做开机任务的人想清楚：**你要保活的是进程，还是进程产生的效果？** 如果是后者，正确的设计是"确保执行成功 + 验证 + 退出"，而不是常驻内存。

---

## 4. APK 工程结构逐文件解析

### 4.1 目录总览

```text
RemoteCfgBoot/
├── AndroidManifest.xml              # 组件声明与权限
├── res/
│   ├── drawable/ic_launcher.png     # 启动图标（PowerShell System.Drawing 生成）
│   └── values/strings.xml           # 应用名
├── src/com/local/remotecfgboot/
│   ├── BootReceiver.java            # 开机广播接收器
│   ├── RunService.java              # 前台服务 + 核心执行逻辑 + 日志
│   └── MainActivity.java            # 日志查看 + 手动触发
├── build/                           # 构建中间产物（脚本生成）
└── RemoteCfgBoot.apk                # 最终产物（16KB）
```

总共 3 个 Java 文件、约 400 行代码。没有Gradle 工程文件、没有依赖库、没有 androidx——目标 API 28 的 `android.jar` 里自带的一切就够了。

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

逐项说明：

- **`minSdkVersion=21, targetSdkVersion=28`**：targetSdk 是个"声明兼容到哪代行为"的开关。声明 28 意味着系统按 Android 9 的规则对待我们——后台服务限制生效（这正是 v1.0 翻车的根源），但 Android 10+ 才有的后台 Activity 启动限制、前台服务类型声明等不会加诸此 app。对一台 Android 9 盒子，28 是最贴切的值。
- **`RECEIVE_BOOT_COMPLETED`**：普通权限，安装即授予，是收到开机广播的门票。没有它，`BootReceiver` 永远收不到广播。
- **`FOREGROUND_SERVICE`**：API 28 新增的普通权限，调用 `startForeground()` 的门票。v1.0 没加它，v1.1 补上。
- **`QUICKBOOT_POWERON`**：部分盒子/电视 ROM（尤其 Amlogic、海思方案）在"快速开机"路径上发的是这个私有广播而非标准 `BOOT_COMPLETED`，一并监听是电视盒子开发的经验惯例。
- **receiver 的 `exported="true"`**：`BOOT_COMPLETED` 是系统广播，接收器必须对外开放才能被 system 进程投递。targetSdk < 31 时该属性可省略，但显式声明是好习惯。
- **service 的 `exported="false"`**：服务只被自己的 receiver/activity 拉起，不对外。

### 4.3 BootReceiver.java —— 开机入口

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
                // Android 8+ 后台限制：必须用 startForegroundService，5 秒内转前台
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception e) {
            RunService.appendLog(context, "startForegroundService failed: " + e);
            // 兜底：goAsync 在广播窗口内直接干活
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

三个设计点：

1. **`startForegroundService` 是 Android 8.0+ 的正门**。官方《Background Execution Limits》明确：后台应用不允许 `startService`，但 `startForegroundService` 不受此限，代价是服务必须在创建后 5 秒内调用 `startForeground()`，否则系统 ANR 并停止服务。
2. **`goAsync()` 兜底**：万一某些深度定制 ROM 连 `startForegroundService` 都拦（罕见但存在），就在广播接收窗口内直接起线程干活。`goAsync()` 让 receiver 的存活时间从毫秒级延长到约 10 秒（前台广播超时上限），用完必须 `pr.finish()` 归还控制权。这是一次性的保险丝，正常路径走不到。
3. **把日志写入动作前置于一切**：开机现场转瞬即逝，第一行日志先落盘再干活。

### 4.4 RunService.java —— 前台服务与核心逻辑

这是 app 的主体，分四块讲。

**（a）前台服务的正确姿势**

```java
@Override
public int onStartCommand(Intent intent, int flags, int startId) {
    final boolean manual = intent != null && intent.getBooleanExtra("manual", false);

    Notification n = new Notification.Builder(this, CHANNEL_ID)   // API 26+
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("RemoteCfg")
            .setContentText("正在执行 remotecfg ...")
            .setOngoing(true)
            .build();
    startForeground(1, n);   // 必须在 onStartCommand 里立即调用，满足 5 秒规则

    new Thread(() -> {
        try { runOnce(this, manual); }
        finally { stopForeground(true); stopSelf(); }
    }, "remotecfg-runner").start();
    return START_NOT_STICKY;
}
```

- 通知渠道（`NotificationChannel`）在 `onCreate` 里创建，API 26+ 必须，否则通知发不出来；
- `IMPORTANCE_MIN` 让通知不出声、不下拉常驻吸睛；
- 干完活立刻退前台、停服务，不占系统资源——**前台通知只是穿越"后台限制"关卡的通行证，不是功能**。

**（b）runOnce 的时序设计（v1.2 定稿逻辑）**

```java
public static void runOnce(Context c, boolean manual) {
    long start = SystemClock.elapsedRealtime();

    // 1. 等 /data 上的两个配置文件就绪（最多 10 次 × 3s）
    for (int i = 1; i <= 10; i++) {
        Result r = runSu(c, "test -f /data/remote.cfg -a -f /data/remote.tab && echo READY", 8000);
        if (r.exitCode == 0 && r.out.contains("READY")) break;
        sleep(3000);
    }

    // 2. 开机路径：延迟等 ROM 自带的遥控实例全部跑完，确保我们最后上传
    if (!manual) {
        long settle = 15000 - (SystemClock.elapsedRealtime() - start);
        if (settle > 0) sleep(settle);
    }

    // 3. 清场 + 双轮上传
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
    // 4. su 全灭时兜底直连（适用于 app 被装进 priv-app 的场景）
    ...
}
```

每一步都有明确的存在理由：

- **文件等待循环**：`BOOT_COMPLETED` 广播时 /data 理论上已挂载，但配置文件可能是用户后续才放进去的；另外文件检查必须通过 `su` 做——app 自身无权 `stat` `/data` 根下的文件，直接 `File.exists()` 永远返回 false（这也是个常见坑）。
- **15 秒 settle 延迟**：ROM 自带的 4 个 remotecfg 实例在 `sys.boot_completed=1` 前后集中启动（见 6.3 节），它们加载的是空配置。如果我们抢跑，会被它们覆盖。**最后一战定胜负**，所以让子弹先飞一会儿。
- **`killall remotecfg`**：把可能残留的实例全部清掉再上传，双保险。
- **双轮上传**：两轮间隔 3 秒，即使有哪个系统实例在我们的第一轮之后才姗姗来迟，第二轮依然压轴。每轮内部按候选路径依次尝试，`exit=0` 即胜出。
- **候选路径表**：`/vendor/bin/remotecfg` 是设备上实际存在的路径（勘查所得），裸命令名 `remotecfg` 依赖 su 会话的 PATH，其余两个是惯例位置。多候选 + 实测优先，移植到其他盒子时无需改代码。
- **直连兜底**：如果 app 未来被预置进 `/system/priv-app`（很多盒子二次开发会这么干），进程本身就是 root 级权限，根本不需要 su。这个分支让同一个 APK 在两种部署形态下都能跑。

**（c）runSu 的进程管道处理**

```java
private static Result runSu(Context c, String shellCmd, long timeoutMs) {
    Process p = new ProcessBuilder("su", "-c", shellCmd).start();
    StreamGobbler outG = new StreamGobbler(p.getInputStream());
    StreamGobbler errG = new StreamGobbler(p.getErrorStream());
    outG.start(); errG.start();
    boolean finished = p.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
    if (!finished) { p.destroyForcibly(); /* 记录超时（可能是 su 等授权） */ }
    ...
}
```

两个必答题：

- **为什么要 Gobbler 线程？** 子进程的 stdout/stderr 管道缓冲区只有几 KB，remotecfg 打印整个键表加上 su 的输出很容易填满；不读走的话子进程写管道阻塞，父进程又在 `waitFor` 等子进程——经典死锁。两个守护线程持续排空管道是最朴素可靠的解法。
- **为什么要超时？** 首次以 root 执行时，若 su 实现带交互授权（Magisk 弹窗），`su` 会静默等待用户点允许。20 秒超时 + 上层的重试循环，把"等待授权"和"真失败"区分开：日志里看到 `timeout (可能 su 在等待授权)` 就知道该去点弹窗了。

**（d）日志系统**

`appendLog` 带时间戳写 `getExternalFilesDir()/remotecfg_boot.log`（外部存储不可用时退回内部 `getFilesDir()`），同时 `Log.i` 一份到 logcat。文件落在 `/sdcard/Android/data/com.local.remotecfgboot/files/`，adb 一条 `cat` 就能取——排障效率远高于每次连 logcat 抓取。

### 4.5 MainActivity.java —— 用代码写 UI

界面只有一个标题、两个按钮（立即执行 / 清空日志）和一个滚动日志窗，完全用 Java 代码构建（`LinearLayout` + `Button` + `TextView` + `ScrollView`），不写 layout XML——省一个资源文件，也让"无 Gradle 构建"的资源目录最小化。`onResume` 时用 `Handler` 每 2 秒刷新一次日志内容，`onPause` 停止刷新，标准的 Android 生命周期纪律。

回头看这个界面，有三个设计决策值得展开：

**（a）"立即执行一次"按钮不只是调试功能，而是运维接口。** 按钮点击后以 `putExtra("manual", true)` 启动服务，`runOnce` 收到 manual 标记后会**跳过 15 秒 settle 延迟和开机等待循环**——因为手动触发的语境必然是"设备已经开机完成、配置文件早就就位"，再等 15 秒纯属浪费。这个设计让改完 `/data/remote.tab` 键位后的验证流程变成：adb push 配置 → 打开 app → 点一下按钮 → 拿遥控器试。不用重启，不用 adb shell，遥控生效周期从"分钟级重启"压缩到"秒级"。如果当初把这个 app 做成"开机黑盒"，每次调试都要重启设备，第 6 章的三轮迭代至少要慢三倍。

**（b）日志窗用等宽字体（`Typeface.MONOSPACE`）。** 日志内容是时间戳 + 事件序列，用户最常做的动作是扫一眼"最后一次开机到 SUCCESS 隔了几秒、exec 的 exit code 是多少"。比例字体的数字宽度不一，竖向难以对齐；等宽字体下日志天然成表。这和终端模拟器用等宽字体是同一个理由——凡是以"行"为单位、依赖竖向对齐阅读的文本，等宽都是唯一正解。

**（c）Handler 轮询而不是 Service 广播回传。** 更"正规"的做法是 Service 用 `LocalBroadcastManager` 或 Messenger 把每条日志实时推给 Activity，但那需要引入 androidx（违背零依赖定位）或手写 Binder。而本 app 的日志本来就是落盘文件，Activity 每 2 秒重读一遍文件末尾即可——**用"读文件"替代"进程间通信"，在单进程 app 里是零成本且最不易出 bug 的方案**。2 秒的延迟对"看日志"这个用例完全无感。这也是嵌入式排障界的老经验：凡是能落成文件的，就用文件通信；进程间实时性只有在真正需要时才值得付出复杂度。

---

## 5. 无 Gradle 手工构建流水线

### 5.1 为什么不用 Gradle

这是本项目最有分享价值的部分之一。社区里已有几篇优秀的同类实践可对照：

- shkhuz 的《An android app from scratch》：从零用 `aapt`/`javac`/`d8` 构建应用，理由是"要理解系统必须从第一性原理构建"，并顺带吐槽 Android Studio 空项目动辄 40-50MB、近千个文件；
- kotlowski 的《Building an Android App Without Gradle or Android Studio》：点出"绝大多数开发者构建过几百个 app，却从未亲手构建过一个 APK"；
- 《Extending Android Builds》系列 1-4 章：给出了与 AGP 逐步对齐的手工构建脚本，可作为进阶路线。

本项目选择手工构建还有个务实原因：**开发机是 Windows，只有 JDK 17 和一个现成的 Android SDK（build-tools 35.0.0 + platforms android-35），没有也不需要装 Gradle/Android Studio**。对这种"单模块、零依赖、minSdk 21"的微型项目，Gradle 带来的 wrapper 下载、AGP 版本匹配、增量缓存统统是负担。APK 本质上只是一个包含资源表、DEX 字节码和签名的 ZIP 文件——工具链的每一层都该为这个事实服务。

### 5.2 工具链清单

| 工具 | 来源 | 用途 |
|------|------|------|
| JDK 17 | 系统 | `javac` 编译、`jar` 打包、`keytool` 生成密钥 |
| aapt2 | build-tools/35.0.0 | 资源编译与链接（官方文档：Android Gradle Plugin 3.0 起默认启用 AAPT2，命令行可直接使用） |
| d8 | build-tools/35.0.0 | JVM 字节码 → Android DEX 字节码 |
| zipalign | build-tools/35.0.0 | 4 字节对齐未压缩资源（so 文件加载、资源 mmap 的前提） |
| apksigner | build-tools/35.0.0 | v1/v2 签名 |
| platforms/android-35/android.jar | SDK platforms | **仅作为编译期 classpath**（声明 API 用），运行时由设备系统提供实现 |

注意一个容易被误解的点：我们用 android-35 的 `android.jar` 编译，但 `targetSdkVersion=28`——`android.jar` 只提供编译期符号，`targetSdk` 才决定运行时行为，两者解耦。这样不必特意下载 platforms;android-28。

### 5.3 七步流水线（Windows PowerShell 实录）

```powershell
$BT  = "$SDK\build-tools\35.0.0"
$AJ  = "$SDK\platforms\android-35\android.jar"

# ① 资源编译：res/ 下的 XML/PNG → 二进制 .flat 打包成 res.zip
& "$BT\aapt2.exe" compile --dir res -o build\res.zip

# ② 资源链接：合并清单与资源，生成 APK 骨架 + R.java + resources.arsc
& "$BT\aapt2.exe" link -o build\base.apk -I "$AJ" `
    --manifest AndroidManifest.xml --java build\gen `
    --min-sdk-version 21 --target-sdk-version 28 build\res.zip

# ③ Java 编译：源码 + 生成的 R.java → JVM .class
javac -encoding UTF-8 -source 1.8 -target 1.8 -Xlint:-options `
    -classpath "$AJ" -d build\classes `
    build\gen\com\local\remotecfgboot\R.java src\com\local\remotecfgboot\*.java

# ④ 字节码转译：.class → classes.dex
& "$BT\d8.bat" --release --lib "$AJ" --min-api 21 --output build\dex `
    (Get-ChildItem build\classes\com\local\remotecfgboot\*.class | % FullName)

# ⑤ 合体：把 dex 塞进 APK（APK 就是 ZIP）
jar -uf build\base.apk -C build\dex classes.dex

# ⑥ 对齐：4 字节对齐
& "$BT\zipalign.exe" -f 4 build\base.apk build\aligned.apk

# ⑦ 签名：debug 密钥库，v1+v2 双签名
& "$BT\apksigner.bat" sign --ks "$env:USERPROFILE\.android\debug.keystore" `
    --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android `
    --out RemoteCfgBoot.apk build\aligned.apk
& "$BT\apksigner.bat" verify RemoteCfgBoot.apk
```

每步的原理与坑：

- **aapt2 compile/link 两段式**是 AAPT2 相对老 aapt 的核心改进（compile 产出中间 `.flat`，link 统一分配资源 ID `0x7f…` 并校验清单）。`--java build\gen` 让它顺带生成 `R.java`——没有这一步，Java 代码里的 `R.drawable.ic_launcher` 无从编译。`-I "$AJ"` 必不可少：清单里引用的系统类和资源要在 android.jar 里校验。
- **javac 的 `-source/-target 1.8`**：d8 对更高版本 class 文件格式虽然也能处理，但 Android 9 的 ART 对 Java 8 语法特性（lambda、default 方法）通过 desugar 支持得最稳。`-Xlint:-options` 关掉"源值 8 已过时"的告警噪音。
- **d8 的 `--min-api 21`** 告知目标最低 API，以便决定是否做 desugar 和使用哪些指令改写。产出的 `classes.dex` 约 13KB。
- **jar -uf 追加**：`aapt2 link` 产出的 base.apk 已含 `AndroidManifest.xml`、`resources.arsc`、`res/`，只缺 dex。`jar -uf` 就地更新 ZIP。targetSdk 30+ 有"resources.arsc 必须未压缩且对齐"的强制要求，本项目 targetSdk 28 不受影响，但如果是新项目要在 zipalign 前留意。
- **zipalign 必须在签名前**：apksigner 的 v2 签名会保护整个 ZIP 的字节范围，先对齐后签名才能保证两者兼得（先签名后对齐会破坏 v2 签名——这是手工构建最容易踩的顺序坑）。
- **debug.keystore 不存在时**用 `keytool -genkeypair` 生成一个（`-alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US"`），与 Android Studio 的默认调试签名完全同构。升级安装要求签名一致，三版迭代都用同一把钥匙。

最终产物 **RemoteCfgBoot.apk：16KB**。对比 Gradle 空项目动辄数 MB 的产物，这就是零依赖的力量。

### 5.4 与 Gradle/AGP 流水线的对应关系

| 手工步骤 | AGP 中的对应 Task |
|----------|-------------------|
| aapt2 compile | `:app:mergeResources` / `:app:compileReleaseResources` 内部 |
| aapt2 link | `:app:processReleaseResources` |
| javac | `:app:compileReleaseJavaWithJavac` |
| d8 | `:app:dexBuilderRelease` |
| jar -uf + zipalign | `:app:mergeReleaseAssets`+`:app:zipalignRelease` |
| apksigner | `:app:validateSigningRelease` + `:app:assembleRelease` 内部 |

理解了手工流水线，Gradle 构建日志里那一长串 task 就不再是黑盒。

### 5.5 APK 里到底有什么：解剖产物

对最终产物做一次解构，验证"APK 就是 ZIP"的论断：

```text
RemoteCfgBoot.apk (16 KB)
├── AndroidManifest.xml      # 已编译为二进制 XML（不可直接 cat，需 aapt2 dump）
├── resources.arsc           # 资源索引表（字符串、drawable 的 ID → 偏移映射）
├── classes.dex              # 全部 Java 代码编译后的 DEX 字节码（约 13KB）
├── res/drawable-*/ic_launcher.png
└── META-INF/
    ├── MANIFEST.MF          # v1 (JAR) 签名：每个文件的 SHA-1 摘要
    ├── CERT.SF / CERT.RSA   # 摘要清单的签名 + 证书
    └── (v2 签名块在 ZIP 结构的中央目录之前的特殊区域，不看条目)
```

两个签名机制的要点值得展开：

- **v1 签名（JAR Signing）**只覆盖 ZIP 内的各个文件条目，攻击者可以往 APK 里追加未签名文件而不被 v1 察觉（著名的 Janus 漏洞系列问题之一）；**v2 签名（APK Signing Scheme）**对整个文件内容做摘要并写入 APK 签名块，任何字节改动都会导致校验失败。Android 7.0+ 同时校验两种，Android 9 设备上 v2 必须完好——这也是"先 zipalign 后签名"顺序铁律的根源：对齐会改动文件字节，必须在签名之前完成。
- **为什么用 d8 而不是老的 dx**：dx 已被官方废弃，d8 生成更小更快的 DEX、原生支持 Java 8 语法 desugar，且是 build-tools 26+ 的内置组件。对手工流水线来说两者调用方式几乎一样，没有理由用旧工具。

用 `aapt2 dump badging RemoteCfgBoot.apk` 还能验证清单是否如预期（包名、权限、可启动 Activity、sdk 版本），这是签名前最后一步自检，我们每轮迭代构建后都执行它来确认版本号确实变了——避免"改了代码忘了升 versionCode 导致 install -r 拒绝"的低级事故。

---

## 6. 三轮迭代调试实录

这是本文的核心。三轮迭代，三种失败模式，每一轮都用"假设 → 取证 → 复现 → 修复 → 验证"的科学调试路径推进。

### 6.1 v1.0：安装成功，开机纹丝不动

**现象**：首次安装后手动重启，app 界面日志显示：

```text
received android.intent.action.BOOT_COMPLETED
startService failed: java.lang.IllegalStateException: Not allowed to start
service Intent { cmp=com.local.remotecfgboot/.RunService }: app is in background
uid UiRecord{7b0dcd6 u0a38 RCVR idle change:idle|uncached procSeq:0}
```

**好消息**：广播收到了——`RECEIVE_BOOT_COMPLETED` 权限和 receiver 注册全部正确。
**坏消息**：`startService` 被系统当场拦截。

**原理剖析**（对照官方文档《后台执行限制》）：Android 8.0 起，进入后台的 app 禁止调用 `startService` 创建后台服务（`IllegalStateException`）；系统判定"前台"的标准是有可见 Activity、有前台服务、或被其他前台 app 绑定。按设计，收到 `BOOT_COMPLETED` 的 app 会被加入**临时白名单**（temp-allowlist）从而放行——但这属于"系统仁慈"而非"契约保证"，各家 ROM（尤其电视盒子这种魔改 ROM）对临时白名单的落实参差不齐，本文这台就在"不落实"的行列里。

**修复（v1.1）**：改用系统为后台场景专设的 `startForegroundService()`——它不受后台限制，代价是服务必须在 5 秒内 `startForeground()` 挂上前台通知。为此：

1. Manifest 增加 `<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>`；
2. `onStartCommand` 第一行就 `startForeground(1, notification)`；
3. 干完活 `stopForeground(true)` + `stopSelf()`，通知闪现数秒后消失——这是该方案的固有代价，可接受；
4. receiver 里对 `startForegroundService` 的调用加 try-catch，失败时 `goAsync()` 直接在广播窗口内执行，作为最后保险丝。

### 6.2 v1.1：命令执行成功了，遥控却"没变"

**现象**：重启后日志漂亮得无可挑剔：

```text
received android.intent.action.BOOT_COMPLETED
==== BOOT trigger ====
wait[1] exit=0 out=READY err=
exec: su -c "remotecfg -c /data/remote.cfg -t /data/remote.tab -d"
  exit=0 out=cfgdir = /data/remote.cfg work_mode = 0 ... map_size = 12
      key[0] = 0x460067 key[1] = 0x16006c ...(完整 12 键表)
```

退出码 0，remotecfg 甚至把我们的键表完整解析打印了。**但红外遥控毫无变化**，反而是"点开 app、按一下'立即执行'，遥控才恢复自定义键位"。

这一轮的教训是方法论层面的：**`exit=0` 只证明进程活着跑完了，不证明效果成立**。执行成功与生效之间隔着一整个未知领域。接下来进入真正的侦查阶段——好在设备开着网络 ADB，开发机可以直接"现场勘查"。

### 6.3 v1.2 侦破：五实例竞速与 ps 匹配陷阱

**第一步：getprop 摸清系统里的遥控服务。**

```bash
adb shell "getprop | grep -i remote"
# [init.svc.load_remote]:  [stopped]
# [init.svc.remotecfg]:    [stopped]
# [init.svc.remotecfg7]:   [stopped]
# [init.svc.remotecfg8]:   [stopped]
# [ro.boottime.load_remote]:  [12933563504]   ← 内核启动后约 12.9 秒被拉起
# [ro.boottime.remotecfg]:    [12921906088]
# ...
```

四个 `init.svc.*` 属性意味着 ROM 里有四个遥控相关的 init 服务，全部在开机 12.9 秒左右启动过，目前全部 stopped。

**第二步：翻 rc 定义，还原开机战争全貌。**

`/vendor/etc/init/hw/init.amlogic.rc`（Amlogic 平台主 rc）里：

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

而 `/system/etc/init/load_remote.rc` 里赫然还有一份：

```bash
service load_remote /vendor/bin/remotecfg -c /data/remote.cfg -t /data/remote.tab
    class main
    user root
    group root
    oneshot
on property:sys.boot_completed=1
    start load_remote
```

看得出来，ROM 作者（或上一个刷机玩家）就是想用方案 A 实现"开机加载 /data 遥控配置"——但它**根本不会生效**：Android 9 的 init 解析 rc 时按固定顺序（/init.rc 及其 import → /system/etc/init → /vendor/etc/init），`load_remote` 这个服务名先被 `init.amlogic.rc` 注册成了指向 **custom_remote（空配置）** 的版本，后到的 `/system/etc/init/load_remote.rc` 因为**服务重名被直接忽略**。这正是社区里"我明明写了 rc 文件却没生效"的经典陷阱。

更戏剧的是：`custom_remote.cfg` 和 `custom_remote.tab` 在设备上是**空文件**。也就是说，开机时最多有 5 个 remotecfg 实例先后启动：`on boot` 的 exec、`load_remote`、`remotecfg/7/8`（class main），加上我们的 app——**它们在 `sys.boot_completed=1` 前后数秒内赛跑，谁最后上传，遥控键表就是谁的**。我们的 app 在广播后 1 秒就抢跑，随后被某个（或某串）系统实例覆盖——完美解释"exit=0 但遥控没变"。

**第三步：ps 排查的陷阱。**

为了确认"守护进程是否存活"，我跑了：

```bash
adb shell "ps -A | grep -i remote"
```

输出里有一行 `u0_a51 ... com.local.remotecfgboot`——这是**我们自己的 app 进程**！包名里含 "remotecfg" 字样，被 grep 匹配。接着我写了轮询脚本统计 `ps -A | grep remotecfg | grep -v grep | wc -l`，得数恒为 1——我一度以为守护进程稳定存活，和另一次"3 秒后消失"的观测结果矛盾，排查一度陷入混乱。

醒悟之后改用**全 cmdline 扫描**排除名字误导：

```bash
for d in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < $d/cmdline 2>/dev/null)
  case "$c" in *remotecfg*) echo "$d: $c";; esac
done
```

结果：除 app 自身外**零匹配**。原来这个版本的 remotecfg 上传键表后**根本不留常驻进程**（见 2.4 节），"3 秒消失"和"30 秒存活"两个观测全是我被 grep 误导后的误读——真相是它从未长驻，而遥控持续生效恰恰因为键表在内核里。

> 这一段是本文最想分享的经验：**在嵌入式排查里，先怀疑你的观测工具**。`ps | grep` 是最顺手的武器，也最容易喂给你含毒的子弹——进程名匹配到包名、grep 自匹配、管道里的 wc 都能让数出来的一变成零或一变三。

**第四步：用户实测钉死模型。** 我用 adb 手动执行 remotecfg（约在排查前几分钟），请用户拿遥控器实测：**键位是自定义的，且持续有效**。结合"无进程 + 生效持久"两点，"上传内核后退出、最后上传者胜"的模型钉死。

复盘这一轮侦查，真正起作用的其实是一张朴素的问题清单，每个问题对应一个取证动作：

| 疑问 | 取证手段 | 结论 |
|------|---------|------|
| 系统里还有谁在管遥控？ | `getprop \| grep remote` | 4 个 init 服务 |
| 它们的启动时机？ | `ro.boottime.*` | 开机 12.9s，与 BOOT_COMPLETED 同窗 |
| 它们加载什么配置？ | 翻 rc 文件 | custom_remote（空文件） |
| 我们的 rc 为什么没生效？ | 全盘 grep 服务名 | 重名被 init 忽略 |
| 守护进程活着吗？ | `/proc/*/cmdline` 全扫 | 从未长驻 |
| 效果持久吗？ | 用户间隔实测 | 持久，上传即生效 |
| 谁覆盖了谁？ | 时序对齐分析 | 最后上传者胜 |

这张表的模式值得记住：**嵌入式排障的每一步都该是"一个可证伪的问题 + 一个单变量取证命令"**，而不是"重启一下试试"的玄学循环。整个 v1.2 侦查只花了不到一小时，靠的就是网络 ADB 让每个假设都能在 30 秒内验证或证伪。

**第五步：对症修复（v1.2 定稿）。**

既然胜负手是"最后上传"，修复方案四件套：

1. **15 秒 settle 延迟**（开机路径独有）：等系统实例全部跑完，我们不抢跑，压轴登场；
2. **`killall remotecfg` 清场**：上传前把可能残存的实例送走；
3. **双轮上传**：间隔 3 秒两轮，防任何"迟到大王"；
4. **候选路径以 `/vendor/bin/remotecfg` 为首**：勘查实测的最短路径优先。

**第六步：闭环验证。** 重新构建安装，`adb reboot`，等待开机后拉取日志：

```text
23:33:25 received BOOT_COMPLETED
23:33:25 ==== BOOT trigger ====
23:33:25 wait[1] exit=0 out=READY
23:33:25 boot settle delay 14s
23:33:40 exec(round0): su -c "/vendor/bin/remotecfg -c /data/remote.cfg -t /data/remote.tab -d"  exit=0 (12键表)
23:33:43 exec(round1): su -c "/vendor/bin/remotecfg ..."  exit=0
23:33:43 SUCCESS
```

用户实测遥控键位正确。**全自动、免维护、开机即生效**——目标达成。

---

## 7. 网络同类方案整合与对比

### 7.1 Amlogic 遥测定制的三大流派

综合 CoreELEC Wiki、LibreELEC 论坛与中文圈（恩无线、智能电视网等）的资料，改遥控键位有三条技术路线：

| 流派 | 平台 | 原理 | 优点 | 局限 |
|------|------|------|------|------|
| **remotecfg + remote.cfg/tab**（本文） | Android 固件 | 用户态工具解析 NEC 等协议，按表映射后注入 | Android 原生支持、无需动内核；`/data` 存配置可随时改 | 与 ROM 自带服务存在竞争（本文主坑）；BSP 版本行为差异大 |
| **ir-keytable + rc_maps.cfg** | CoreELEC/LibreELEC (Linux) | 内核 RC 核心直接维护键表，`ir-keytable -a` 加载 | 标准化、`-t` 抓码体验极佳；与用户态解耦 | 仅限 Linux 系统类固件；Android BSP 下驱动支持不完整 |
| **内核 dts / 驱动键表魔改** | 深度定制 | 修改设备树或 `hid-*.c`/IR 驱动内置表 | 一劳永逸、无用户态依赖 | 需要重编内核；门槛最高 |

值得注意的整合点：LibreELEC 论坛老帖里"remotecfg remote.conf 热加载"（改完不用重启，`remotecfg remote.conf` 立即生效）与本文的"立即执行一次"按钮是同一招；CoreELEC 教程的"先 `ir-keytable -t` 抓扫描码再填表"工作流，在 Android 侧同样适用——`/data/remote.tab` 的第一列扫描码就是这么来的。

### 7.2 开机自启方案的社区经验图谱

中文社区（CSDN 保活综述、HelloDaemon、ServiceDaemon 等开源项目）把开机自启+保活总结为十余种手段：BOOT_COMPLETED 广播、START_STICKY、前台服务提权、双进程 AIDL 守护、JobScheduler 拉活、账户同步拉活、推送拉活、各家厂商白名单引导……这些方案针对的是**常驻服务在国产 ROM 杀后台的绞肉机下求生存**。

本文场景与之的本质区别再强调一次：**一次性任务 + 结果持久化**。于是方案空间坍缩成两条：

- 系统级：init.rc / Magisk 脚本（不受任何后台限制，但没有 UI、没有日志、易被 ROM 更新冲掉）；
- 应用级：BOOT_COMPLETED + startForegroundService（本文选择，配齐日志与手动触发，依赖 root 执行 privileged 命令）。

官方文档层面还有 WorkManager 一派（`setExpedited` 加急任务、持久化调度、重启后自动恢复），它适合"延迟、可约束、可重试"的后台工作；但 WorkManager 在设备重启后的恢复有分钟级延迟且不保证即时性，对"开机后尽快生效"的需求不如 BOOT_COMPLETED 直接。另外 minSdk 21 + 零依赖的定位也让我们更愿意手写广播而非引入 androidx。

把 WorkManager 放大来看，它被排除的理由其实有三层，值得展开：

1. **时机层**：WorkManager 的持久化任务在重启后由系统择机恢复，恢复窗口取决于进程空闲、电量、网络约束，官方文档明确"不是精确的即时执行"。而本需求的对标对象是 ROM 自带的 init 服务——它们在开机十几秒内就完成了键表上传。app 若比系统慢半拍，用户在开机的头一两分钟里按遥控就是"没反应"，体感等同失败。
2. **权限层**：即使任务被恢复，执行 `su -c remotecfg` 仍要经过运行时 `su` 授权。WorkManager 运行在系统调度的进程上下文里，与前台界面相隔更远——首次安装后若授权弹窗无人理会，任务会在后台静默重试直至失败，而用户毫无感知。BOOT_COMPLETED 路径里我们至少还有日志文件可查。
3. **心智层**：WorkManager 解决的是"任务必须可靠完成"，本需求的核心难点却是"任务必须在正确的时机、以正确的顺序完成"——settle 延迟、killall 清场、双轮上传这些时序控制，无论套哪个调度框架都得手写。框架保的是下限，救不了时序。

顺带一提社区常见的第四派：**监听 `android.intent.action.BOOT_COMPLETED` 的静态注册在 Android 11+ 上有"隐式广播例外"限制的传言**——实际上 `BOOT_COMPLETED` 一直在豁免清单里，真正要警惕的是国产 ROM 的自启动管理（需用户手动给"自启动"权限）与电视盒子系统对未知来源 app 的策略。本文设备是接近 AOSP 的 Amlogic 盒子系统，无此困扰，但读者若在小米/华为类 ROM 上复刻，请先查自启动白名单。

### 7.3 与同类"手工构建 APK"博文的对比

| 维度 | shkhuz《An android app from scratch》 | kotlowski 同名文 | eab.2bab《Building An Apk Manually》 | 本文 |
|------|-------------------|------------|------------|------|
| 平台 | Linux | Linux/WSL | Ubuntu/macOS | **Windows PowerShell** |
| 资源工具 | 老 aapt | aapt2 | aapt2 | **aapt2** |
| 示例复杂度 | Hello World | Hello World | 模板工程 | **真实功能 app（服务/广播/通知/子进程）** |
| 迭代 | 一次性 | 一次性 | 教学向 | **三版迭代 + 真机排障闭环** |

三篇参考文都在"Hello World"层面演示流水线，本文把它推进到了真实交付物：有版本迭代、有签名管理（同一密钥跨版本 `install -r` 升级）、有"构建 → 安装 → 重启 → 取日志 → 回归"的完整闭环。手工构建的价值不在于替代 Gradle，而在于**当 Gradle 出问题时你知道它底下是什么**。

---

## 8. 关键知识点与踩坑清单

1. **BOOT_COMPLETED ≠ 服务放行**。Android 8.0+ 后台 `startService` 抛 `IllegalStateException`；临时白名单在部分定制 ROM 上不生效。`startForegroundService` + 5 秒内 `startForeground` 是契约级方案。
2. **前台通知是通行证不是功能**，干完活立刻 `stopForeground + stopSelf`。
3. **`goAsync()` 只能救急 10 秒**，超时必须 `PendingResult.finish()`，否则 broadcast ANR。
4. **普通 app 无法 stat /data 根下文件**，`File("/data/remote.cfg").exists()` 恒 false；存在性检查必须通过 `su` 执行 `test -f`。
5. **子进程管道必须排空**，否则 waitFor 死锁；su 首次授权可能无限等待，必须超时。
6. **`ps | grep` 会骗人**：包名含关键字、grep 自匹配都会污染观测。进程排查用 `/proc/*/cmdline` 全量扫描更可靠。
7. **Android 9 init 拒绝重名服务**：后定义的 rc 服务静默忽略。往系统里加 rc 文件前先 `grep -rn "service 名字" /system/etc/init /vendor/etc/init` 查重。
8. **remotecfg（本设备版本）是上传器不是守护进程**，键表存于内核，进程退出不影响生效；不同 BSP 版本行为可能不同，务必实测。
9. **开机 init 服务在 `sys.boot_completed=1` 前后集中启动**，与 BOOT_COMPLETED 广播几乎同窗——应用层开机任务若与系统服务有资源竞争，务必延迟 + 清场 + 双保险重试。
10. **`exit=0` ≠ 生效**。自动化任务必须设计可观测验证（本例：日志 + 用户按键实测）。
11. **zipalign 必须先于 apksigner**，否则 v2 签名被破坏；debug 签名跨版本一致才能 `adb install -r` 覆盖升级。
12. **网络 ADB 是电视盒子开发的超能力**：scrcpy/escrcpy 投屏 + adb shell 现场勘查 + 远程 install/reboot 闭环，全程无需碰设备。

### 8.1 几条"坑"背后的通用原理

清单里部分条目值得单独展开，因为它们不止是"这个 ROM 的怪癖"，而是有普遍性的系统设计知识。

**关于后台限制的设计哲学**：Android 8.0 的后台服务限制不是技术缺陷而是产品决策——系统无法区分"有价值的后台工作"和"偷跑流量的后台服务"，于是一刀切要求所有后台工作要么走 JobScheduler（系统调度、省电友好），要么走前台服务（用户可见、责任自负）。`startForegroundService` 是这条政策开出的"正门"，而临时白名单只是"善意"，两者在第三方 ROM 上的落实可靠性天差地别。做电视盒子开发要默认走"正门"。

**关于 init.rc 服务重名**：init 对 rc 的解析是顺序吞并式的——先解析到的定义注册进服务表，后到的同名定义整个 Section 静默丢弃（仅往 logd 里丢一行 ERROR）。它不报错给作者、不崩溃、不留痕于 `init.svc` 之外的任何用户可感知处。这决定了往系统加 rc 文件前必须做"服务名查重"，也是"组件命名要带品牌前缀"（如本文若走 rc 路线应叫 `load_remote_data` 而非 `load_remote`）的实践理由。

**关于 su 会话与进程组**：本文虽然最终证实 remotecfg 是上传型工具、无需考虑进程存活，但这个坑值得记录：多数 su 实现（Magisk、daemonsu 系）在授权命令退出后会清理子进程的进程组/会话，`su -c "xxx &"` 放到后台的进程若没有 `setsid`/`nohup` 双重保险，很可能随 su 会话一起被收割。需要常驻 root 进程时的稳妥写法是：

```bash
su -c "setsid nohup <命令> > /dev/null 2>&1 &"
```

**关于观测工具的毒性**：`ps | grep` 的三重陷阱（包名含关键字、grep 自匹配、`wc -l` 语义混淆）本质是同一个问题——观测行为污染了观测对象。更稳的替代是按 `/proc/<pid>/cmdline` 的完整内容做 case 匹配（见 6.3 节脚本），或用 `pgrep -f` 的精确模式。在任何自动化脚本里，凡是"数进程"的逻辑，都值得多花两行代码排除误报。

### 8.2 给同类需求读者的行动清单

如果你也有一台"想自定义红外遥控 / 想开机跑条命令"的 Amlogic 盒子，按这个顺序动手，可以避开本文趟过的所有坑：

1. **确认权限环境**：`adb shell su -c id` 看是否有 root、su 在哪个路径、是否需要交互授权；
2. **摸清遥控服务现状**：`getprop | grep -i remote` + `grep -rn remotecfg /system/etc/init /vendor/etc/init`，列出所有竞争者及其配置文件；
3. **判断 remotecfg 类型**：手动执行目标命令，立即用 `/proc/*/cmdline` 全扫确认它是常驻型还是上传型；
4. **手动验证配置有效性**：确认执行后遥控立刻生效且重启前持续有效，再谈自动化；
5. **选择自动化方案**：需要界面/可卸载选本文 APK 方案；能刷 Magisk 选模块脚本；能改系统分区且接受换 ROM 重做选 init.rc（记得服务名查重）；
6. **开机路径三件套**：延迟（等系统实例跑完）+ 清场（killall）+ 双轮重试（保险），并全程落盘日志；
7. **闭环验证**：重启后先看日志再按遥控，确认日志 SUCCESS 与物理键位双重通过。

---

## 9. 附录：完整源码与部署命令

### 9.1 项目文件树

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
└── build.sh (PowerShell 构建脚本，见 5.3 节)
```

### 9.2 RunService.java（v1.2 完整版核心）

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
                        .setContentText("正在执行 remotecfg ...")
                        .setOngoing(true).build()
                : new Notification.Builder(this)
                        .setSmallIcon(R.drawable.ic_launcher)
                        .setContentTitle("RemoteCfg")
                        .setContentText("正在执行 remotecfg ...")
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

        // 1. 等 /data 配置文件就绪（必须经 su 检查，app 自身无权 stat /data）
        boolean filesReady = false;
        for (int i = 1; i <= 10 && !filesReady; i++) {
            Result r = runSu(c, "test -f /data/remote.cfg -a -f /data/remote.tab && echo READY", 8000);
            appendLog(c, "wait[" + i + "] exit=" + r.exitCode + " out=" + r.out.trim());
            if (r.exitCode == 0 && r.out.contains("READY")) filesReady = true;
            else sleep(3000);
        }

        // 2. 开机路径：延迟 15s，等 ROM 自带遥控实例全部跑完再压轴上传
        if (!manual) {
            long settle = 15000 - (android.os.SystemClock.elapsedRealtime() - start);
            if (settle > 0) { appendLog(c, "boot settle delay " + settle/1000 + "s"); sleep(settle); }
        }

        // 3. 清场 + 双轮上传
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

        // 4. 兜底：app 具备高权限（priv-app）时不用 su 直连执行
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
            if (!fin) { p.destroyForcibly(); r.exitCode = -1; r.err = "timeout (可能 su 在等待授权)"; }
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

    public static void appendLog(Context c, String line) { /* 时间戳 + Log.i + 文件落盘 */ }
    public static File logFile(Context c)   { /* getExternalFilesDir 优先，内部存储兜底 */ }
    public static String readLog(Context c) { /* 供 MainActivity 展示 */ }
}
```

（`BootReceiver` 与 `MainActivity` 见 4.3 / 4.5 节，`AndroidManifest.xml` 见 4.2 节。）

### 9.3 部署与维护命令速查

```bash
# 安装/升级（签名一致可覆盖）
adb connect <盒子IP>:5555
adb install -r RemoteCfgBoot.apk

# 验证开机效果：重启后拉日志
adb shell su -c "cat /sdcard/Android/data/com.local.remotecfgboot/files/remotecfg_boot.log"

# 改键位后手动刷新（无需重启）
adb shell am startservice -n com.local.remotecfgboot/.RunService --ei manual true
# 或直接在 app 界面点"立即执行一次"

# 排查遥控竞争者
adb shell "getprop | grep -i remote"
adb shell su -c "grep -rn remotecfg /system/etc/init /vendor/etc/init"
```

### 9.4 已知限制与后续方向

- 依赖 root（su）；若部署到 priv-app 场景需配合 `seclabel` 或 SELinux 策略调整；
- 15 秒 settle 延迟是按本设备 ROM 实测设定的保守值，移植到其他盒子可按日志微调；
- 可扩展读取一个 app 私有目录下的"自定义延迟配置"，把时序参数外置；
- 若未来 ROM 把 targetSdk 门槛提高到 30+，需处理 `resources.arsc` 对齐、前台服务类型声明等新约束。

几条限制的展开说明：

**关于 root 依赖的本质。** 本 app 的特权边界只有一处——`su -c` 执行 remotecfg 与 `test -f`。root 在这里不是"绕过权限"，而是**跨界读写**的通行证：普通 app 按 Android 安全模型根本无权触碰 `/data` 根目录（那是系统数据区），无论怎么声明权限都不行。若未来做免 root 版本，正确路径不是找权限魔法，而是把配置文件挪到 app 有权的位置（如 `getExternalFilesDir()`），再想办法让系统 remotecfg 读那里——但那又回到 init.rc 改造的老路，两头都省不掉。

**关于 settle 延迟的脆弱性。** 15 秒是基于"本机 ROM 五个 init 实例在 12.9 秒左右启动"的实测值（见 6.3 节 `ro.boottime.*`）。它的本质是**用时间换确定性**——没有原子信号能告诉你"最后一个竞争者已经跑完了"。若要工程化，可以改成轮询检测：每秒以 su 执行 `getprop init.svc.remotecfg` 直到其值变为 `stopped` 再等 2 秒，即可把延迟从固定值压缩到实际需要的时间。本 app 未做这一层，是为把复杂度留在可解释的范围内。

**关于 targetSdk 30+ 的前置预告。** Android 11 起强制要求 `resources.arsc` 压缩对齐（`zipalign` 之外还需 aapt2 link 加 `--min-sdk-version` 配套参数）；Android 14 起前台服务必须声明类型（如 `dataSync`）并在清单加对应权限。这些变化不影响本文核心逻辑（广播 + 前台服务 + su 的骨架），但会让第 5 章的流水线多两个参数。手工构建的好处此时显现：**改哪一步，一眼就看得到**。

---

## 10. 参考资料

1. Android 官方文档 —《Background Execution Limits（后台执行限制）》：<https://developer.android.com/about/versions/oreo/background>（Android 8.0 后台服务限制与 `startForegroundService` 的 5 秒规则）
2. Android 官方文档 —《AAPT2》：<https://developer.android.com/tools/aapt2>（aapt2 compile/link 两段式资源编译、命令行用法）
3. Android 官方文档 —《WorkManager》：<https://developer.android.com/topic/libraries/architecture/workmanager>（持久化后台任务与重启恢复语义）
4. CoreELEC Wiki —《Walk through: Create an Amlogic remote.conf file》：<https://wiki.coreelec.org/remote:rr_walkthrough>（factory_code = custom_code(16bit)+index_code(16bit) 结构、IRMP 抓码工作流）
5. LibreELEC 论坛 —《Create remote.conf from scratch》（ippon, 2017）：<https://forum.libreelec.tv/thread/3581-create-remote-conf-from-scratch/>（remote.conf 全字段官方注释、`remotecfg remote.conf` 热加载技巧）
6. CoreELEC 论坛 PDF —《How Configure a Remote Control In CoreELEC Using Windows and Putty》：<https://discourse.coreelec.org/uploads/default/original/1X/00c45cd5a77202251eb427fd3299d7a43df8b68a.pdf>（ir-keytable -t 抓码 → rc_maps.cfg 的内核侧方案）
7. shkhuz —《An android app from scratch》：<https://shkhuz.github.io/blog/an-android-app-from-scratch.html>（Linux 下无 Gradle 手工构建 APK 的完整流水线与动机）
8. kotlowski —《Building an Android App Without Gradle or Android Studio》：<https://kotlowski.hashnode.dev/building-an-android-app-without-gradle-or-android-studio.md>（aapt2 → javac → d8 各步语义解读）
9. 2BAB（El Zhang）—《Extending Android Builds》1-4 章《Building An Android App by Hand》：<https://eab.2bab.com/doc/01/1-4-Build-An-Apk-Manually.html>（与 AGP Task 对齐的手工构建脚本，Ubuntu/macOS）
10. CSDN —《Android Service保活的几种方法总结》及开源项目 HelloDaemon / ServiceDaemon：常驻服务保活方案全景（与本文场景的差异化讨论见 7.2 节）

---

*完。如果这篇文章帮你少走了一段弯路，欢迎引用文中的排查思路——特别是那句：先怀疑你的观测工具，再怀疑系统。*
