import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
app.get("/", (_req, res) => res.send("OK")); // health check

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

// Send a little silence back so you know return audio works
const ulawSilence = Buffer.alloc(160, 0xff).toString("base64"); // ~20ms

wss.on("connection", (ws) => {
  console.log("Twilio connected");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      console.log("callSid:", msg.start.callSid, "streamSid:", msg.streamSid);
      // optional: send a few silent frames to verify outbound path
      for (let i = 0; i < 5; i++) {
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid: msg.streamSid,
            media: { payload: ulawSilence },
          })
        );
      }
    }

    if (msg.event === "media") {
      // Here later you will forward audio to OpenAI Realtime.
      // For now we just count frames.
    }

    if (msg.event === "stop") {
      console.log("stream stopped");
    }
  });

  ws.on("close", () => console.log("Twilio disconnected"));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Edge up on port", PORT, "path /twilio"));
