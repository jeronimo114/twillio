import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// ---------------- audio utils ----------------
function ulawToPcm16(u) {
  // G.711 μ-law → PCM16
  u = ~u & 0xff;
  const sign = u & 0x80 ? -1 : 1;
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84 << exponent;
  return sign * sample;
}
function pcm16ToUlaw(pcm) {
  // PCM16 → μ-law
  const BIAS = 0x84;
  let sign = pcm < 0 ? 0x80 : 0x00;
  pcm = Math.abs(pcm);
  if (pcm > 32635) pcm = 32635;
  pcm += BIAS;
  let exponent = 7;
  for (let e = 7; e > 0; e--) {
    if (pcm & (0x1f80 << (e - 1))) {
      exponent = e;
      break;
    }
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  let ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulaw;
}
function base64ToBytes(b64) {
  return Buffer.from(b64, "base64");
}
function bytesToBase64(buf) {
  return Buffer.from(buf).toString("base64");
}

// naive resamplers (good enough for PoC)
function pcm8kTo16k(int16) {
  // linear upsample x2
  const out = new Int16Array(int16.length * 2);
  for (let i = 0; i < int16.length - 1; i++) {
    const a = int16[i],
      b = int16[i + 1];
    out[2 * i] = a;
    out[2 * i + 1] = (a + b) >> 1;
  }
  out[out.length - 2] = int16[int16.length - 1];
  out[out.length - 1] = int16[int16.length - 1];
  return out;
}
function pcm16kTo8k(int16) {
  // decimate x2
  const out = new Int16Array(Math.floor(int16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16[i];
  return out;
}

// μ-law frame helpers (Twilio frames are ~20ms @8kHz ≈ 160 bytes)
function ulawFrameToPcm16Array(b64) {
  const bytes = base64ToBytes(b64);
  const pcm = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) pcm[i] = ulawToPcm16(bytes[i]);
  return pcm;
}
function pcm16ArrayToUlawFrame(int16) {
  const bytes = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) {
    bytes[i] = pcm16ToUlaw(int16[i]);
  }
  return bytesToBase64(bytes);
}

// --------------- server ----------------
const app = express();
app.get("/", (_req, res) => res.send("OK"));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

setInterval(() => {
  // keepalive
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.ping();
  });
}, 25000);

wss.on("connection", (twilioWS) => {
  console.log("Twilio WS connected");
  let streamSid = null;
  let oaiWS = null;
  let playing = false; // are we currently sending TTS back
  let ttsQueue = []; // PCM16@16k from OpenAI awaiting downsample/send

  // helper: send μ-law back to Twilio
  function sendToTwilio(pcm16_16k) {
    if (!streamSid) return;
    const pcm8k = pcm16kTo8k(pcm16_16k);
    const b64 = pcm16ArrayToUlawFrame(pcm8k);
    twilioWS.send(
      JSON.stringify({ event: "media", streamSid, media: { payload: b64 } })
    );
  }

  // OpenAI Realtime WS connect
  async function connectOpenAI() {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
        OPENAI_MODEL
      )}`;
      const headers = {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      };
      const ws = new WebSocket(url, { headers });

      ws.on("open", () => {
        // configure session to output PCM16@16k
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              input_audio_format: { type: "pcm16", sample_rate: 16000 },
              output_audio_format: { type: "pcm16", sample_rate: 16000 },
              input_audio_transcription: { enabled: true },
              turn_detection: { type: "server_vad" },
              voice: "alloy",
            },
          })
        );
        resolve(ws);
      });
      ws.on("error", reject);

      // handle audio deltas from OpenAI (varies by release; handle both common shapes)
      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        // Newer schema
        if (msg.type === "response.output_audio.delta" && msg.audio) {
          const buf = Buffer.from(msg.audio, "base64");
          const int16 = new Int16Array(
            buf.buffer,
            buf.byteOffset,
            buf.length / 2
          );
          ttsQueue.push(new Int16Array(int16)); // copy
        }
        // Older schema
        if (msg.type === "output_audio_buffer.delta" && msg.delta) {
          const buf = Buffer.from(msg.delta, "base64");
          const int16 = new Int16Array(
            buf.buffer,
            buf.byteOffset,
            buf.length / 2
          );
          ttsQueue.push(new Int16Array(int16));
        }
      });
    });
  }

  // pump TTS queue to Twilio as μ-law frames
  const ttsTimer = setInterval(() => {
    if (!playing) return;
    if (ttsQueue.length === 0) return;
    const chunk = ttsQueue.shift(); // PCM16@16k
    sendToTwilio(chunk);
  }, 20); // ~20ms pacing

  twilioWS.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.streamSid;
      console.log("start", { callSid: msg.start.callSid, streamSid });
      if (!OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY missing");
        return;
      }
      oaiWS = await connectOpenAI();

      // start first response cycle so TTS can flow
      oaiWS.send(JSON.stringify({ type: "response.create" }));
      playing = true; // allow playback
    }

    if (msg.event === "media" && oaiWS) {
      // barge-in: on fresh caller audio, allow model to hear it immediately
      // also keep playing flag true, but any queued TTS will drain naturally
      const pcm8k = ulawFrameToPcm16Array(msg.media.payload); // Int16@8k
      const pcm16k = pcm8kTo16k(pcm8k); // Int16@16k

      // stream to OpenAI input buffer
      const audioB64 = Buffer.from(pcm16k.buffer).toString("base64");
      oaiWS.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: audioB64 })
      );
      // optionally commit at short intervals to create turns; simple heuristic:
      // here we commit on every frame to keep latency low
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      oaiWS.send(JSON.stringify({ type: "response.create" }));
    }

    if (msg.event === "stop") {
      console.log("stop", { streamSid });
      try {
        oaiWS && oaiWS.close();
      } catch (_) {}
      try {
        twilioWS.close();
      } catch (_) {}
    }
  });

  twilioWS.on("close", () => {
    clearInterval(ttsTimer);
    try {
      oaiWS && oaiWS.close();
    } catch (_) {}
    console.log("Twilio WS closed");
  });
});

const PORT = process.env.PORT || 10000; // Render uses PORT env; leave as-is
server.listen(PORT, () => console.log("Edge up on port", PORT, "path /twilio"));
