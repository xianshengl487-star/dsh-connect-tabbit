# B站介绍视频物料

90 秒、1280×720、30 fps 的 H.264 介绍视频及其全部素材。画面与配乐均由脚本程序化生成，未使用任何第三方素材。

## 文件

- `dsh-connect-tabbit-intro.mp4` — 成片。
- `render_intro.py` — 逐帧画面与器乐音轨的生成脚本。
- `cover.png` — 16:9 封面。
- `contact-sheet.png` — 分镜缩略图拼版。
- `subtitles_zh-CN.srt` — 中文字幕轨，可单独上传。
- `bilibili-post.md` — 标题、简介、章节与标签。
- `voiceover-draft.md` — 可选的中文旁白稿，成片本身无人声。
- `requirements.txt` — 重新渲染所需依赖。

## 重新渲染

需要 Python 3.12+、Pillow 13+、imageio-ffmpeg 0.6+。编码使用 imageio-ffmpeg 自带的 ffmpeg 二进制。

```sh
python -m pip install -r requirements.txt
python render_intro.py
```
