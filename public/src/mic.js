// Microphone capture: getUserMedia -> AudioWorklet -> 16 kHz linear16 chunks,
// with an analyser tap so the visualization can react to the user's voice.
//
// We request the browser's built-in voice processing (echo cancellation, noise
// suppression, auto gain). Echo cancellation matters for a voice UI: without it
// the TTS output leaking into the mic can trip Flux's turn detection — and it
// would also make the particle field react to its own output.

import { MIC } from "./config.js";
import { createAnalyserTap } from "./analyser.js";

/**
 * @param {(frame: ArrayBuffer) => void} onFrame  called with each ~80 ms linear16 chunk
 * @param {(level: number) => void} onLevel       called with RMS level 0..1 for the meter
 * @returns {Promise<{ tap, stop: () => void }>}
 */
export async function startMic({ onFrame, onLevel }) {
  // Throws NotAllowedError if the user denies, NotFoundError if no device.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/pcm-worklet.js");

  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, "pcm-worklet", {
    processorOptions: {
      targetSampleRate: MIC.targetSampleRate,
      chunkMs: MIC.chunkMs,
    },
  });

  worklet.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "audio") onFrame(msg.buffer);
    else if (msg.type === "level") onLevel?.(msg.level);
  };

  // Analyser tap for the visualization. It hangs off the source as a side
  // branch and is never connected onward — an AnalyserNode is a pass-through
  // that still fills its buffers from what's pushed into it, so it doesn't need
  // to reach the destination (and must not, or we'd hear the mic).
  const tap = createAnalyserTap(ctx);
  source.connect(tap.node);

  // A worklet only runs while it's part of a graph that reaches a destination.
  // Route through a muted gain node so it's pulled WITHOUT playing the mic back
  // to the user (which would be an echo).
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(worklet);
  worklet.connect(mute);
  mute.connect(ctx.destination);

  return {
    tap,
    stop() {
      // Teardown: release the OS mic indicator and free the graph.
      stream.getTracks().forEach((t) => t.stop());
      try {
        source.disconnect();
        worklet.disconnect();
        mute.disconnect();
        tap.node.disconnect();
      } catch {}
      ctx.close();
    },
  };
}
