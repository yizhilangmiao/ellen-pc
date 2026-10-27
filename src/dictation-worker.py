"""One explicitly finished recording per request. No microphone or network access."""
import os, sys, json, base64, platform, re
from pathlib import Path

platform._wmi_query = lambda *a, **k: (_ for _ in ()).throw(OSError('Use Win32 fallback'))
os.environ.update(HF_HUB_OFFLINE='1', OMP_NUM_THREADS='3', OPENBLAS_NUM_THREADS='3')

def main():
    import numpy as np
    from faster_whisper import WhisperModel
    from opencc import OpenCC
    model_path = Path(os.environ.get('ELLEN_WHISPER_MODEL', Path(__file__).resolve().parent.parent / 'runtime/models/faster-whisper-large-v3-turbo'))
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=3,
                         num_workers=1, local_files_only=True)
    simplified = OpenCC('t2s')
    print(json.dumps({'type': 'ready'}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            pcm = base64.b64decode(request['audio'], validate=True)
            if not 16000 <= len(pcm) <= 16000 * 2 * 120 or len(pcm) % 2:
                raise ValueError('Invalid recording')
            wave = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
            # Reject digital silence before decoding. VAD also removes silent tails.
            if float(np.max(np.abs(wave))) < .002:
                text = ''
            else:
                def run(lang):
                    segs, meta = model.transcribe(wave, language=lang, task='transcribe', beam_size=3,
                        condition_on_previous_text=False, temperature=0, vad_filter=True,
                        vad_parameters={'min_silence_duration_ms': 400, 'speech_pad_ms': 180},
                        no_speech_threshold=.6, hallucination_silence_threshold=2,
                        word_timestamps=True)
                    kept = ''.join(s.text for s in segs
                        if not (s.no_speech_prob > .6 and s.avg_logprob < -.8)).strip()
                    return kept, meta
                raw, info = run(None)
                # 短句（一秒以内）容易把中文判成日语。判定为日语却连一个假名都没有时，
                # 按中文重跑一遍，避免把中文转成日语汉字。
                if info.language == 'ja' and not re.search(r'[\u3040-\u30ff\uff66-\uff9f]', raw):
                    raw, _ = run('zh')
                text = simplified.convert(raw)
            print(json.dumps({'id': request['id'], 'text': text}, ensure_ascii=False), flush=True)
        except Exception:
            print(json.dumps({'id': request.get('id'), 'error': '录音识别失败，请重试。'}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
