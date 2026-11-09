"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ParticipantEvent, Room, RoomEvent, Track } from "livekit-client";

type Msg = { id: string; role: "me" | "bot" | "sys"; text: string; voice?: boolean; final?: boolean };

const ATTR_SEGMENT = "lk.segment_id";
const ATTR_FINAL = "lk.transcription_final";
const ATTR_TRACK = "lk.transcribed_track_id";

const DEFAULT_GREETING =
  "Hello! Thanks for reaching out to ACMeSIM support. I'm your virtual assistant. How can I help you today?";

export default function Page() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [micOn, setMicOn] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [waiting, setWaiting] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioBox = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const micRef = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, waiting]);

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
    };
  }, []);

  const upsert = useCallback((m: Msg) => {
    setMsgs((cur) => {
      // Replace the initial default greeting placeholder once live agent messages start streaming
      const cleaned =
        m.role === "bot" && m.id !== "default-greeting" && cur.some((x) => x.id === "default-greeting")
          ? cur.filter((x) => x.id !== "default-greeting")
          : cur;
      const i = cleaned.findIndex((x) => x.id === m.id);
      if (i === -1) return [...cleaned, m];
      const next = cleaned.slice();
      next[i] = { ...cleaned[i], ...m };
      return next;
    });
  }, []);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setConnecting(true);
    setMsgs([]);
    try {
      const r = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, code }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not start a chat.");

      const room = new Room({ adaptiveStream: true });
      roomRef.current = room;

      // Handles agent replies (both spoken reply transcripts and text replies)
      const handleStream = async (reader: Parameters<Parameters<typeof room.registerTextStreamHandler>[1]>[0]) => {
        try {
          const attrs = reader.info.attributes ?? {};
          const id = attrs[ATTR_SEGMENT] || reader.info.id;
          const trackId = attrs[ATTR_TRACK];
          const mine = !!trackId && [...room.localParticipant.trackPublications.values()].some((p) => p.trackSid === trackId);
          let acc = "";
          for await (const chunk of reader) {
            acc += chunk;
            upsert({ id, role: mine ? "me" : "bot", text: acc, voice: !!trackId, final: attrs[ATTR_FINAL] === "true" });
            if (!mine) setWaiting(false);
          }
          if (attrs[ATTR_FINAL] === "true") upsert({ id, role: mine ? "me" : "bot", text: acc, voice: !!trackId, final: true });
        } catch {
          // Room disconnected or stream aborted; ignore
        }
      };

      room.registerTextStreamHandler("lk.transcription", handleStream);
      room.registerTextStreamHandler("lk.chat", handleStream);

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.muted = !micRef.current; // text mode: show the reply as text, do not play it
          audioBox.current?.appendChild(el);
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
      room.on(RoomEvent.ParticipantConnected, (p) => {
        p.on(ParticipantEvent.IsSpeakingChanged, setAgentSpeaking);
      });
      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
        micRef.current = false;
        setMicOn(false);
        setWaiting(false);
        upsert({ id: "sys-end", role: "sys", text: "Chat ended" });
      });

      await room.connect(data.url, data.token);
      await room.startAudio(); // allowed: we are inside the click handler
      room.remoteParticipants.forEach((p) => p.on(ParticipantEvent.IsSpeakingChanged, setAgentSpeaking));
      setConnected(true);
      // Ensure the agent sends/displays the first greeting message by default
      upsert({
        id: "default-greeting",
        role: "bot",
        text: DEFAULT_GREETING,
        final: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      roomRef.current?.disconnect();
    } finally {
      setConnecting(false);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    const room = roomRef.current;
    if (!text || !room) return;
    setInput("");
    upsert({ id: `me-${Date.now()}`, role: "me", text, final: true });
    setWaiting(true);
    await room.localParticipant.sendText(text, { topic: "lk.chat" });
  }

  async function toggleMic() {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      micRef.current = !micOn;
      audioBox.current?.querySelectorAll("audio").forEach((a) => (a.muted = micOn)); // mic going on => unmute
      setMicOn(!micOn);
    } catch {
      setError("Microphone is blocked. Allow it in the browser to use voice.");
    }
  }

  function leave() {
    roomRef.current?.disconnect();
  }

  return (
    <div className="shell">
      <div className="head">
        <div className="avatar">A</div>
        <div>
          <h1>ACMeSIM Support</h1>
          <small>{connected ? (agentSpeaking ? "speaking…" : "online") : "test client, not WhatsApp"}</small>
        </div>
        {connected && <button onClick={leave}>End</button>}
      </div>

      {!connected ? (
        <form className="join" onSubmit={join}>
          <h2>Start a test chat</h2>
          <p>Type or talk to the ACMeSIM assistant. Answers come from the ACMeSIM knowledge base.</p>
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Team access code" type="password" value={code} onChange={(e) => setCode(e.target.value)} />
          {error && <div className="err">{error}</div>}
          <button disabled={connecting}>{connecting ? "Connecting…" : "Start chat"}</button>
        </form>
      ) : (
        <>
          <div className="msgs">
            {msgs.map((m) =>
              m.role === "sys" ? (
                <div key={m.id} className="sys">{m.text}</div>
              ) : (
                <div key={m.id} className={`b ${m.role} ${m.final === false ? "interim" : ""}`}>
                  {m.voice && <span className="tag">🎤 voice</span>}
                  {m.text}
                </div>
              )
            )}
            {waiting && <div className="dots">•••</div>}
            <div ref={endRef} />
          </div>
          <div className="voice">
            {micOn ? "Microphone on. Just speak; the assistant answers out loud." : "Mic off: replies appear as text. Tap 🎤 to talk and hear them."}
          </div>
          {error && <div className="voice err">{error}</div>}
          <form className="bar" onSubmit={send}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message" autoFocus />
            <button type="button" className={`round ${micOn ? "live" : ""}`} onClick={toggleMic} title="Voice on/off">🎤</button>
            <button className="round" disabled={!input.trim()} title="Send">➤</button>
          </form>
        </>
      )}
      <div ref={audioBox} hidden />
    </div>
  );
}
