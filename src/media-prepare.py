"""Bounded local image/video preparation. Output JSON, no cloud or microphone."""
import sys, json, math, wave, warnings
from pathlib import Path
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

class MediaInputError(Exception):
    pass

def save_picture(image, folder, name):
    image = ImageOps.exif_transpose(image)
    if image.width * image.height > 40_000_000:
        raise MediaInputError('画面像素过大，请缩小后再试。')
    image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    if image.mode in ('RGBA', 'LA') or 'transparency' in image.info:
        rgba = image.convert('RGBA')
        background = Image.new('RGBA', rgba.size, 'white')
        background.alpha_composite(rgba)
        image = background.convert('RGB')
    else:
        image = image.convert('RGB')
    image.save(folder / name, quality=88)
    if (folder / name).stat().st_size > 4 * 1024**2:
        raise MediaInputError('画面转换结果过大。')
    return image

def prepare(source, folder, kind):
    if kind == 'image':
        with Image.open(source) as original:
            if original.format not in ('JPEG', 'PNG', 'WEBP', 'GIF'):
                raise MediaInputError('图片实际格式不受支持。')
            image = ImageOps.exif_transpose(original)
            width, height = image.size
            warning = '动图只读取第一帧。' if getattr(original, 'is_animated', False) else ''
            image = save_picture(image, folder, 'frame-00.jpg')
        frames = [{'file':'frame-00.jpg', 'at':0}]
        duration, has_audio = None, False
    else:
        import av
        options = {'protocol_whitelist':'file', 'threads':'1'}
        # Force a self-contained container; do not probe disguised playlists with external references.
        demuxer = 'matroska' if source.suffix.lower() in ('.webm', '.mkv') else 'mov'
        with av.open(str(source), format=demuxer, options=options) as container:
            if not container.streams.video:
                raise MediaInputError('文件没有可读取的视频画面。')
            stream = container.streams.video[0]
            stream.codec_context.thread_count = 1
            width, height = stream.width, stream.height
            if not 0 < width * height <= 40_000_000:
                raise MediaInputError('视频尺寸不受支持。')
            duration = float(container.duration / av.time_base) if container.duration else float(stream.duration * stream.time_base) if stream.duration else 0
            if not math.isfinite(duration) or not 0 < duration <= 120:
                raise MediaInputError('第一版支持两分钟以内的视频，请先截取片段。')
            start = float(stream.start_time * stream.time_base) if stream.start_time is not None else 0
            has_audio = bool(container.streams.audio)
            count = min(24, max(3, math.ceil(duration)))
            frames = []
            for i in range(count):
                video_duration = float(stream.duration * stream.time_base) if stream.duration else duration
                target = max(0, min(duration, video_duration) - .1) * i / (count - 1)
                container.seek(int((start + target) / stream.time_base), stream=stream, backward=True)
                chosen = None
                for decoded in container.decode(stream):
                    if decoded.time is None:
                        continue
                    chosen = decoded
                    if decoded.time - start >= target:
                        break
                if chosen is None:
                    raise MediaInputError('部分视频画面无法解码。')
                actual = round(max(0, float(chosen.time) - start), 3)
                image = chosen.to_image()
                rotation = chosen.rotation
                if rotation:
                    image = image.rotate(rotation, expand=True)
                name = f'frame-{i:02}.jpg'
                image = save_picture(image, folder, name)
                frames.append({'file':name, 'at':actual})
            warning = ''
        if has_audio:
            with av.open(str(source), format=demuxer, options=options) as container, wave.open(str(folder / 'audio.wav'), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
                count_samples = 0
                limit_samples = min(120 * 16000, math.ceil(duration * 16000))
                def write_audio(output):
                    nonlocal count_samples
                    data = output.to_ndarray().tobytes()
                    at = round((float(output.time) - start) * 16000) if output.time is not None else count_samples
                    if at > count_samples:
                        padding = min(at, limit_samples) - count_samples
                        wav.writeframesraw(b'\0' * (padding * 2))
                        count_samples += padding
                    if at < count_samples:
                        data = data[(count_samples - at) * 2:]
                    data = data[:max(0, limit_samples - count_samples) * 2]
                    wav.writeframesraw(data)
                    count_samples += len(data) // 2
                for frame in container.decode(audio=0):
                    for output in resampler.resample(frame):
                        write_audio(output)
                    if count_samples >= limit_samples:
                        break
                for output in resampler.resample(None):
                    write_audio(output)
    with Image.open(folder / frames[0]['file']) as preview:
        preview.thumbnail((360, 360), Image.Resampling.LANCZOS)
        preview.save(folder / 'thumbnail.jpg', quality=80)
    return {'width':width, 'height':height, 'durationSeconds':duration, 'frames':frames,
            'hasAudio':has_audio, 'warning':warning}

if __name__ == '__main__':
    try:
        print(json.dumps(prepare(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]), ensure_ascii=False))
    except MediaInputError as e:
        print(json.dumps({'error':str(e)}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'error':'无法读取这个媒体文件，格式可能不受支持或文件已损坏。'}, ensure_ascii=False))
