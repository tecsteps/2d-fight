#!/usr/bin/env python3
"""Assemble the progress artifact, inlining screenshots as data URIs.

Kept as a script rather than a hand-written HTML file because the screenshot set
grows every iteration and re-pasting base64 by hand does not scale.
"""
import base64
import io
import json
import os
import sys
from pathlib import Path

from PIL import Image

REPO = Path("/home/user/2d-fight")
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/artifact/index.html")


def data_uri(path: Path, max_w: int = 1280, quality: int = 82) -> str:
    im = Image.open(path).convert("RGB")
    im.thumbnail((max_w, max_w), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def shot(name: str, **kw) -> str:
    p = REPO / "shots" / name
    return data_uri(p, **kw) if p.exists() else ""


# ---------------------------------------------------------------- content ----

FIGHTERS = [
    dict(id="kai", name="KAI", epithet="Sudden Stillness", style="Full-Contact Karate",
         role="Shoto", c1="#2a4570", c2="#e2701f", c3="#e8e2d6",
         note="Navy sleeveless wrap gi, wide orange obi, black topknot."),
    dict(id="mali", name="MALI", epithet="Eight Limbs", style="Muay Thai",
         role="Striker", c1="#1f4a38", c2="#a8281c", c3="#c9a227",
         note="Teal bra with gold trim, black satin shorts, red wraps."),
    dict(id="davi", name="DAVI", epithet="Ginga Unbroken", style="Capoeira Regional",
         role="Rushdown", c1="#e0a318", c2="#1e50b4", c3="#ece5d5",
         note="Gold cropped hoodie, cream abadá, blue cord and wraps."),
    dict(id="vera", name="VERA", epithet="The Iron Clinch", style="Catch Wrestling",
         role="Grappler", c1="#b44a1b", c2="#4a2c42", c3="#ded6c6",
         note="Burnt-orange quilted vest, plum crop top, copper mohawk."),
]

# state: done | work | idle  ·  fill is 0..5 "stocks"
SYSTEMS = [
    ("Build + capture pipeline", "done", 5,
     "Vite build, headless Chromium, deterministic frame seek, PNG out."),
    ("Simulation core", "done", 5,
     "Fixed 60 Hz loop, seeded xoshiro128**, facing-relative motion parser."),
    ("Roster data", "done", 5,
     "Four fighters: palettes eyedropped from the sheets, per-archetype tuning."),
    ("Character rig + body mesh", "done", 4,
     "Closed genus-0 manifolds at ~20k tris, built in under a second each."),
    ("NPR shading", "done", 4,
     "Luminance-weighted light loop, one terminator per rig, ink outlines."),
    ("Post stack", "done", 4,
     "Bloom, in-code LUT grade, aberration, speed lines, streak, grain."),
    ("Engine: states + combat", "done", 4,
     "CNS-shaped states, CLSN boxes, hitstop, cancel hierarchy, gauges, match."),
    ("Procedural textures", "done", 4,
     "Noise kit, quilted / satin / knit / wrap weaves, skin, hair, stage."),
    ("Costumes", "work", 2,
     "Kai fully dressed on the garment framework; other three in flight."),
    ("Hair", "done", 4,
     "Braided mohawk, segmented braid, 28 separate locs, tied topknot — geometry."),
    ("Faces", "work", 1,
     "Features as geometry, eyes with a catch light, expression controls."),
    ("Lighting + grade", "done", 4,
     "Rig rebuilt; the floor pool that shaded fighters by screen position is gone."),
    ("Ink contour", "done", 4,
     "Constant 3px screen width, zero dropout, heavier where forms occlude."),
    ("Cel shading", "work", 2,
     "Hard terminator landed, but overcorrected into flat two-tone. Re-tuning."),
    ("Animation clips", "idle", 0,
     "Hand-keyed poses at a quantised draw rate to read as drawn, not lerped."),
    ("Stages", "idle", 0, "Parallax depth, animated crowd, volumetric light."),
    ("VFX", "idle", 0, "Hitsparks, impact frames, dust, trails, super flash."),
    ("Audio", "idle", 0, "WebAudio synthesis — no sample files."),
    ("HUD + screens", "idle", 0, "Health, power stocks, combo counter, select."),
]

LOG = [
    ("2026-08-12", "Kai is a character; the shading overcorrected",
     "Costume framework, hair on all four, and a rewritten ink contour all "
     "landed. The cel shading swung from soft Lambert to flat two-tone "
     "posterization that no longer describes anatomy, and the frame went too "
     "dark. Wave B3 dresses the other three while that is re-tuned."),
    ("2026-08-12", "The dashed contour was slope-scaled polygon offset",
     "polygonOffsetFactor is multiplied by depth slope, which is unbounded on "
     "surfaces near-tangent to view — exactly where interior contours live — so "
     "the ink shell was pushed behind the surface it had to draw over. Dropout "
     "on Vera's inner shin went 29.5% to 0.0%, and line width now holds at 3px "
     "whether the figure is 402px or 917px tall."),
    ("2026-08-12", "Review 001: 13/50, would not win",
     "A harsh critic measured rather than eyeballed, and caught two agents "
     "reporting behaviour the pixels contradicted: shadows were warmer than lit "
     "skin, not cooler, and the contour was a fresnel term rather than the "
     "inverted-hull ink its module implements."),
    ("2026-08-12", "Wave B1 fanned out",
     "Costume framework, hair, faces, and a lighting fix — four narrowly scoped "
     "agents. Wave A taught the lesson: its two subsystem-sized agents ran two "
     "hours, the three file-sized ones finished in twenty minutes."),
    ("2026-08-12", "Every capture so far was a 6x upscale",
     "The renderer's resize() early-returned on its first call, so the canvas "
     "kept its default 300x150 backing store stretched to full screen. It read "
     "as a blurry post stack and survived disabling post entirely."),
    ("2026-08-12", "Wave A integrated — zero type errors",
     "Five parallel agents, 16k lines, compiled together on the first try "
     "against the pre-agreed interface contracts. Bodies verified as closed "
     "genus-0 manifolds; the NPR light loop weights by per-light luminance so a "
     "three-point rig yields one terminator instead of three."),
    ("2026-08-12", "Scaffold landed",
     "Deterministic loop, seeded RNG, input buffer with motion recognition, "
     "render root with parallax layers, rail camera with trauma shake. Build green."),
    ("2026-08-12", "Roster defined",
     "Four fighters read off the design sheets the owner supplied; palettes "
     "sampled programmatically, proportions and movement tuned per archetype."),
    ("2026-08-12", "Capture harness proven",
     "Headless Chromium drives the build to an exact simulation frame and writes "
     "a PNG. Determinism here is what makes the blind critic comparison meaningful."),
    ("2026-08-12", "Wave A fanned out",
     "Five agents in parallel on disjoint subsystems, against fixed interface "
     "contracts so the work compiles together."),
]

SHOTS = [
    ("full-0000.png", "Kai dressed, ink contour rebuilt",
     "Costume, hair and continuous linework all land. The regression is just as "
     "visible: shading has flattened into two flat tones that describe no "
     "anatomy, and the whole frame is too dark."),
    ("lineup2-0000.png", "Four fighters — first real render",
     "Bodies, cel banding and ink outlines all working. Also the honest gap: "
     "nude, bald, faceless, and four distinct skin tones crushed into one "
     "orange. Wave B1 is closing exactly this."),
    ("lineup-0000.png", "The same frame before the resize fix",
     "Identical scene at a 300x150 backing store. Kept as the reminder that a "
     "quality problem is sometimes a one-line bug."),
    ("boot-0000.png", "Pipeline proof — frame 0",
     "Placeholder capsules under the key/fill/rim rig. Not the game; the proof "
     "that the build renders, seeks to a deterministic frame, and captures."),
]

done = sum(1 for s in SYSTEMS if s[1] == "done")
work = sum(1 for s in SYSTEMS if s[1] == "work")
pct = round(100 * (done + 0.2 * work) / len(SYSTEMS))

# ------------------------------------------------------------------ build ----

def stocks(fill: int, state: str) -> str:
    out = []
    for i in range(5):
        cls = "pip on" if i < fill else "pip"
        out.append(f'<i class="{cls}" data-state="{state}"></i>')
    return "".join(out)


cards = "\n".join(
    f"""      <article class="fighter" style="--c1:{f['c1']};--c2:{f['c2']};--c3:{f['c3']}">
        <div class="fighter-chip"><span></span><span></span><span></span></div>
        <h3>{f['name']}</h3>
        <p class="epithet">{f['epithet']}</p>
        <dl>
          <div><dt>Style</dt><dd>{f['style']}</dd></div>
          <div><dt>Role</dt><dd>{f['role']}</dd></div>
        </dl>
        <p class="note">{f['note']}</p>
      </article>"""
    for f in FIGHTERS
)

rows = "\n".join(
    f"""        <tr data-state="{st}">
          <th scope="row">{name}<span class="sub">{note}</span></th>
          <td class="meter">{stocks(fill, st)}</td>
          <td class="state"><span class="tag">{ {'done':'Landed','work':'In flight','idle':'Queued'}[st] }</span></td>
        </tr>"""
    for name, st, fill, note in SYSTEMS
)

log = "\n".join(
    f"""        <li>
          <time>{d}</time>
          <h4>{t}</h4>
          <p>{b}</p>
        </li>"""
    for d, t, b in LOG
)

figs = []
for fn, title, cap in SHOTS:
    uri = shot(fn)
    if not uri:
        continue
    figs.append(
        f"""      <figure>
        <img src="{uri}" alt="{title}" loading="lazy" />
        <figcaption><strong>{title}</strong>{cap}</figcaption>
      </figure>"""
    )
figs_html = "\n".join(figs) or '<p class="empty">No captures yet this iteration.</p>'

HTML = f"""<title>Ring Zero</title>
<style>
  /* Committed single-theme: this is an arcade cabinet, and it does not have a
     light mode. Every colour is painted explicitly so the page holds on any
     host ground. */
  :root {{
    --ground: #0b0d16;
    --surface: #141827;
    --surface-2: #1b2033;
    --line: #262d45;
    --ink: #ece7da;
    --muted: #868da8;
    --dim: #5c6480;
    --live: #46d39a;
    --work: #e9a441;
    --idle: #3d4460;
    --hot: #e2701f;
    --sp: clamp(1rem, 2.2vw, 1.6rem);
    --display: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }}

  * {{ box-sizing: border-box; }}

  body {{
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--display);
    font-size: 16px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }}

  /* Faint scanline wash — the one piece of arcade decoration, kept under 3%
     so it never fights the content. */
  body::before {{
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 99;
    background: repeating-linear-gradient(
      180deg, rgba(255,255,255,.022) 0 1px, transparent 1px 3px);
  }}

  .wrap {{
    max-width: 1080px;
    margin: 0 auto;
    padding: calc(var(--sp) * 2) var(--sp) calc(var(--sp) * 4);
    display: flex;
    flex-direction: column;
    gap: calc(var(--sp) * 2.6);
  }}

  /* ---------------------------------------------------------------- hero -- */
  .hero {{ display: flex; flex-direction: column; gap: 1.1rem; }}

  .eyebrow {{
    font-family: var(--mono);
    font-size: .68rem;
    letter-spacing: .34em;
    text-transform: uppercase;
    color: var(--dim);
    margin: 0;
  }}

  h1 {{
    margin: 0;
    font-size: clamp(2.9rem, 9vw, 5.6rem);
    font-weight: 800;
    letter-spacing: -.045em;
    line-height: .86;
    text-transform: uppercase;
    text-wrap: balance;
    transform: skewX(-5deg);
    transform-origin: left bottom;
  }}
  h1 em {{
    font-style: normal;
    display: block;
    color: var(--hot);
  }}

  .standfirst {{
    max-width: 60ch;
    margin: 0;
    color: var(--muted);
    font-size: 1.06rem;
  }}

  /* Overall completion, drawn as a fight health bar because that is the
     vernacular of the thing being built. */
  .healthbar {{ display: flex; flex-direction: column; gap: .5rem; margin-top: .4rem; }}
  .healthbar .cap {{
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: var(--mono); font-size: .7rem; letter-spacing: .2em;
    text-transform: uppercase; color: var(--dim);
  }}
  .healthbar .cap b {{ color: var(--ink); font-size: 1.4rem; letter-spacing: 0; font-variant-numeric: tabular-nums; }}
  .track {{
    height: 13px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    position: relative;
    overflow: hidden;
    transform: skewX(-16deg);
  }}
  .track i {{
    position: absolute; inset: 0 auto 0 0;
    background: linear-gradient(90deg, var(--hot), #f2c14a);
    box-shadow: 0 0 18px rgba(226,112,31,.5);
  }}

  /* ------------------------------------------------------------- section -- */
  section {{ display: flex; flex-direction: column; gap: 1.1rem; }}

  h2 {{
    margin: 0;
    font-size: .74rem;
    font-family: var(--mono);
    font-weight: 600;
    letter-spacing: .3em;
    text-transform: uppercase;
    color: var(--dim);
    padding-bottom: .65rem;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }}
  h2 span {{ color: var(--line); }}

  /* ------------------------------------------------------------- roster --- */
  .roster {{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(215px, 1fr));
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
  }}
  .fighter {{
    background: var(--surface);
    padding: 1.3rem 1.2rem 1.4rem;
    display: flex;
    flex-direction: column;
    gap: .55rem;
    position: relative;
  }}
  .fighter::after {{
    content: "";
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: linear-gradient(90deg, var(--c1) 0 50%, var(--c2) 50% 84%, var(--c3) 84%);
  }}
  .fighter-chip {{ display: flex; gap: 4px; }}
  .fighter-chip span {{ width: 15px; height: 15px; }}
  .fighter-chip span:nth-child(1) {{ background: var(--c1); }}
  .fighter-chip span:nth-child(2) {{ background: var(--c2); }}
  .fighter-chip span:nth-child(3) {{ background: var(--c3); }}

  .fighter h3 {{
    margin: .3rem 0 0;
    font-size: 1.65rem;
    font-weight: 800;
    letter-spacing: -.02em;
    line-height: 1;
  }}
  .epithet {{
    margin: 0; font-size: .84rem; font-style: italic; color: var(--c2);
  }}
  .fighter dl {{
    margin: .4rem 0 0; display: flex; flex-direction: column; gap: .28rem;
    font-family: var(--mono); font-size: .7rem;
  }}
  .fighter dl div {{ display: flex; gap: .5rem; }}
  .fighter dt {{ color: var(--dim); min-width: 3.4em; letter-spacing: .1em; text-transform: uppercase; }}
  .fighter dd {{ margin: 0; color: var(--ink); }}
  .note {{ margin: .35rem 0 0; font-size: .82rem; color: var(--muted); line-height: 1.5; }}

  /* -------------------------------------------------------------- board --- */
  .board-scroll {{ overflow-x: auto; }}
  table {{ width: 100%; border-collapse: collapse; font-size: .92rem; }}
  tbody tr {{ border-bottom: 1px solid var(--line); }}
  tbody tr:last-child {{ border-bottom: 0; }}
  th[scope="row"] {{
    text-align: left; font-weight: 600; padding: .85rem 1rem .85rem 0;
    display: flex; flex-direction: column; gap: .15rem;
  }}
  .sub {{ font-weight: 400; font-size: .78rem; color: var(--muted); }}
  td {{ padding: .85rem 0; vertical-align: middle; }}
  .meter {{ width: 132px; }}
  .pip {{
    display: inline-block; width: 20px; height: 9px; margin-right: 3px;
    background: var(--idle); transform: skewX(-16deg);
  }}
  .pip.on[data-state="done"] {{ background: var(--live); box-shadow: 0 0 9px rgba(70,211,154,.45); }}
  .pip.on[data-state="work"] {{ background: var(--work); box-shadow: 0 0 9px rgba(233,164,65,.45); }}
  .state {{ width: 108px; text-align: right; }}
  .tag {{
    font-family: var(--mono); font-size: .64rem; letter-spacing: .16em;
    text-transform: uppercase; padding: .28rem .5rem; border: 1px solid var(--line);
    color: var(--muted); white-space: nowrap;
  }}
  tr[data-state="done"] .tag {{ color: var(--live); border-color: rgba(70,211,154,.4); }}
  tr[data-state="work"] .tag {{ color: var(--work); border-color: rgba(233,164,65,.4); }}

  /* --------------------------------------------------------------- shots -- */
  figure {{ margin: 0; display: flex; flex-direction: column; gap: .7rem; }}
  figure img {{
    display: block; width: 100%; height: auto;
    border: 1px solid var(--line); background: #000;
  }}
  figcaption {{ font-size: .85rem; color: var(--muted); display: flex; flex-direction: column; gap: .18rem; }}
  figcaption strong {{
    color: var(--ink); font-family: var(--mono); font-size: .68rem;
    letter-spacing: .2em; text-transform: uppercase; font-weight: 600;
  }}
  .empty {{ color: var(--dim); font-family: var(--mono); font-size: .8rem; }}

  /* ----------------------------------------------------------------- log -- */
  .log {{ list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }}
  .log li {{
    display: grid; grid-template-columns: 7.5rem 1fr; gap: 0 1.4rem;
    padding: 1rem 0; border-bottom: 1px solid var(--line);
  }}
  .log li:last-child {{ border-bottom: 0; }}
  .log time {{
    font-family: var(--mono); font-size: .7rem; letter-spacing: .12em;
    color: var(--dim); padding-top: .2rem;
  }}
  .log h4 {{ margin: 0; font-size: 1rem; font-weight: 700; letter-spacing: -.01em; }}
  .log p {{ margin: .25rem 0 0; color: var(--muted); font-size: .89rem; max-width: 62ch; }}

  footer {{
    font-family: var(--mono); font-size: .68rem; letter-spacing: .16em;
    text-transform: uppercase; color: var(--dim);
    border-top: 1px solid var(--line); padding-top: 1.2rem;
    display: flex; flex-wrap: wrap; gap: .6rem 1.6rem;
  }}

  @media (max-width: 620px) {{
    .log li {{ grid-template-columns: 1fr; gap: .25rem; }}
    th[scope="row"] {{ padding-right: .6rem; }}
    .meter {{ width: 92px; }}
    .pip {{ width: 13px; }}
  }}
  @media (prefers-reduced-motion: reduce) {{
    * {{ animation: none !important; transition: none !important; }}
  }}
</style>

<div class="wrap">

  <header class="hero">
    <p class="eyebrow">Build log · Three.js · target: KOF XIII</p>
    <h1>Ring<em>Zero</em></h1>
    <p class="standfirst">
      A 2.5D fighting game built from nothing — every mesh, texture, animation and
      sound generated in code, with no asset ever loaded from disk. The bar is a
      blind side-by-side against <em>The King of Fighters XIII</em>.
    </p>
    <div class="healthbar">
      <div class="cap"><span>Systems landed</span><b>{pct}%</b></div>
      <div class="track"><i style="width:{pct}%"></i></div>
    </div>
  </header>

  <section>
    <h2>Roster <span>04 fighters</span></h2>
    <div class="roster">
{cards}
    </div>
  </section>

  <section>
    <h2>Systems <span>{done} landed · {work} in flight</span></h2>
    <div class="board-scroll">
      <table>
        <tbody>
{rows}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Captures <span>headless, deterministic</span></h2>
{figs_html}
  </section>

  <section>
    <h2>Log</h2>
    <ol class="log">
{log}
    </ol>
  </section>

  <footer>
    <span>Every asset generated in code</span>
    <span>Deterministic 60 Hz sim</span>
    <span>Updated {LOG[0][0]}</span>
  </footer>

</div>
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(HTML)
print(f"wrote {OUT} ({len(HTML)/1024:.0f} KB)")
