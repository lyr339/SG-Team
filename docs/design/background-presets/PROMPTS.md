# 拾光·背景预设设计稿（极光 / 流体 / 棱镜）

2026-09-16，Cursor 内置 GenerateImage 生成，1280×720 概念稿直接作为资源上线
（`src/renderer/src/assets/backgrounds/{aurora,mesh,prism}-{light,dark}.png`，每张 120–180 KB），
页面 `background-size: cover` 放大显示。三套都是柔性渐变 / 光带，放大后不出锐化伪影；
后续如需 4K 成品，沿用 `../background-refraction/PROMPTS.md` 的 Real-ESRGAN 4× 超分流程，或按下列提示词重新生成高分版。
默认背景「折光」仍是 `shiguang-{light,dark}.png`（4K 超分件，见 `../background-refraction/`）。

预设 id 与文案在 `appearance-preferences.ts`（`BACKGROUND_PRESETS`），图片 URL 只在 `styles.css`
（`--bg-<id>-light/dark`）出现一次，页面背景与外观弹层的缩略卡共用。

同一轮还生成过 4 个克制方向（晨光渐层 / 拾光叠片 / 聚光丝线 / 晴窗光斑）与一个幻彩丝绸方向，
用户评为过于单调 / 深色版有金属颗粒感，未采用，不入库。

## aurora（极光）

**dark**：Expressive desktop application wallpaper, DARK theme, 16:9. NO text, NO logo, NO UI. Concept 'Aurora ribbons': many flowing aurora-borealis-like bands of light sweep across the whole canvas in long diagonal S-curves from lower-left to upper-right, layered and semi-transparent, in a rich palette of teal, emerald, violet, warm orange and sky blue on a deep midnight navy base; the bands have soft feathered edges with occasional sharp bright filaments inside, like silk curtains of light moving in the sky. Vivid but smooth: immaculate gradients, no noise, no grain, no stars, no landscape, no horizon, no people. Cinematic, luminous, premium abstract wallpaper quality with plenty of depth and motion.

**light**：Expressive desktop application wallpaper, LIGHT theme, 16:9. NO text, NO logo, NO UI. Concept 'Daylight aurora ribbons': many flowing aurora-like bands of soft color sweep across the whole canvas in long diagonal S-curves from lower-left to upper-right, layered and semi-transparent, in a luminous pastel palette of peach, coral-orange, lavender, mint and sky blue on a bright warm-white base; the bands have soft feathered edges with occasional fine brighter filaments inside, like translucent silk curtains of light in a bright sky. Vivid yet airy and smooth: immaculate gradients, no noise, no grain, no stars, no landscape, no horizon, no people. Premium abstract wallpaper quality with depth and motion, still bright enough overall for dark text on translucent panels.

## mesh（流体）

**dark**：Expressive desktop application wallpaper, DARK theme, 16:9. NO text, NO logo, NO UI. Concept 'Deep mesh gradient': a full-bleed fluid mesh gradient made of several large, soft, overlapping color fields that melt into each other - deep indigo, electric violet, teal, warm tangerine orange and a touch of magenta - over a dark navy base, like ink diffusing in water frozen at its most beautiful moment. Large-scale, smooth, organic shapes with soft edges; some areas darker and calm, some saturated and glowing. No hard lines, no noise, no grain, no stars, no objects, no people. Premium, modern, rich abstract wallpaper with depth.

**light**：Expressive desktop application wallpaper, LIGHT theme, 16:9. NO text, NO logo, NO UI. Concept 'Bright mesh gradient': a full-bleed fluid mesh gradient made of several large, soft, overlapping color fields that melt into each other - peach, coral orange, lavender, mint green, sky blue and cream white - like watercolor pigments diffusing on wet paper, frozen at their most beautiful moment. Large-scale, smooth, organic shapes with soft edges; bright and airy overall with a few more saturated pools of color. No hard lines, no noise, no grain, no paper texture, no objects, no people. Premium, modern, rich abstract wallpaper with depth.

## prism（棱镜）

**dark**：Expressive desktop application wallpaper, DARK theme, 16:9. NO text, NO logo, NO UI. Concept 'Prism beams': several wide, crisp-edged beams of light refracted through an unseen prism cross the canvas diagonally from upper-left to lower-right on a deep charcoal-navy base; each beam is a translucent band of a single hue - amber orange, coral, teal, cobalt blue, violet - with slightly different angles so they overlap and mix into new colors where they cross; the beams have clean geometric edges softened only by a slight glow, and the base between them stays dark and smooth. Graphic, architectural, bold, like light through stained glass in a dark gallery. No noise, no grain, no stars, no objects, no people.

**light**：Expressive desktop application wallpaper, LIGHT theme, 16:9. NO text, NO logo, NO UI. Concept 'Prism beams': several wide, crisp-edged translucent beams of colored light cross a bright warm-white canvas diagonally from upper-left to lower-right, as if sunlight passed through a glass prism onto a white wall; each beam is a translucent band of a single soft hue - apricot orange, coral pink, mint, sky blue, lavender - at slightly different angles so they overlap and mix into new tints where they cross; clean geometric edges softened only by a slight glow, the white between them luminous and smooth. Graphic, architectural, bold yet bright and airy. No noise, no grain, no objects, no people, no rainbow arcs.
