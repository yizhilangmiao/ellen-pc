"""Local streaming recognition. Receives PCM over stdin; never opens a microphone."""
import os, sys, json, base64
from pathlib import Path
os.environ.update(OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='1')
import numpy as np
import sherpa_onnx

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def main():
    root = Path(__file__).resolve().parent.parent / 'runtime/realtime/models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(root / 'tokens.txt'), encoder=str(root / 'encoder.int8.onnx'),
        decoder=str(root / 'decoder.onnx'), joiner=str(root / 'joiner.int8.onnx'),
        num_threads=2, provider='cpu', decoding_method='greedy_search', enable_endpoint_detection=False)
    stream, current_id, previous = None, None, ''
    emit({'type': 'ready'})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            kind = request['type']
            if kind == 'reset':
                stream, current_id, previous = None, None, ''
                continue
            if kind == 'begin':
                stream = recognizer.create_stream()
                current_id, previous = request['id'], ''
            if stream is None or request.get('id') != current_id:
                continue
            if kind in ('begin', 'audio'):
                pcm = base64.b64decode(request['audio'], validate=True)
                if len(pcm) > 64000 or len(pcm) % 2:
                    raise ValueError('invalid pcm')
                stream.accept_waveform(16000, np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768)
            elif kind == 'finish':
                stream.accept_waveform(16000, np.zeros(8000, dtype=np.float32))
                stream.input_finished()
            else:
                raise ValueError('invalid request')
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            text = recognizer.get_result(stream).strip()
            if len(text) > 32000:
                raise ValueError('text limit')
            if kind == 'finish':
                emit({'type': 'final', 'id': current_id, 'text': text})
                stream, current_id, previous = None, None, ''
            elif text != previous:
                emit({'type': 'partial', 'id': current_id, 'text': text})
                previous = text
        except Exception:
            emit({'type': 'error'})
            return

if __name__ == '__main__':
    try:
        main()
    except Exception:
        emit({'type': 'error'})
