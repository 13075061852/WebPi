// Source cases and evidence are documented in docs/STARTER_PROMPTS.md.
// Published results apply to the source models, not every model selected in Halo.
export const starterPrompts = [
  {
    id: 'video', title: '制作定格动画短片', subtitle: '露营奇遇 · Veo 官方成片',
    source: 'Google DeepMind', sourceURL: 'https://deepmind.google/models/veo/prompt-guide/',
    evidence: 'Veo 3 官方页公开了这条提示词对应的定格动画视频。星环仅追加工具交付说明，未在当前视频模型上复测。',
    prompt: '请使用可用的视频生成工具，将下面的官方案例提示词制作成短片，并提供可播放的文件。\n\nCamping (Stop Motion): Camper: "I\'m one with nature now!" Bear: "Nature would prefer some personal space."',
  },
  {
    id: 'poster', title: '生成咖啡促销海报', subtitle: 'Sunrise Coffee · OpenAI 评测案例',
    source: 'OpenAI Cookbook', sourceURL: 'https://developers.openai.com/cookbook/examples/multimodal/image_evals',
    evidence: 'gpt-image-1.5 官方示例包含生成图片和评分：模型评审 PASS，布局、风格、视觉质量为 5/5，但 OCR 文本核对未通过。不能据此承诺文字零差错；星环当前模型未复测。',
    prompt: `请使用可用的图片生成工具，按照下面的官方原始提示词生成海报并提供图片文件。

Create a print-ready vertical A4 flyer for a coffee shop called Sunrise Coffee.
Use a warm, cozy, minimal specialty coffee aesthetic (not cartoonish).
Required text (must be exact):
- WINTER LATTE WEEK
- Try our Cinnamon Oat Latte
- 20% OFF - Mon-Thu
- Order Ahead
- 123 Market St - 7am-6pm
Do not include any other words, prices, URLs, or QR codes.`,
  },
  {
    id: 'game', title: '制作恐龙跳跃游戏', subtitle: '体感与空格操作 · Google 可玩案例',
    source: 'Google Developers', sourceURL: 'https://developers.googleblog.com/jump-to-play-building-with-gemini-mediapipe/',
    evidence: 'Google 官方公开提示词、演示视频和可玩 AI Studio 作品，推荐 Gemini 3.1 Pro。作者说明展示作品经过多轮修正，并非一次生成成功保证。下方为忠实中文转述；星环当前模型未复测。',
    prompt: `使用 MediaPipe Pose Landmarker 制作经典 Chrome Dino 游戏的体感版本，让玩家现实中的跳跃变成游戏内动作。
- 界面和游戏物体采用原版 8 位像素风格。
- 不论玩家距摄像头远近，都能稳健检测跳跃；同时支持空格键跳跃作为备用操作。
- 跳跃高度至少为障碍物的两倍。
- 在游戏下方设置调试和反馈面板，显示实时摄像头画面及姿态关键点叠加。

请在当前项目的新目录中实现并提供运行入口。`,
  },
  {
    id: 'website', title: '设计项目管理网站', subtitle: 'SaaS 落地页 · Anthropic 对照案例',
    source: 'Anthropic Cookbook', sourceURL: 'https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics',
    evidence: '官方 Cookbook 展示同一任务使用与不使用审美提示词的对照截图，附可复现代码；不是量化成功率。保留官方任务和审美块，另加本地文件交付说明；星环当前模型未复测。',
    prompt: `Create a SaaS landing page for a project management tool.

<frontend_aesthetics>
You tend to converge toward generic, "on distribution" outputs. In frontend design, this creates what users call the "AI slop" aesthetic. Avoid this: make creative, distinctive frontends that surprise and delight. Focus on:

Typography: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics.

Color & Theme: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Draw from IDE themes and cultural aesthetics for inspiration.

Motion: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions.

Backgrounds: Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic.

Avoid generic AI-generated aesthetics:
- Overused font families (Inter, Roboto, Arial, system fonts)
- Clichéd color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character

Interpret creatively and make unexpected choices that feel genuinely designed for the context. Vary between light and dark themes, different fonts, different aesthetics. You still tend to converge on common choices (Space Grotesk, for example) across generations. Avoid this: it is critical that you think outside the box!
</frontend_aesthetics>

请生成完整、自包含的 HTML，内联 CSS 与 JavaScript，保存到当前项目的新目录中，并提供本地预览入口。`,
  },
];
