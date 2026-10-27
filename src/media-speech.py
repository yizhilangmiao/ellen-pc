"""Transcribe one imported short video locally. Never opens the microphone."""
import os, sys, json, platform
from pathlib import Path
platform._wmi_query = lambda *a, **k: (_ for _ in ()).throw(OSError('Use Win32 fallback'))
os.environ.update(HF_HUB_OFFLINE='1', OMP_NUM_THREADS='3', OPENBLAS_NUM_THREADS='3')

def main():
    from faster_whisper import WhisperModel
    from opencc import OpenCC
    model = WhisperModel(os.environ.get('ELLEN_WHISPER_MODEL', str(Path(__file__).resolve().parent.parent / 'runtime/models/faster-whisper-large-v3-turbo')),
                         device='cpu', compute_type='int8', cpu_threads=3, num_workers=1, local_files_only=True)
    audio = Path(sys.argv[1])
    if not audio.is_file() or audio.stat().st_size > 4_000_000:
        raise ValueError('Invalid short video audio')
    segments, info = model.transcribe(str(audio), language=None, task='transcribe', beam_size=3,
                                      condition_on_previous_text=False, temperature=0, vad_filter=True,
                                      no_speech_threshold=.6, hallucination_silence_threshold=2)
    simplified = OpenCC('t2s')
    rows = [{'start':round(s.start, 2), 'end':round(s.end, 2), 'text':simplified.convert(s.text.strip())}
            for s in segments if s.text.strip() and not (s.no_speech_prob > .6 and s.avg_logprob < -.8)]
    print(json.dumps({'text':' '.join(s['text'] for s in rows), 'segments':rows, 'language':info.language}, ensure_ascii=False))

if __name__ == '__main__':
    main()
