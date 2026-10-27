# Journey UI assets

Created for the Eris desktop companion UI on 2026-09-21.

## Storybook v04 (current)

The selected user reference now drives `storybook.css`/`storybook.js`. `room-v04.png` is an ImageGen clean background reconstructed from that reference with all characters/UI removed; `paper-v04.png` is a separately generated writing-paper material. Original PNGs are retained unchanged. Exact prompts, source paths and limits are in [v04 provenance](../../../../../../../项目维护/UI落地-v04/assets-provenance.md). The earlier valley below remains historical, not the currently displayed scene.

`fonts/` contains local Noto Serif SC 400/600, source URL manifest and the official SIL OFL license; no system font installation. Eight added Lucide icons come from upstream tag 0.468.0 and retain the existing icon license. Original Eris assets and all voice/character logic were not edited.

## valley-v01.png

- Original bitmap generated with the built-in ImageGen tool, 1024 x 1536.
- Generation brief summary: a readable hand-painted fantasy environment inspired by the travel-world atmosphere of Mushoku Tensei; pale stone terrace and medieval town, green valley, distant snowy mountains, blue daytime sky. No characters, lettering or UI. Portrait composition for the companion sidebar.
- This is a newly generated scene, not a downloaded official anime frame. It does not replace or redraw the existing approved Eris character assets.
- The UI adds a CSS contrast overlay for readable status/name text; the PNG is unchanged.
- Original generation output: `C:/Users/Administrator/.codex/generated_images/01a0c021-b06f-7851-8497-f15a0117a121/exec-8081b4a9-983a-403d-9024-6fea2cfc1c36.png`.

## Concept reference

- Saved separately at `项目维护/UI优化-v01/概念参考-v01.png`, 1536 x 1024; not a production asset.
- Generated using the existing expanded UI screenshot and the new valley image as references. Brief: an actual usable Chinese desktop chat layout, retain the red-haired character identity, quiet jade/brass/ruby fantasy styling, readable conversation and restrained controls.
- The generated character pose and sample text are conceptual. Production retains the original character layers and current program controls.
- Original generation output: `C:/Users/Administrator/.codex/generated_images/01a0c021-b06f-7851-8497-f15a0117a121/exec-bc3c94ab-d948-4cf5-acf0-e71f62a9b011.png`.

## icons/

- Source: [Lucide](https://github.com/lucide-icons/lucide), fetched from the original repository's `icons/` folder.
- ISC license plus the included MIT notices for Feather-derived icons, preserved at `icons/LICENSE`.
- SVGs are unmodified; sizing and color are applied by CSS. Decorative images have empty alt text; their parent buttons have accessible names and title tooltips.

The upstream skill licenses live in the corresponding project `.agents/skills/` directories and do not license the project's characters or generated illustrations.
