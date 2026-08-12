#!/usr/bin/env python3
"""Assemble the project artifact, inlining captures as data URIs.

A script rather than hand-written HTML because the screenshot set grows every
wave and re-pasting base64 by hand does not scale.

  python3 tools/artifact/build.py /tmp/artifact/index.html
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image

REPO = Path("/home/user/2d-fight")
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/artifact/index.html")


def uri(rel: str, max_w: int = 1280, q: int = 82, crop=None) -> str:
    p = REPO / rel
    if not p.exists():
        return ""
    im = Image.open(p).convert("RGB")
    if crop:
        im = im.crop(crop)
    im.thumbnail((max_w, max_w * 2), Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, "JPEG", quality=q, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()


# ---------------------------------------------------------------- content ----

FIGHTERS = [
    dict(id="kai", name="KAI", epithet="Sudden Stillness", style="Full-Contact Karate",
         role="Shoto", hp="1020", c1="#2a4570", c2="#e2701f", c3="#e8e2d6",
         note="Navy sleeveless wrap gi with a two-panel overlap, wide orange obi "
              "knotted with a hanging tail, charcoal calf-length pants, black topknot."),
    dict(id="mali", name="MALI", epithet="Eight Limbs", style="Muay Thai",
         role="Striker", hp="1000", c1="#1f4a38", c2="#a8281c", c3="#c9a227",
         note="Teal racerback bra with gold piping, black satin shorts with flared "
              "red side panels, red hand and ankle wraps, segmented braid. Barefoot."),
    dict(id="davi", name="DAVI", epithet="Ginga Unbroken", style="Capoeira Regional",
         role="Rushdown", hp="980", c1="#e0a318", c2="#1e50b4", c3="#ece5d5",
         note="Open gold cropped hoodie over a bare chest, cream abadá with a blue "
              "side stripe, blue cord belt, 28 individually-chained locs. Barefoot."),
    dict(id="vera", name="VERA", epithet="The Iron Clinch", style="Catch Wrestling",
         role="Grappler", hp="1150", c1="#b44a1b", c2="#4a2c42", c3="#ded6c6",
         note="Burnt-orange quilted puffer vest with a stand collar, plum crop top, "
              "charcoal compression shorts, knee pads, laced maroon boots."),
]

REVIEWS = [
    dict(n="001", frame="Baseline lineup", score=13, gap="~15%",
         head="Nude, bald, faceless — and measured, not eyeballed",
         body="The critic sampled pixels rather than impressions, which caught two "
              "agents reporting behaviour the frame contradicted: shadows measured "
              "<em>warmer</em> than lit skin, not cooler, and the contour was a fresnel "
              "rim rather than the inverted-hull ink its own module implements."),
    dict(n="002", frame="First dressed lineup", score=15, gap="~18%",
         head="The ink fix was cancelled by the lighting fix",
         body="Two agents optimised independently. Ink was told to colour contours as a "
              "dark tint of the local surface — correct for a mid-value stage. Lighting "
              "simultaneously took the stage to near-black. A dark tint of anything on a "
              "black ground is invisible: median ink contrast measured <strong>6.6 "
              "luminance units</strong>. Both hit their targets; the frame got worse."),
    dict(n="003", frame="Dressed roster", score=18, gap="~27%",
         head="Caught us gaming the budget, twice",
         body="<code>pct_above_128</code> was passed by brightening an <em>empty floor "
              "plane</em> — only 2.2% of the frame was bright character. And band "
              "statistics were passed at whole-character granularity that averages a navy "
              "gi with bare skin; broken out, Kai's gi is <strong>61% in one 8-L bin</strong>. "
              "Both holes are now closed."),
]

# state: done | work | idle · fill 0..5
SYSTEMS = [
    ("Deterministic simulation core", "done", 5,
     "Fixed 60 Hz loop, seeded xoshiro128**, facing-relative motion parser. Replay "
     "from a mid-run checkpoint reproduces the straight run exactly."),
    ("Engine: states, combat, gauges", "done", 5,
     "CNS-shaped state machine, CLSN boxes, hitstop, KOF cancel hierarchy, power/drive/HD, "
     "3v3 match flow. 10 contacts and 535 damage over a 600-tick scripted bout."),
    ("Character rig + body mesh", "done", 5,
     "Closed genus-0 manifolds at ~20k tris. Hands have fingers and thumbs, feet have "
     "ankles and toe breaks."),
    ("Procedural textures", "done", 5,
     "Noise kit, quilted / satin / knit / bandage weaves, skin pores, hair sheen, "
     "concrete, brick, worn wood, painted metal."),
    ("Costumes — all four", "done", 5,
     "Offset-surface shells traced to the body field's zero level set, with rolled hems, "
     "swept trims and verlet-baked free cloth."),
    ("Hair — all four", "done", 4,
     "Braided mohawk, segmented braid, 28 chained locs, tied topknot. Geometry, not cards."),
    ("Faces", "done", 4,
     "~50-primitive skull sculpt displacing the body's own vertices, eyes with catch "
     "lights, morph-driven brow / squint / mouth / snarl."),
    ("Ink contour", "done", 4,
     "Constant 3px screen width across a 2× zoom, contrast 6.6 → 37.9–45.5 L."),
    ("Lighting + value structure", "done", 4,
     "Every global budget row passing. Bloom halo and the position-dependent floor "
     "brightness both eliminated."),
    ("Cel shading", "work", 3,
     "Bands restored after finding the flat fill was double-counted shadow. Skin shadow "
     "retuned off plum; ratio and per-character separation still short."),
    ("Stage", "work", 1,
     "Value structure and contact shadows land. Parallax, props and atmosphere do not."),
    ("Animation", "idle", 1,
     "Poses authored and ready to wire. No clips, no impact frames yet."),
    ("Audio", "idle", 0, "WebAudio synthesis — no sample files. Not started."),
    ("HUD + screens", "idle", 0, "Health, power stocks, combo counter, select. Not started."),
]

BUDGET = [
    ("Median frame luminance", "21.1", "52.2", "48–72", True),
    ("Pixels below L=16", "35.3%", "1.17%", "&lt; 8%", True),
    ("Pixels above L=128", "2.5%", "10.7%", "&gt; 8%", True),
    ("Channel clipping", "2.41%", "0.00%", "0.00%", True),
    ("Floor variation across x", "2.60×", "1.22×", "&lt; 1.4×", True),
    ("Background lift near figures", "+60%", "+4.4%", "&lt; 10%", True),
    ("Ink-to-background contrast", "6.6 L", "37.9–45.5 L", "&gt; 40 L", None),
    ("Skin shadow / lit ratio", "0.14–0.27", "0.45–0.57", "0.60–0.75", False),
    ("Shadow-colour distance", "7.7", "18.4", "&gt; 40", False),
]

FINDINGS = [
    ("Every capture was a 6× upscale",
     "<code>resize()</code> early-returned on its first call because width and height were "
     "seeded with the expected viewport, so <code>setSize()</code> never ran and the canvas "
     "kept its default 300×150 backing store, CSS-stretched to 1080p. It presented as "
     "&ldquo;the post stack looks blurry&rdquo; and survived disabling post entirely."),
    ("The dashed ink contour was slope-scaled polygon offset",
     "<code>polygonOffsetFactor</code> is multiplied by depth slope, which is unbounded on "
     "surfaces near-tangent to view — exactly where interior contours live — so the ink "
     "shell was pushed behind the surface it had to draw over. Dropout on Vera's inner "
     "shin went <strong>29.5% → 0.0%</strong>."),
    ("The flat fill was a double-counted shadow map",
     "<code>shade</code> was <code>lum(directDiffuse)/reference</code>, and "
     "<code>directDiffuse</code> is already shadow-attenuated — so a surface turned from "
     "the key was darkened twice, once by its own N·L and again by the shadow map. The "
     "second is binary, so the entire dark side collapsed onto ramp coordinate 0."),
    ("The floor pool was a point light",
     "A fighter at midscreen shaded differently from the same fighter in the corner, and "
     "inverse-square did the rest — a large part of why four distinct skin tones rendered "
     "as one orange. It is now additive floor geometry that grounds the fighters and "
     "contributes nothing to their shading."),
    ("A body-type fix rebuilt the roster's powerhouse as a man",
     "<code>fem</code> was <em>inferred</em> from hip ÷ shoulder. Widening Vera's shoulders "
     "to the width her design shows dropped the inferred value to ~0.09. Width and sex are "
     "two independent axes; <code>fem</code> is now authored."),
    ("Shadow separation was bounded by roster data, not shading",
     "The four lit skin hexes had a minimum pairwise distance of <strong>11.4</strong> "
     "because Kai's and Vera's sat 2° apart in hue. No shadow derivation produces 40 units "
     "of separation from inputs 11 apart. Pulled apart to 34.1."),
    ("The measurement tool only worked on frames that failed",
     "Its per-figure mask used a column median as a stand-in for &ldquo;background&rdquo;, "
     "which holds only while the stage is nearly black. On a stage meeting the budget, the "
     "near floor passed the mask and every per-figure number became part ground. Fixed "
     "with a real matte pass."),
    ("The hang detector was blind to the normal case",
     "It checked the newest transcript across the whole workflow, which is always fresh "
     "while any sibling is writing — so it missed an agent that died to a 529 for 26 "
     "minutes. It now tracks staleness per agent and distinguishes a corpse from silence."),
]

SHOTS = [
    ("shots/chk-lineup-0000.png", "Current — the dressed roster",
     "All four fighters: modelled, costumed, faced and haired entirely in code. Every "
     "global value-budget row passing."),
    ("shots/v3-0000.png", "Review 003 — before the skin retune",
     "The same frame with the plum shadow the critic measured across 30–35% of Mali's and "
     "Kai's bare skin."),
    ("shots/full-0000.png", "Review 002 — Kai dressed, shading overcorrected",
     "Costume and ink land; the cel bands have collapsed into two flat tones and the frame "
     "is far too dark. 35% of pixels below L=16."),
    ("shots/lineup2-0000.png", "Review 001 — the baseline",
     "Bodies, cel banding and ink outlines working. Nude, bald, faceless, and four distinct "
     "skin tones crushed into one orange."),
    ("shots/boot-0000.png", "Frame zero — pipeline proof",
     "Placeholder capsules under the key/fill/rim rig. Not the game: the proof that the "
     "build renders, seeks a deterministic frame, and captures."),
]

done = sum(1 for s in SYSTEMS if s[1] == "done")
work = sum(1 for s in SYSTEMS if s[1] == "work")
pct = round(100 * (done + 0.4 * work) / len(SYSTEMS))

# ------------------------------------------------------------------ build ----

def stocks(fill, state):
    return "".join(
        f'<i class="pip{" on" if i < fill else ""}" data-state="{state}"></i>' for i in range(5)
    )

# Portraits are resolved before the template: a data URI inside a nested f-string
# is a quoting trap, and the fallback needs to be a plain empty div anyway.
for _f in FIGHTERS:
    _u = uri(f"shots/card-{_f['id']}-0000.png", 560)
    _f["portrait"] = f'<img src="{_u}" alt="{_f["name"]}" loading="lazy" />' if _u else ""

cards = "\n".join(
    f"""      <article class="fighter" style="--c1:{f['c1']};--c2:{f['c2']};--c3:{f['c3']}">
        <div class="portrait">{f['portrait']}</div>
        <div class="fighter-body">
          <div class="chips"><span></span><span></span><span></span></div>
          <h3>{f['name']}</h3>
          <p class="epithet">{f['epithet']}</p>
          <dl>
            <div><dt>Style</dt><dd>{f['style']}</dd></div>
            <div><dt>Role</dt><dd>{f['role']}</dd></div>
            <div><dt>HP</dt><dd>{f['hp']}</dd></div>
          </dl>
          <p class="note">{f['note']}</p>
        </div>
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

