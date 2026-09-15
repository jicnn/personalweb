---
publishDate: 2026-09-15
draft: false
featured: true
title: "GPU Troubleshooting: A Complete Guide with RTX 2070 Diagnostic Example"
excerpt: "No schematics? No boardview? This guide uses the NVIDIA RTX 2070 (PG160 reference PCB) to walk through gold finger pinouts, onboard voltage test points, fault diagnosis procedures, and VRM analysis step by step."
tags: ['GPU', 'hardware-repair', 'RTX2070', 'multimeter', 'troubleshooting']
categories: ['hardware', 'repair']
---

When a GPU won't display, shows artifacts, or repeatedly crashes, diagnosing the problem without schematics or a boardview file is challenging—but far from impossible. With a multimeter, knowledge of the PCIe gold finger pinout, and an understanding of the power-up sequence, you can narrow down most GPU faults.

This guide uses the **NVIDIA RTX 2070 (PG160 reference PCB)** as a practical example, covering the complete troubleshooting workflow from theory to hands-on testing.

---

## Table of Contents

1. [GPU Power Architecture Overview](#power-architecture)
2. [PCIe Gold Finger Pinout](#gold-finger)
3. [Onboard Voltage Test Points](#voltage-test-points)
4. [RTX 2070 PCB Reference](#pcb-reference)
5. [Troubleshooting Procedure](#procedure)
6. [Common Fault Types](#fault-types)
7. [VRM Diagnosis](#vrm-diagnosis)
8. [GPU Power-Up Sequence](#power-sequence)
9. [Boardview: Obtaining and Using](#boardview)
10. [Repair Tool Checklist](#toolkit)
11. [Safety Precautions](#safety)

---

## GPU Power Architecture Overview {#power-architecture}

A modern GPU is not a single-voltage device. It has multiple voltage domains, each powered by an independent VRM (Voltage Regulator Module), following a strict power-up sequence—each rail enables only after the previous one reports "power good."

### Input Voltages

| Input Source | Voltage | Power | Source |
|-------------|---------|-------|--------|
| PCIe slot 12V | 12V | ~75W | Motherboard PCIe slot |
| PCIe slot 3.3V | 3.3V | ~10W | Motherboard PCIe slot |
| External 6-Pin | 12V | ~75W | PSU cable |
| External 8-Pin | 12V | ~150W | PSU cable |

The RTX 2070 Founders Edition uses one 8-Pin + one 6-Pin, with a TDP of ~215W.

### Onboard Voltage Rails

| Rail | Typical Value | Function | Resistance to Ground |
|------|--------------|----------|---------------------|
| **5V auxiliary** | 5.0V | PWM chip power, fan control | >1kΩ |
| **1.8V (VDD18)** | 1.8V | GPU logic init, I/O | ~200-600Ω |
| **PEXVDD** | ~1.0V | PCIe bridge power | ~100Ω |
| **NVVDD / MSVDD** | 0.7-1.0V | GPU core power | **0.1-0.8Ω (very low, NOT a short!)** |
| **FBVDD** | 1.25-1.35V | GDDR6 memory power | 20-60Ω |

### Critical Insight: NVVDD's "Fake Short"

GPU core power (NVVDD) typically measures only **0.1Ω to 0.8Ω** to ground—this will trigger a multimeter's continuity buzzer. **This is normal, not a short!** The GPU core requires tens to hundreds of amps, so it has massive parallel low-resistance paths internally.

The effective way to check for a core short is not measuring NVVDD-to-ground, but checking **whether there's a low-resistance path between 12V and NVVDD**—if 12V connects directly to the core (high-side MOSFET blown), that's a fatal short.

---

## PCIe Gold Finger Pinout {#gold-finger}

The RTX 2070 uses a standard PCIe x16 interface. Definitions:

- **Side A**: Front (chip/heatsink side)
- **Side B**: Back (backplate/SMD capacitor side)
- Pin numbers increase from the key (notch) leftward to rightward

### Left of Key (Pins 1-11)

| Pin | Name | Normal Resistance | Function |
|-----|------|-------------------|----------|
| A1, B1, B2, B3 | **12V (PCIe)** | ~400Ω - infinite | PCIe main 12V supply |
| A2, A3, B8 | **12V (aux)** | ~400Ω - infinite | PCIe logic 12V |
| A9, A10, B9, B10 | **3.3V (PCIe)** | ~300-600Ω | BIOS / logic chip power |
| A11 | **PERST#** | ~400-600Ω | PCIe Reset signal |

### Right of Key (Pins 12+)

| Pin | Name | Normal Resistance | Function |
|-----|------|-------------------|----------|
| B12 | **SMBCLK** | ~500-700Ω | I2C bus clock |
| B13 | **SMBDAT** | ~500-700Ω | I2C bus data |
| A13, A14 | **REFCLK+/-** | ~400-600Ω | PCIe reference clock |

### PCIe Data Lane Resistance Check

Both Side A and Side B have 32 direct data lanes to the GPU core. **Each lane should measure approximately equal resistance** (within a few points of each other). If one lane is significantly lower or higher, it strongly suggests GPU core damage.

- Side B PCIe data: ~300Ω
- Side A PCIe data (at coupling capacitors): ~200Ω
- A13/A14 clock signals: ~800Ω (direct to GPU—abnormal = core damage)

> **Measurement method**: Multimeter diode/continuity mode, red probe to ground (bracket or screw hole), black probe to target pin.

---

## Onboard Voltage Test Points {#voltage-test-points}

### 1. 12V Input (PCIe & 8-Pin)

- **Location**: Input fuse or large SMD capacitors
- **Resistance**: Hundreds of ohms or higher
- **Fault**: Near 0Ω = 12V supply short, **DO NOT POWER ON**

### 2. 5V Auxiliary

- **Location**: Small inductor near PWM chip (e.g., UP9512P)
- **Resistance**: ~1kΩ - several kΩ
- **Voltage**: Stable 5.0V
- **Fault**: Low resistance → possible MOSFET driver short

### 3. 1.8V Logic (VDD18)

- **Location**: Small inductor in mid-lower board area
- **Resistance**: ~200-600Ω
- **Voltage**: 1.8V (prerequisite for GPU initialization)
- **Fault**: PEX + 1.8V both shorted → likely dead core

### 4. PEXVDD (PCIe Bridge)

- **Resistance**: ~100Ω
- **Voltage**: 0.95-1.0V
- **Function**: PCIe signal communication
- **Fault**: Short = likely direct core damage

### 5. NVVDD / MSVDD (GPU Core)

- **Location**: Large inductors in a row (usually 6-8 phases)
- **Resistance**: **0.1-0.8Ω (very low, NOT a short!)**
- **Voltage**: 0.7-1.0V when powered
- **Note**: 20-series core cold resistance is ~0.1Ω—this is normal

### 6. FBVDD (GDDR6 Memory)

- **Location**: 1-2 independent inductors next to memory chips
- **Resistance**: ~20-60Ω
- **Voltage**: 1.25-1.35V
- **Note**: Samsung memory typically shows ~10-15Ω on memory rail

---

## RTX 2070 PCB Reference {#pcb-reference}

For the NVIDIA RTX 2070 Founders Edition (PG160 PCB), the functional areas are:

### Key Power Areas

| Area | Component Label | Function | Measurement |
|------|----------------|----------|-------------|
| GPU Core | TU104-400-A1 | Rendering compute core | — |
| GDDR6 Memory | 8 chips around core | VRAM | Test nearby filter capacitors |
| Core VRM | LR22 (8 gray inductors) | NVVDD/MSVDD core power | 0.1-0.8Ω |
| Memory VRM | LR47 (2 gray inductors) | FBVDD memory power | 20-60Ω |
| 1.8V/5V Area | R47, 1R0, 5R6 inductors + MOSFETs | Auxiliary logic | 1.8V / 5.0V |

### PCIe Gold Finger Area

- **Leftmost gold fingers** (left of key): 12V (A1-A3, B1-B3) and 3.3V (A9, A10)
- **A11 PERST#**: Should jump from 0V to 3.3V on power-up
- **8-Pin + 6-Pin** (top-right black connector): 12V input with fuse and filter capacitors below

### Board Backside Reference

The following shows the backside of a similar RTX 2070 class board:

![RTX 2070 GPU Backside PCB](https://www.techpowerup.com/review/evga-geforce-rtx-2070-super-ko/images/back.jpg)

> The backside is typically covered with SMD capacitors (decoupling) and is the primary area for measuring memory data lane resistance (via coupling capacitors) and checking for solder bridges or cold joints.

---

## Troubleshooting Procedure {#procedure}

```
[1. Offline Resistance Check] → [2. Power-On Voltage Test] → [3. Signal & Clock] → [4. Fault Isolation]
```

### Step 1: Offline Resistance Measurement (Prevent Board Damage)

**Tool**: Multimeter diode/continuity mode

**Procedure**:
1. Red probe to ground (bracket or screw hole), black probe to test points
2. Measure in this order:

| Test Point | Normal Value | Abnormal Meaning |
|-----------|-------------|------------------|
| PCIe 12V (A1/B1) | >400Ω | Near 0Ω = 12V short, **DO NOT POWER ON** |
| External 8+6-Pin | >400Ω | Near 0Ω = 12V short |
| PCIe 3.3V (A9/A10) | 300-600Ω | Low = 3.3V short |
| Core inductors (LR22) | 0.1-0.8Ω | **This is normal, not a short** |
| Memory inductors (LR47) | 20-60Ω | Low = memory or core issue |
| 1.8V inductor | 200-600Ω | Low = possible dead core |
| PEXVDD | ~100Ω | Low = PCIe bridge short |
| 5V inductor | >1kΩ | Low = MOSFET driver issue |

> ⚠️ **Safety Warning**: If any 12V line beeps at near 0Ω, **DO NOT insert into motherboard**—it will destroy the motherboard or PSU!

### Step 2: Power-On Voltage Sequence Test

If resistance checks pass, install the GPU on a test platform and measure voltages in sequence after pressing power:

```
12V / 3.3V → 5V → 1.8V → PEXVDD → NVVDD (core) → FBVDD (memory)
```

**Each voltage only appears after the previous one is good.**

| Test Point | Expected Voltage | Location |
|-----------|-----------------|----------|
| 12V input | 12.0V | Gold finger / external |
| 3.3V | 3.3V | Gold finger A9/A10 |
| 5V aux | 5.0V | 5V inductor output |
| 1.8V | 1.8V | 1.8V inductor output |
| PEXVDD | 0.95-1.0V | PEX inductor output |
| NVVDD | 0.7-1.0V | LR22 large inductors |
| FBVDD | 1.25-1.35V | LR47 inductors |

### Step 3: Measure Key Signals

If all voltages are normal but still no display:

- **A11 PERST#**: Should jump from 0V to 3.3V on power-up. Stuck at 0V = motherboard didn't detect GPU or GPU failed initialization
- **A13/A14 REFCLK**: PCIe reference clock—needs oscilloscope to verify waveform
- **B12/B13 SMBCLK/SMBDAT**: I2C bus for GPU BIOS reading

### Step 4: Fault Isolation

Use the segment isolation method:
1. Remove heatsink, clean thermal paste
2. Inspect PCB backside under magnification for burn marks
3. Measure each VRM phase's MOSFET/DrMOS individually
4. Compare with known-good resistance values from the same model

---

## Common Fault Types {#fault-types}

### Fault Type 1: Complete Power Failure (PSU Protection Triggers)

| Possible Cause | Diagnosis | Prognosis |
|---------------|-----------|-----------|
| 12V main short | Measure 12V to ground ≈ 0Ω | Need to trace shorted component |
| High-side MOSFET blown | Low resistance 12V-to-NVVDD | **GPU core likely dead** |
| Low-side MOSFET blown | NVVDD short to ground, 12V OK | GPU may survive—repairable |
| Input fuse blown | Test fuse continuity | Replace fuse |

### Fault Type 2: Power Present, No Display (Fans Spin, Black Screen)

| Possible Cause | Diagnosis | Prognosis |
|---------------|-----------|-----------|
| 1.8V / PEXVDD missing | Measure corresponding inductors | Check PWM chip and enable signals |
| Core power not starting | Measure NVVDD voltage | Check PGOOD signal chain |
| Memory power abnormal | Measure FBVDD voltage and resistance | Memory chips may be damaged |
| PERST# invalid | Measure A11 pin voltage | Check motherboard or GPU init |
| Memory cold solder | Measure data lane resistance (backside coupling caps) | Reball required |

### Fault Type 3: Artifacts / Visual Corruption

| Possible Cause | Diagnosis | Prognosis |
|---------------|-----------|-----------|
| VRAM chip damaged | Measure each chip's resistance | Replace bad chip |
| Memory cold solder | Observe after heat gun bake | Reball |
| GPU core degradation | Check with GPU-Z | Core may be aging |
| Cooling failure | Measure temperatures | Replace cooling |

### Fault Type 4: Sudden Black Screen / Reboot Under Load

| Possible Cause | Diagnosis | Prognosis |
|---------------|-----------|-----------|
| VRM thermal protection | Thermal camera scan of VRM area | Improve cooling |
| Memory overheating | IR thermometer | Improve memory cooling |
| Core cold solder | Pressure test (press on GPU core) | Reball |
| Phase imbalance | Measure voltage per phase | Replace damaged DrMOS |

---

## VRM Diagnosis {#vrm-diagnosis}

### VRM Fundamentals

The GPU core needs 0.7-1.0V at tens to hundreds of amps. The VRM steps down 12V to this, with each phase using two MOSFETs:

- **High-side**: Connects 12V to inductor
- **Low-side**: Connects inductor to ground

The PWM controller alternates these at high frequency (300kHz - several MHz), and the inductor smooths the output to the target voltage.

### DrMOS Integration

Modern GPUs (including RTX 2070) use DrMOS integrated packages—driver, high-side, and low-side MOSFETs in one QFN chip. The RTX 2070's 8-phase core VRM likely uses DrMOS.

### MOSFET Failure Diagnosis

| Failure Type | Ground Behavior | Impact on GPU | Repairability |
|-------------|-----------------|---------------|---------------|
| High-side blown | 12V directly to NVVDD | **Almost certainly kills core** (12V floods in) | Very low |
| Low-side blown | NVVDD short to ground | GPU may survive | Repairable (replace DrMOS) |
| Driver damaged | Phase has no output | Repairable | Repairable (replace PWM/driver) |

### Diagnostic Steps

1. **Visual inspection**: Check DrMOS for burn marks, PCB discoloration
2. **Measure 12V-to-NVVDD**: Low resistance = high-side blown
3. **Measure NVVDD-to-ground**: Short = low-side blown or core short
4. **Phase-by-phase isolation**: With parallel phases, disconnect each one individually
5. **Thermal imaging**: Power on briefly, scan for abnormally hot phases

---

## GPU Power-Up Sequence {#power-sequence}

Understanding the power-up sequence is key to diagnosing "power present, no display." GPU voltages don't appear simultaneously—they follow a strict order:

```
1. 12V / 3.3V input (PCIe + external)
   ↓
2. 5V auxiliary (stepped down from 12V)
   ↓
3. 1.8V VDD18 (stepped down from 3.3V)
   ↓
4. PEXVDD ~1.0V (PCIe bridge power)
   ↓
5. FBVDD 1.35V (memory power)
   ↓ PGOOD signal
6. NVVDD 0.7-1.0V (core power)
   ↓
7. GPU initialization → PERST# response → Normal operation
```

**Critical Dependencies**:
- PEXVDD and 1.8V both connect directly to GPU core—shorts almost always kill the core
- FBVDD's PGOOD signal typically enables NVVDD
- If any link in the chain breaks, downstream voltages won't appear

### Sequence Diagnosis Example

**Symptom**: Core voltage (NVVDD) has no output

**Investigation path**:
1. Check if 12V reaches PWM chip input
2. Check if 5V auxiliary is present (PWM needs 5V to work)
3. Check if 1.8V is present
4. Check if PEXVDD is present
5. Check if FBVDD is present and issuing PGOOD
6. Check if NVVDD PWM chip's EN (enable) pin receives signal
7. If EN is good but still no output → PWM chip or DrMOS damaged

---

## Boardview: Obtaining and Using {#boardview}

After multimeter measurements reveal an abnormality, use a boardview file to precisely locate the corresponding component and traces on the PCB.

### Recommended Software

| Software | Type | Notes |
|----------|------|-------|
| **OpenBoardView** | Free open-source | Supports .fz / .cad formats |
| **FlexBV** | Commercial | More comprehensive features |
| **Compañero** | Free | User-friendly interface |

### Search Keywords

Search on repair forums (ChinaFix, TechPowerUp, Vinafix, etc.):

- `RTX 2070 Boardview`
- `PG160 boardview` (PG160 = NVIDIA RTX 2070 reference PCB)
- `RTX 2070 schematic`
- `TU104 boardview`

### Usage Method

1. Open `.cad` or `.fz` file with OpenBoardView
2. Search for component labels (e.g., `LR22`, `LR47`, `UP9512`)
3. Software highlights the component's position on the PCB
4. Search net names (e.g., `NVVDD`, `12V`, `PERST`) to highlight all connected points
5. Locate test points for multimeter probing

### Front Side Reference

The following shows the front side of a similar RTX 2070 class board:

![RTX 2070 GPU Front PCB](https://www.techpowerup.com/forums/attachments/front-jpg.127463/)

---

## Repair Tool Checklist {#toolkit}

### Essential Tools

| Tool | Purpose | Recommended Spec |
|------|---------|-----------------|
| Digital multimeter | Resistance/voltage measurement | Auto-ranging, diode mode |
| Soldering station | Soldering/desoldering | 936 or better |
| Hot air gun | SMD removal | 858D or better |
| BGA rework station | GPU/memory removal | Preheater + top heater |
| Magnifier/microscope | Solder joint inspection | 10x-40x |
| Anti-static wristband | Component protection | — |

### Advanced Tools

| Tool | Purpose |
|------|---------|
| Thermal camera | Rapidly locate short-circuit hotspots |
| Adjustable DC power supply | Current-limited power-on testing |
| Oscilloscope | Measure clock and signal waveforms |
| DC electronic load | Test VRM load capacity |
| Stencil/solder balls | BGA reballing |

### DC Power Supply Current-Limited Method

Recommended: Use an **adjustable DC power supply** instead of ATX for initial power-on testing:

1. Set DC supply to 12V, current limit to **0.5A** (very low)
2. Connect to GPU 12V input
3. Power on and observe current:
   - **0A or very low**: Possible open circuit, PWM not starting
   - **0.5A and rising**: Short exists, supply is current-limiting
   - **Normal standby**: ~0.1-0.3A (heatsink cool, GPU idle)
4. If no abnormality, gradually increase limit: 1A → 2A → 5A
5. Touch each DrMOS/PWM chip, check for abnormal heating

---

## Safety Precautions {#safety}

### Anti-Damage Principles

1. **Measure resistance before powering on**: Always do offline resistance check first, confirm no 12V short before applying power
2. **Current-limited power-on**: Use DC supply with current limiting for initial test, not direct ATX
3. **No heatsink = no power for more than 10 seconds**: GPU core overheats extremely quickly without cooling
4. **Don't blindly remove memory chips**: Without running MATS (memory test tool), randomly removing VRAM has very low success rate
5. **After removing memory, measure signal lane resistance**: Removing memory without checking signal resistance and reinstalling is wasted effort

### Lethal Rails: PEXVDD / 1.8V / Memory Power

PEXVDD, 1.8V power, and memory power all **connect directly to the GPU core**. If any of these rails is shorted, core damage probability is approximately **99.9%**. While there are extremely rare cases where removing the shorted component restores power, the vast majority result in permanent core death.

**Used GPU buying advice**: If PEXVDD, 1.8V, or memory power shows a short → reject the card entirely. Do not gamble.

### Soldering Safety

- Hot air gun temperature: ~**350-400°C** for SMD MOSFETs, ~**230-250°C** for BGA (with preheater)
- Replacement components must be the **exact same model** (suffix code must match)
- Wear anti-static wristband before handling
- After soldering, always re-measure resistance to confirm no solder bridges

---

## Conclusion

GPU troubleshooting requires patience and systematic thinking. The core methodology:

1. **Look before you measure**: Visual inspection reveals many issues (burns, missing components, cold joints)
2. **Measure resistance before powering on**: Preventing secondary damage is the first priority
3. **Follow the power sequence**: Understand voltage generation order, trace from source to downstream
4. **Comparison is powerful**: Having a known-good card of the same model to compare resistance values is ten times more efficient
5. **PEXVDD/1.8V short = core likely dead**: Don't waste time on unrepairable boards
6. **Use boardview effectively**: OpenBoardView + correct file makes repair much more efficient

If you have GPU repair questions or need help diagnosing a specific fault, feel free to reach out via the [Contact](/contact) page.

> **Disclaimer**: This article is based on publicly available technical documentation and community experience. GPU repair involves high-temperature operations and high-power circuits, which carry inherent risks. Non-professionals should not attempt these procedures—please consult a professional repair service. The author is not responsible for any losses resulting from following this guide.
