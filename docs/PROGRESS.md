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
| Deterministic sim core (loop, RNG, input) | ✅ landed | — |
| Roster data (4 fighters) | ✅ landed | — |
| Character rig + body mesh | 🔨 wave A | — |
| NPR shading | 🔨 wave A | — |
| Post stack | 🔨 wave A | — |
| Engine (states, combat, gauges, match) | 🔨 wave A | — |
| Procedural textures | 🔨 wave A | — |
| Animation clips | ⬜ wave B | — |
| Stages | ⬜ wave B | — |
| VFX (hitsparks, impact frames, dust) | ⬜ wave B | — |
| Audio synthesis | ⬜ wave C | — |
| HUD + screens | ⬜ wave C | — |

Legend: ✅ done · 🔨 in flight · ⬜ not started

---

## Workflow runs

Restart a dead workflow with
`Workflow({scriptPath, resumeFromRunId})` — completed agents return cached
results instantly, so only unfinished work re-runs.

| Wave | Run ID | Script | State |
| --- | --- | --- | --- |
| A — core systems | `wf_b522008f-4bd` | `.../scripts/fight-wave-a-wf_b522008f-4bd.js` | in flight |

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

## Open items

- The roster gallery URL (`fighter-roster-gallery.fabianwesner.chatgpt.site`) is
  blocked by org egress policy. Character definitions were built from the design
  sheets the project owner uploaded directly. If the site carries stats or lore
  we do not have, it needs to be pasted in.

---

## Next

1. Integrate wave A, typecheck, screenshot each subsystem in isolation.
2. Wave B: animation clips, first real stage, VFX.
3. Stand up the blind critic harness and get a first score.