budget_rows = "\n".join(
    f"""        <tr>
          <th scope="row">{q}</th>
          <td class="num was">{was}</td>
          <td class="num now">{now}</td>
          <td class="num tgt">{tgt}</td>
          <td class="verdict">{'<span class="ok">pass</span>' if ok else ('<span class="near">near</span>' if ok is None else '<span class="no">short</span>')}</td>
        </tr>"""
    for q, was, now, tgt, ok in BUDGET
)

reviews = "\n".join(
    f"""      <article class="review">
        <div class="rscore"><b>{r['score']}</b><span>/50</span></div>
        <div class="rbody">
          <p class="eyebrow">Review {r['n']} · {r['frame']} · gap {r['gap']}</p>
          <h4>{r['head']}</h4>
          <p>{r['body']}</p>
        </div>
      </article>"""
    for r in REVIEWS
)

findings = "\n".join(
    f"""        <li><h4>{t}</h4><p>{b}</p></li>""" for t, b in FINDINGS
)

figs = []
for fn, title, cap in SHOTS:
    u = uri(fn)
    if u:
        figs.append(
            f"""      <figure>
        <img src="{u}" alt="{title}" loading="lazy" />
        <figcaption><strong>{title}</strong>{cap}</figcaption>
      </figure>"""
        )
