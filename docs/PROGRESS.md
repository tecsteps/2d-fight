# Progress

Source of truth for resuming after a container restart. See `CLAUDE.md` §0.

Updated: 2026-08-12

---

## Artifact

Progress page (screenshots, systems board, build log):
<https://claude.ai/code/artifact/500c2fc7-c2fb-42f4-a0e1-112ad50e6356>

Rebuild and redeploy with:

```
python3 tools/artifact/build.py /tmp/artifact/index.html
# then: Artifact({file_path: "/tmp/artifact/index.html", url: "<the URL above>"})
```

Always pass `url` when republishing from a *new* session, or it creates a second
artifact instead of updating this one.

---

## Status

| System | State | Critic score |
| --- | --- | --- |
| Build + capture pipeline | ✅ green | — |
| **Overall frame (review 001)** | 🔨 | **13 / 50 — would not win** |
| Deterministic sim core (loop, RNG, input) | ✅ landed | — |
| Roster data (4 fighters) | ✅ landed | — |
| Character rig + body mesh | ✅ landed | — |
| NPR shading | ✅ landed | — |
| Post stack | ✅ landed | — |
| Engine (states, combat, gauges, match) | ✅ landed | — |
| Procedural textures | ✅ landed | — |
| Costumes | 🔨 wave B1 (Kai + framework) | — |
| Hair | 🔨 wave B1 | — |
| Faces | 🔨 wave B1 | — |
| Lighting + grade | 🔨 wave B1 | — |
| Animation clips | ⬜ wave C | — |
| Stages | ⬜ wave C | — |
| VFX (hitsparks, impact frames, dust) | ⬜ wave C | — |
| Audio synthesis | ⬜ wave D | — |
| HUD + screens | ⬜ wave D | — |

Legend: ✅ done · 🔨 in flight · ⬜ not started

---

## Workflow runs

Restart a dead workflow with
`Workflow({scriptPath, resumeFromRunId})` — completed agents return cached
results instantly, so only unfinished work re-runs.

| Wave | Run ID | Script | State |
| --- | --- | --- | --- |
| A — core systems | `wf_b522008f-4bd` | `.../scripts/fight-wave-a-wf_b522008f-4bd.js` | ✅ 5/5, 0 errors |
| B1 — costume fw, hair, faces, light | `wf_ee17e0d5-293` | `.../scripts/fight-wave-b1-wf_ee17e0d5-293.js` | in flight |
| B2 — ink contour, cel shading | `wf_f293159d-9c2` | `.../scripts/fight-wave-b2-ink-wf_f293159d-9c2.js` | in flight (queued behind B1) |

Script dir:
`/root/.claude/projects/-home-user-2d-fight/8c969954-8496-5608-ae1a-3f71afc837ed/workflows/scripts/`

---

## The four fighters

Design sheets in `/reference` (art direction only — never imported).

| id | name | style | archetype |
| --- | --- | --- | --- |
| `kai` | KAI — *Sudden Stillness* | Full-Contact Karate | shoto |
| `mali` | MALI — *Eight Limbs* | Muay Thai | striker |
| `davi` | DAVI — *Ginga Unbroken* | Capoeira Regional | rushdown |
| `vera` | VERA — *The Iron Clinch* | Catch Wrestling | grappler |

---

## Reviews

| # | Frame | Score | Verdict |
| --- | --- | --- | --- |
| [001](reviews/001-lineup-baseline.md) | baseline lineup | 13 / 50 | no — ~15% there |

Review 001 caught two places where a wave-A agent's self-report did not match the
pixels (shadows measured *warmer* than lit skin, not cooler; the ink outline is a
fresnel term, not the inverted hull it claims). **Agent self-reports are not
verification — measure the frame.**

---

## Open items

- **KOF XIII reference frames are needed for a real blind comparison.** The egress
  policy blocks every image host (403 on CONNECT), so `tools/critic/sheet.py`
  runs in rubric mode. Drop frames into `reference/kof13/` and blind mode
  switches on automatically.
- The roster gallery URL (`fighter-roster-gallery.fabianwesner.chatgpt.site`) is
  blocked by org egress policy. Character definitions were built from the design
  sheets the project owner uploaded directly. If the site carries stats or lore
  we do not have, it needs to be pasted in.

---

## Capture scenes

`main.ts` selects by query string so each subsystem is scored in isolation:

```
node tools/shots/capture.mjs --scene lineup                       # all four fighters
node tools/shots/capture.mjs --scene solo --fighter kai            # one fighter
node tools/shots/capture.mjs --scene npr                           # shading swatches
node tools/shots/capture.mjs --scene tex                           # texture sheet
node tools/shots/capture.mjs --scene lineup --post 0               # bypass post
```

## Next

1. Wave B2: Mali, Davi and Vera costumes on the framework Kai proves out.
2. Wave C: animation clips (fighting stances first — the current neutral pose
   reads as a slumped mannequin), first real stage, VFX.
3. Stand up the blind critic harness and get a first score.
