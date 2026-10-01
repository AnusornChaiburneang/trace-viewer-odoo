# Console pages — overrides for MASTER.md

Applies to every Trace Kit Console page (Runs, Batch detail, Manual preview,
Dashboard, Flows, Targets, Compare). Rules here win over MASTER.md.

## Typography (Thai support)

MASTER pairs JetBrains Mono + IBM Plex Sans, which has no Thai glyphs.
UI labels and captions are Thai, so:

- Body: `"IBM Plex Sans Thai", "IBM Plex Sans", system-ui, sans-serif`
- Headings / data / commands: `"JetBrains Mono", "IBM Plex Sans Thai", ui-monospace, monospace`
  (Thai characters in headings fall back to Plex Sans Thai per glyph)
- Google Fonts: `family=IBM+Plex+Sans+Thai:wght@400;500;600&family=JetBrains+Mono:wght@400;600`

## Theme

Dark is the default (MASTER: avoid light-mode default). A light theme is still
provided for daytime office use. In light mode the green accent `#22C55E` fails
4.5:1 on white, so use `#15803D` for accent text and buttons.

| Token | Dark | Light |
|---|---|---|
| `--color-background` | `#0F172A` | `#F8FAFC` |
| `--color-card` | `#1B2336` | `#FFFFFF` |
| `--color-foreground` | `#F8FAFC` | `#0F172A` |
| `--color-muted-foreground` | `#94A3B8` | `#475569` |
| `--color-border` | `#334155` | `#E2E8F0` |
| `--color-accent` | `#22C55E` | `#15803D` |

## Run / step status

Status is never shown by color alone: every status pill carries its text label
(`passed`, `failed`, `skipped`, `running`) and a Lucide icon.

| Status | Dark fg / bg | Light fg / bg | Icon |
|---|---|---|---|
| passed | `#4ADE80` / `#12301F` | `#15803D` / `#DCFCE7` | `circle-check` |
| failed | `#F87171` / `#3A1A1D` | `#B91C1C` / `#FEE2E2` | `circle-x` |
| skipped | `#94A3B8` / `#272F42` | `#475569` / `#F1F5F9` | `circle-minus` |
| running | `#FBBF24` / `#362A10` | `#A16207` / `#FEF3C7` | `loader` (static when reduced motion) |

Live status changes use one `role="status"` region per run, with a full message
("T3 ล้มเหลวที่ขั้นที่ 4"), never a bare number.

## Tables

Step and transaction tables sit inside an `overflow-x: auto` wrapper; command
text is monospace and wraps inside the cell instead of widening the page.
