// server.js
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

/* ========= ENV ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // required
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "alloy";
const PORT = process.env.PORT || 10000;

/* ===== AUDIO HELPERS ===== */
// μ-law <-> PCM16
function ulawToPcm16(u) {
  u = ~u & 255;
  const s = u & 128 ? -1 : 1,
    e = (u >> 4) & 7,
    m = u & 15;
  let x = ((m << 3) + 132) << e;
  x -= 132 << e;
  return s * x;
}
function pcm16ToUlaw(p) {
  const B = 132;
  const s = p < 0 ? 128 : 0;
  let x = Math.abs(p);
  if (x > 32635) x = 32635;
  x += B;
  let e = 7;
  for (let i = 7; i > 0; i--) {
    if (x & (8064 << (i - 1))) {
      e = i;
      break;
    }
  }
  const m = (x >> (e + 3)) & 15;
  return ~(s | (e << 4) | m) & 255;
}
function ulawFrameToPcm16Array(b64) {
  const b = Buffer.from(b64, "base64");
  const out = new Int16Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = ulawToPcm16(b[i]);
  return out;
}
function pcm16ArrayToUlawFrame(int16) {
  const b = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) b[i] = pcm16ToUlaw(int16[i]);
  return Buffer.from(b).toString("base64");
}
// naive 8k <-> 16k (good enough for PoC)
function pcm8kTo16k(x8) {
  const y = new Int16Array(x8.length * 2);
  for (let i = 0; i < x8.length - 1; i++) {
    const a = x8[i],
      b = x8[i + 1];
    y[2 * i] = a;
    y[2 * i + 1] = (a + b) >> 1;
  }
  y[y.length - 2] = x8[x8.length - 1];
  y[y.length - 1] = x8[x8.length - 1];
  return y;
}
function pcm16kTo8k(x16) {
  const y = new Int16Array(Math.floor(x16.length / 2));
  for (let i = 0, j = 0; j < y.length; i += 2, j++) y[j] = x16[i];
  return y;
}

/* ===== HTTP + WS ===== */
const app = express();
app.get("/", (_r, res) => res.send("OK"));
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.ping();
  });
}, 25000);

/* ===== OpenAI Realtime ===== */
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
    ws.on("error", (e) => {
      console.error("OpenAI WS error", e);
      reject(e);
    });
    ws.on("close", (c, r) =>
      console.log("OpenAI WS close", c, r?.toString?.() || "")
    );
  });
}

/* ===== Bridge ===== */
wss.on("connection", (twilioWS) => {
  console.log("Twilio WS connected");
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY missing");
    return;
  }

  let streamSid = null;
  let oaiWS = null;

  // playback queue to Twilio
  const ttsQueue = [];
  const ttsTimer = setInterval(() => {
    if (!streamSid || ttsQueue.length === 0) return;
    const pcm16k = ttsQueue.shift();
    const pcm8k = pcm16kTo8k(pcm16k);
    const b64 = pcm16ArrayToUlawFrame(pcm8k);
    try {
      twilioWS.send(
        JSON.stringify({ event: "media", streamSid, media: { payload: b64 } })
      );
    } catch {}
  }, 20);

  // response state and barge-in
  let responseActive = false;
  let lastCancelTs = 0;
  function bargeIn() {
    const now = Date.now();
    if (oaiWS && responseActive && now - lastCancelTs > 250) {
      oaiWS.send(JSON.stringify({ type: "response.cancel" }));
      responseActive = false;
      lastCancelTs = now;
    }
  }

  // exact audio accounting at 16k
  let pendingSamples16k = 0; // samples waiting to commit
  const MIN_SAMPLES_100MS = 1600; // 100ms * 16000Hz

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

      try {
        oaiWS = await connectOpenAI();
      } catch {
        return;
      }

      // OpenAI events
      oaiWS.on("message", (buf) => {
        let m;
        try {
          m = JSON.parse(buf.toString());
        } catch {
          return;
        }
        if (m.type && m.type !== "response.output_audio.delta")
          console.log("OAI:", m.type);

        if (m.type === "response.created") responseActive = true;
        if (m.type === "response.done") responseActive = false;

        if (m.type === "response.output_audio.delta" && m.audio) {
          const b = Buffer.from(m.audio, "base64");
          ttsQueue.push(new Int16Array(b.buffer, b.byteOffset, b.length / 2));
        }
        if (m.type === "output_audio_buffer.delta" && m.delta) {
          const b = Buffer.from(m.delta, "base64");
          ttsQueue.push(new Int16Array(b.buffer, b.byteOffset, b.length / 2));
        }
        if (m.type === "error") console.error("OAI error", m);
      });

      // optional greeting
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
      // user speaks -> cancel any TTS
      bargeIn();

      // μ-law@8k -> PCM16@8k -> PCM16@16k
      const pcm8k = ulawFrameToPcm16Array(msg.media.payload);
      const pcm16k = pcm8kTo16k(pcm8k);

      // append to OpenAI buffer
      const b64 = Buffer.from(pcm16k.buffer).toString("base64");
      oaiWS.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: b64 })
      );

      // accumulate and commit only when ≥100ms
      pendingSamples16k += pcm16k.length; // 20ms frame -> 320 samples
      if (pendingSamples16k >= MIN_SAMPLES_100MS) {
        oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        pendingSamples16k = 0;

        // request a response only if none is active
        if (!responseActive) {
          oaiWS.send(JSON.stringify({ type: "response.create" }));
          responseActive = true;
        }
      }
    }

    if (msg.event === "stop") {
      console.log("stop", { streamSid });
      try {
        oaiWS && oaiWS.close();
      } catch {}
      try {
        twilioWS.close();
      } catch {}
    }
  });

  twilioWS.on("close", () => {
    clearInterval(ttsTimer);
    try {
      oaiWS && oaiWS.close();
    } catch {}
    console.log("Twilio WS closed");
  });
});

server.listen(PORT, () => console.log(`Edge up on port ${PORT} path /twilio`));