figs_html = "\n".join(figs)

HTML = f"""<title>Ring Zero</title>
<style>
  :root {{
    --ground: #0b0d16; --surface: #141827; --surface-2: #1b2033;
    --line: #262d45; --ink: #ece7da; --muted: #868da8; --dim: #5c6480;
    --live: #46d39a; --work: #e9a441; --idle: #3d4460; --hot: #e2701f;
    --sp: clamp(1rem, 2.2vw, 1.6rem);
    --display: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--ground); color: var(--ink);
    font-family: var(--display); font-size: 16px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }}
  body::before {{
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 99;
    background: repeating-linear-gradient(180deg, rgba(255,255,255,.022) 0 1px, transparent 1px 3px);
  }}
  .wrap {{
    max-width: 1120px; margin: 0 auto;
    padding: calc(var(--sp) * 2) var(--sp) calc(var(--sp) * 4);
    display: flex; flex-direction: column; gap: calc(var(--sp) * 2.6);
  }}
  .hero {{ display: flex; flex-direction: column; gap: 1.1rem; }}
  .eyebrow {{
    font-family: var(--mono); font-size: .68rem; letter-spacing: .34em;
    text-transform: uppercase; color: var(--dim); margin: 0;
  }}
  h1 {{
    margin: 0; font-size: clamp(2.9rem, 9vw, 5.6rem); font-weight: 800;
    letter-spacing: -.045em; line-height: .86; text-transform: uppercase;
    text-wrap: balance; transform: skewX(-5deg); transform-origin: left bottom;
  }}
  h1 em {{ font-style: normal; display: block; color: var(--hot); }}
  .standfirst {{ max-width: 62ch; margin: 0; color: var(--muted); font-size: 1.06rem; }}
  .healthbar {{ display: flex; flex-direction: column; gap: .5rem; margin-top: .4rem; }}
  .healthbar .cap {{
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: var(--mono); font-size: .7rem; letter-spacing: .2em;
    text-transform: uppercase; color: var(--dim);
  }}
  .healthbar .cap b {{ color: var(--ink); font-size: 1.4rem; letter-spacing: 0; font-variant-numeric: tabular-nums; }}
  .track {{
    height: 13px; background: var(--surface-2); border: 1px solid var(--line);
    position: relative; overflow: hidden; transform: skewX(-16deg);
  }}
  .track i {{
    position: absolute; inset: 0 auto 0 0;
    background: linear-gradient(90deg, var(--hot), #f2c14a);
    box-shadow: 0 0 18px rgba(226,112,31,.5);
  }}
  section {{ display: flex; flex-direction: column; gap: 1.1rem; }}
  h2 {{
    margin: 0; font-size: .74rem; font-family: var(--mono); font-weight: 600;
    letter-spacing: .3em; text-transform: uppercase; color: var(--dim);
    padding-bottom: .65rem; border-bottom: 1px solid var(--line);
    display: flex; justify-content: space-between; gap: 1rem;
  }}
  h2 span {{ color: var(--line); }}

  .roster {{
    display: grid; grid-template-columns: repeat(auto-fit, minmax(235px, 1fr));
    gap: 1px; background: var(--line); border: 1px solid var(--line);
  }}
  .fighter {{ background: var(--surface); display: flex; flex-direction: column; position: relative; }}
  .fighter::after {{
    content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: linear-gradient(90deg, var(--c1) 0 50%, var(--c2) 50% 84%, var(--c3) 84%);
  }}
  .portrait {{ background: #0d1018; aspect-ratio: 2/3; overflow: hidden; }}
  .portrait img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
  .fighter-body {{ padding: 1.1rem 1.2rem 1.5rem; display: flex; flex-direction: column; gap: .5rem; }}
  .chips {{ display: flex; gap: 4px; }}
  .chips span {{ width: 15px; height: 15px; }}
  .chips span:nth-child(1) {{ background: var(--c1); }}
  .chips span:nth-child(2) {{ background: var(--c2); }}
  .chips span:nth-child(3) {{ background: var(--c3); }}
  .fighter h3 {{ margin: .25rem 0 0; font-size: 1.6rem; font-weight: 800; letter-spacing: -.02em; line-height: 1; }}
  .epithet {{ margin: 0; font-size: .84rem; font-style: italic; color: var(--c2); }}
  .fighter dl {{ margin: .3rem 0 0; display: flex; flex-direction: column; gap: .26rem; font-family: var(--mono); font-size: .69rem; }}
  .fighter dl div {{ display: flex; gap: .5rem; }}
  .fighter dt {{ color: var(--dim); min-width: 3.4em; letter-spacing: .1em; text-transform: uppercase; }}
  .fighter dd {{ margin: 0; }}
  .note {{ margin: .3rem 0 0; font-size: .81rem; color: var(--muted); line-height: 1.5; }}

  .board-scroll {{ overflow-x: auto; }}
  table {{ width: 100%; border-collapse: collapse; font-size: .92rem; }}
  tbody tr {{ border-bottom: 1px solid var(--line); }}
  tbody tr:last-child {{ border-bottom: 0; }}
  th[scope="row"] {{ text-align: left; font-weight: 600; padding: .85rem 1rem .85rem 0; display: flex; flex-direction: column; gap: .15rem; }}
  .sub {{ font-weight: 400; font-size: .78rem; color: var(--muted); }}
  td {{ padding: .85rem 0; vertical-align: middle; }}
  .meter {{ width: 132px; }}
  .pip {{ display: inline-block; width: 20px; height: 9px; margin-right: 3px; background: var(--idle); transform: skewX(-16deg); }}
  .pip.on[data-state="done"] {{ background: var(--live); box-shadow: 0 0 9px rgba(70,211,154,.45); }}
  .pip.on[data-state="work"] {{ background: var(--work); box-shadow: 0 0 9px rgba(233,164,65,.45); }}
  .state {{ width: 108px; text-align: right; }}
  .tag {{
    font-family: var(--mono); font-size: .64rem; letter-spacing: .16em; text-transform: uppercase;
    padding: .28rem .5rem; border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
  }}
  tr[data-state="done"] .tag {{ color: var(--live); border-color: rgba(70,211,154,.4); }}
  tr[data-state="work"] .tag {{ color: var(--work); border-color: rgba(233,164,65,.4); }}

  .budget th[scope="row"] {{ display: table-cell; padding-right: 1rem; font-weight: 500; }}
  .budget .num {{ font-family: var(--mono); font-size: .82rem; text-align: right; padding-right: 1rem; font-variant-numeric: tabular-nums; }}
  .budget .was {{ color: var(--dim); text-decoration: line-through; }}
  .budget .now {{ color: var(--ink); font-weight: 600; }}
  .budget .tgt {{ color: var(--muted); }}
  .budget .verdict {{ width: 74px; text-align: right; }}
  .ok, .no, .near {{ font-family: var(--mono); font-size: .62rem; letter-spacing: .14em; text-transform: uppercase; padding: .22rem .45rem; border: 1px solid; }}
  .ok {{ color: var(--live); border-color: rgba(70,211,154,.4); }}
  .near {{ color: var(--work); border-color: rgba(233,164,65,.4); }}
  .no {{ color: #e2645a; border-color: rgba(226,100,90,.4); }}

  .reviews {{ display: flex; flex-direction: column; gap: 1px; background: var(--line); border: 1px solid var(--line); }}
  .review {{ background: var(--surface); display: grid; grid-template-columns: 110px 1fr; gap: 1.4rem; padding: 1.4rem 1.3rem; }}
  .rscore {{ font-family: var(--mono); display: flex; align-items: baseline; gap: .1rem; }}
  .rscore b {{ font-size: 2.6rem; font-weight: 800; color: var(--hot); letter-spacing: -.04em; }}
  .rscore span {{ color: var(--dim); font-size: .9rem; }}
  .rbody h4 {{ margin: .2rem 0 .4rem; font-size: 1.05rem; letter-spacing: -.01em; }}
  .rbody p {{ margin: 0; color: var(--muted); font-size: .89rem; max-width: 68ch; }}
  .rbody .eyebrow {{ margin-bottom: .3rem; }}

  .findings {{ list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }}
  .findings li {{ background: var(--surface); padding: 1.2rem 1.2rem 1.3rem; }}
  .findings h4 {{ margin: 0 0 .4rem; font-size: .97rem; letter-spacing: -.01em; }}
  .findings p {{ margin: 0; color: var(--muted); font-size: .85rem; }}
  code {{ font-family: var(--mono); font-size: .82em; color: var(--ink); background: var(--surface-2); padding: .1em .35em; }}

  figure {{ margin: 0; display: flex; flex-direction: column; gap: .7rem; }}
  figure img {{ display: block; width: 100%; height: auto; border: 1px solid var(--line); background: #000; }}
  figcaption {{ font-size: .85rem; color: var(--muted); display: flex; flex-direction: column; gap: .18rem; }}
  figcaption strong {{ color: var(--ink); font-family: var(--mono); font-size: .68rem; letter-spacing: .2em; text-transform: uppercase; font-weight: 600; }}
  .shots {{ display: flex; flex-direction: column; gap: 2rem; }}

  footer {{
    font-family: var(--mono); font-size: .68rem; letter-spacing: .16em; text-transform: uppercase;
    color: var(--dim); border-top: 1px solid var(--line); padding-top: 1.2rem;
    display: flex; flex-wrap: wrap; gap: .6rem 1.6rem;
  }}
  @media (max-width: 640px) {{
    .review {{ grid-template-columns: 1fr; gap: .5rem; }}
    .meter {{ width: 92px; }} .pip {{ width: 13px; }}
  }}
  @media (prefers-reduced-motion: reduce) {{ * {{ animation: none !important; transition: none !important; }} }}
</style>

<div class="wrap">

  <header class="hero">
    <p class="eyebrow">Build log · Three.js · target: KOF XIII</p>
    <h1>Ring<em>Zero</em></h1>
    <p class="standfirst">
      A 2.5D fighting game built from nothing — every mesh, texture, animation and
      sound generated in code, with no asset ever loaded from disk. The bar is a
      blind side-by-side against <em>The King of Fighters XIII</em>, judged by a
      harsh critic that measures pixels instead of trusting impressions.
    </p>
    <div class="healthbar">
      <div class="cap"><span>Systems landed</span><b>{pct}%</b></div>
      <div class="track"><i style="width:{pct}%"></i></div>
    </div>
  </header>

  <section>
    <h2>Roster <span>04 fighters · generated in code</span></h2>
    <div class="roster">
{cards}
    </div>
  </section>

  <section>
    <h2>Critic reviews <span>13 → 15 → 18 / 50</span></h2>
    <div class="reviews">
{reviews}
    </div>
  </section>

  <section>
    <h2>Frame budget <span>shared invariants, measured</span></h2>
    <div class="board-scroll">
      <table class="budget"><tbody>
{budget_rows}
      </tbody></table>
    </div>
  </section>

  <section>
    <h2>Systems <span>{done} landed · {work} in flight</span></h2>
    <div class="board-scroll">
      <table><tbody>
{rows}
      </tbody></table>
    </div>
  </section>

  <section>
    <h2>Captures <span>headless, deterministic</span></h2>
    <div class="shots">
{figs_html}
    </div>
  </section>

  <section>
    <h2>Bugs worth the telling <span>each found by measuring</span></h2>
    <ol class="findings">
{findings}
    </ol>
  </section>

  <footer>
    <span>Every asset generated in code</span>
    <span>Deterministic 60 Hz sim</span>
    <span>{done} of {len(SYSTEMS)} systems landed</span>
  </footer>

</div>
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(HTML)
print(f"wrote {OUT} ({len(HTML)/1024:.0f} KB)")
