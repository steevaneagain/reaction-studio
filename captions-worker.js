// Runs Whisper (speech → text with word timings) on the phone, in the background.
// The model (~77 MB) downloads on first use and is cached by the browser after that.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

env.allowLocalModels = false;
const MODEL = 'onnx-community/whisper-base_timestamped';
let asrPromise = null;

function getASR() {
  if (!asrPromise) {
    asrPromise = pipeline('automatic-speech-recognition', MODEL, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device: 'wasm',
      progress_callback: p => self.postMessage({ type: 'progress', p }),
    }).catch(e => { asrPromise = null; throw e; });
  }
  return asrPromise;
}

self.onmessage = async ({ data }) => {
  const { id, audio } = data;
  try {
    const asr = await getASR();
    if (!audio) { self.postMessage({ type: 'done', id, words: [] }); return; } // warm-up only
    const out = await asr(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
    });
    const words = (out.chunks || [])
      .map(c => ({ w: String(c.text || '').trim(), s: c.timestamp[0], e: c.timestamp[1] ?? (c.timestamp[0] + 0.3) }))
      .filter(x => x.w && Number.isFinite(x.s));
    self.postMessage({ type: 'done', id, words });
  } catch (e) {
    self.postMessage({ type: 'error', id, error: String((e && e.message) || e) });
  }
};
