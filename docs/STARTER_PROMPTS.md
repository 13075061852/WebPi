# Creative starter prompt provenance

Reviewed 2026-10-12. The four entries replace the original locally written creative briefs.
The catalog lives in `src/renderer/js/starter-prompts.mjs`.

These are sourced cases with published artifacts/evidence, not a claim that Halo's
selected provider reproduces the source results. No paid model runs were performed
for this change. UI tests verify selection and editing, not generation quality.

| Entry | Original source and evidence | Changes in Halo | Important limits |
| --- | --- | --- | --- |
| Stop-motion camping video | [Google DeepMind Veo 3 prompt guide](https://deepmind.google/models/veo/prompt-guide/), “Camping (Stop Motion)” with the corresponding video | Original short English prompt unchanged; Chinese instruction requests a video file | Published example, no pass rate; model/audio support affects reproduction |
| Coffee promotion poster | [OpenAI Image Evals](https://developers.openai.com/cookbook/examples/multimodal/image_evals), `coffee_generation_prompt`, generated image and evaluation table | Original English prompt unchanged; Chinese instruction requests image generation | Source gpt-image-1.5 run: judge PASS; layout/style/visual quality 5/5; OCR text check FALSE. This is not proof of perfect typography or print resolution. |
| Motion-controlled Dino game | [Google Developers, Jump to play](https://developers.googleblog.com/jump-to-play-building-with-gemini-mediapipe/), Example 1, prompt, video and linked playable AI Studio demo | Faithful Chinese rendering of requirements, plus local delivery directory | Source recommends Gemini 3.1 Pro and explicitly says gallery apps were refined over multiple turns. A camera/MediaPipe is part of this example; spacebar is its original fallback. No one-shot success claim. |
| Project management SaaS website | [Anthropic frontend aesthetics cookbook](https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics), Example 1 and baseline/enhanced screenshots | Original task and `DISTILLED_AESTHETICS_PROMPT` retained; local HTML delivery instruction appended | Qualitative comparison, not an independent benchmark or numerical success rate. The appended delivery instruction is not separately evaluated. |

## Reuse and attribution

OpenAI and Anthropic cookbook prompts are MIT licensed. Their copyright notices
and complete license texts are retained in `docs/licenses/starter-cookbooks-MIT.txt`.
Anthropic repository snapshot: `9c1e493ddd2b82df399d2a61b9c806c539e18be6`.
The Google video entry uses a short attributed excerpt; the game entry is a Chinese
rendering of the cited requirements, not a newly invented game brief.

Each card has a source link; its tooltip states the evidence and reproduction scope.
Clicking the task only inserts an editable draft; it never sends a model request.
