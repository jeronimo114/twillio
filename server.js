// server.js
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

/* ====================== ENV ====================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // required
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "alloy";
const PORT = process.env.PORT || 10000;

/* ================ AUDIO HELPERS =================== */
// μ-law <-> PCM16
function ulawToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80 ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84 << exponent;
  return sign * sample;
}
function pcm16ToUlaw(pcm) {
  const BIAS = 0x84;
  const sign = pcm < 0 ? 0x80 : 0x00;
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
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function ulawFrameToPcm16Array(b64) {
  const bytes = Buffer.from(b64, "base64");
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ulawToPcm16(bytes[i]);
  return out;
}
function pcm16ArrayToUlawFrame(int16) {
  const bytes = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) bytes[i] = pcm16ToUlaw(int16[i]);
  return Buffer.from(bytes).toString("base64");
}
// naive 8k ↔ 16k (good enough for PoC)
function pcm8kTo16k(x8) {
  const y = new Int16Array(x8.length * 2);
  for (let i = 0; i < x8.length - 1; i++) {
    const a = x8[i],
      b = x8[i + 1];
    y[2 * i] = a;
    y[2 * i + 1] = (a + b) >> 1;
  }
  const last = x8[x8.length - 1];
  y[y.length - 2] = last;
  y[y.length - 1] = last;
  return y;
}
function pcm16kTo8k(x16) {
  const y = new Int16Array(Math.floor(x16.length / 2));
  for (let i = 0, j = 0; j < y.length; i += 2, j++) y[j] = x16[i];
  return y;
}

/* ==================== HTTP + WS =================== */
const app = express();
app.get("/", (_req, res) => res.send("OK")); // health
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

// keepalive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.ping();
  });
}, 25000);

/* ================ OPENAI REALTIME ================= */
function connectOpenAI() {
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
      console.log("OpenAI WS open");
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            input_audio_format: { type: "pcm16", sample_rate: 16000 },
            output_audio_format: { type: "pcm16", sample_rate: 16000 },
            input_audio_transcription: { enabled: true },
            turn_detection: { type: "server_vad" },
            voice: OPENAI_VOICE,
          },
        })
      );
      resolve(ws);
    });
    ws.on("close", (c, r) =>
      console.log("OpenAI WS close", c, r?.toString?.() || "")
    );
    ws.on("error", (e) => {
      console.error("OpenAI WS error", e);
      reject(e);
    });

    // caller handles messages (we attach per-connection below)
  });
}

/* =================== BRIDGE LOOP ================== */
wss.on("connection", (twilioWS) => {
  console.log("Twilio WS connected");
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY missing");
    return;
  }

  let streamSid = null;
  let oaiWS = null;
  const ttsQueue = []; // PCM16@16k chunks from OpenAI
  let mediaFrameCount = 0;

  // pace TTS back to Twilio ~20ms
  const ttsTimer = setInterval(() => {
    if (!streamSid || ttsQueue.length === 0) return;
    const pcm16k = ttsQueue.shift();
    const pcm8k = pcm16kTo8k(pcm16k);
    const b64 = pcm16ArrayToUlawFrame(pcm8k);
    try {
      twilioWS.send(
        JSON.stringify({ event: "media", streamSid, media: { payload: b64 } })
      );
    } catch (_) {}
  }, 20);

  // Twilio → Edge
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

      // connect OpenAI
      try {
        oaiWS = await connectOpenAI();
      } catch (e) {
        console.error("OpenAI connect failed", e);
        return;
      }

      // attach OpenAI message handler
      oaiWS.on("message", (buf) => {
        let m;
        try {
          m = JSON.parse(buf.toString());
        } catch {
          return;
        }
        if (m.type && m.type !== "response.output_audio.delta")
          console.log("OAI:", m.type);

        // new schema
        if (m.type === "response.output_audio.delta" && m.audio) {
          const b = Buffer.from(m.audio, "base64");
          ttsQueue.push(new Int16Array(b.buffer, b.byteOffset, b.length / 2));
        }
        // older schema
        if (m.type === "output_audio_buffer.delta" && m.delta) {
          const b = Buffer.from(m.delta, "base64");
          ttsQueue.push(new Int16Array(b.buffer, b.byteOffset, b.length / 2));
        }
        if (m.type === "error") console.error("OAI error", m);
      });

      // optional greeting so you hear audio without speaking first
      oaiWS.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: "Hola, soy tu asistente. ¿En qué puedo ayudar?",
          },
        })
      );
    }

    if (msg.event === "media" && oaiWS) {
      // μ-law@8k -> PCM16@8k -> PCM16@16k
      const pcm8k = ulawFrameToPcm16Array(msg.media.payload);
      const pcm16k = pcm8kTo16k(pcm8k);
      const b64 = Buffer.from(pcm16k.buffer).toString("base64");
      // append caller audio
      oaiWS.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: b64 })
      );

      // commit every ~100ms to balance latency vs ASR quality
      mediaFrameCount++;
      if (mediaFrameCount % 5 === 0) {
        oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oaiWS.send(JSON.stringify({ type: "response.create" }));
      }
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

/* ==================== START ======================= */
server.listen(PORT, () => {
  console.log(`Edge up on port ${PORT} path /twilio`);
});
