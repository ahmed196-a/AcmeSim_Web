"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ParticipantEvent,
  ParticipantKind,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";

type Msg = { id: string; role: "me" | "bot" | "sys"; text: string; voice?: boolean; final?: boolean };

const ATTR_SEGMENT = "lk.segment_id";
const ATTR_FINAL = "lk.transcription_final";
const ATTR_TRACK = "lk.transcribed_track_id";

const DEFAULT_GREETING =
  "Hello! Thanks for reaching out to ACMeSIM support. I'm your virtual assistant. How can I help you today?";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Page() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [waiting, setWaiting] = useState(false);

  // Push-to-talk recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [rpcInFlight, setRpcInFlight] = useState(false);
  const [isThinking, setIsThinking] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioBox = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Audio playback permission (true = unmuted for voice reply; false = muted for typed messages)
  const audioAllowedRef = useRef(false);

  // Recording tracking refs
  const recordStartTimeRef = useRef(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const isRecordingRef = useRef(false);
  const currentRecordingIdRef = useRef<string | null>(null);
  const voiceSegmentsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, waiting, isRecording, isThinking]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      roomRef.current?.disconnect();
    };
  }, []);

  const muteAgentAudio = useCallback(() => {
    audioAllowedRef.current = false;
    audioBox.current?.querySelectorAll("audio").forEach((a) => (a.muted = true));
  }, []);

  const unmuteAgentAudio = useCallback(() => {
    audioAllowedRef.current = true;
    audioBox.current?.querySelectorAll("audio").forEach((a) => (a.muted = false));
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

  const getAgentParticipant = useCallback((room: Room): RemoteParticipant | undefined => {
    return (
      [...room.remoteParticipants.values()].find(
        (p) => p.kind === ParticipantKind.AGENT || p.identity.startsWith("agent-")
      ) || [...room.remoteParticipants.values()][0]
    );
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

      // Handles agent replies and user transcripts
      const handleStream = async (reader: Parameters<Parameters<typeof room.registerTextStreamHandler>[1]>[0]) => {
        try {
          const attrs = reader.info.attributes ?? {};
          const id = attrs[ATTR_SEGMENT] || reader.info.id;
          const trackId = attrs[ATTR_TRACK];
          const mine = !!trackId && [...room.localParticipant.trackPublications.values()].some((p) => p.trackSid === trackId);
          let acc = "";

          for await (const chunk of reader) {
            acc += chunk;
            if (mine) {
              // Accumulate user voice transcript segments
              voiceSegmentsRef.current.set(id, acc);
              const recId = currentRecordingIdRef.current;
              // Only display in the chat bubble once the user has stopped recording
              if (recId && !isRecordingRef.current) {
                const merged = Array.from(voiceSegmentsRef.current.values()).filter(Boolean).join(" ").trim();
                if (merged) {
                  upsert({ id: recId, role: "me", text: merged, voice: true, final: attrs[ATTR_FINAL] === "true" });
                }
              }
            } else {
              // Agent reply chunk arrives
              setIsThinking(false);
              setWaiting(false);
              upsert({ id, role: "bot", text: acc, voice: !!trackId, final: attrs[ATTR_FINAL] === "true" });
            }
          }

          if (mine) {
            voiceSegmentsRef.current.set(id, acc);
            const recId = currentRecordingIdRef.current;
            if (recId && !isRecordingRef.current) {
              const merged = Array.from(voiceSegmentsRef.current.values()).filter(Boolean).join(" ").trim();
              if (merged) {
                upsert({ id: recId, role: "me", text: merged, voice: true, final: true });
              }
            }
          } else {
            setIsThinking(false);
            setWaiting(false);
            if (attrs[ATTR_FINAL] === "true") {
              upsert({ id, role: "bot", text: acc, voice: !!trackId, final: true });
            }
          }
        } catch {
          // Room disconnected or stream aborted; ignore
        }
      };

      room.registerTextStreamHandler("lk.transcription", handleStream);
      room.registerTextStreamHandler("lk.chat", handleStream);

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.muted = !audioAllowedRef.current; // muted by default until voice reply is requested
          audioBox.current?.appendChild(el);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));

      room.on(RoomEvent.ParticipantConnected, (p) => {
        p.on(ParticipantEvent.IsSpeakingChanged, setAgentSpeaking);
      });

      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        isRecordingRef.current = false;
        setIsRecording(false);
        setIsThinking(false);
        setWaiting(false);
        setRpcInFlight(false);
        muteAgentAudio();
        upsert({ id: "sys-end", role: "sys", text: "Chat ended" });
      });

      await room.connect(data.url, data.token);
      await room.startAudio(); // user gesture allowed inside click handler
      room.remoteParticipants.forEach((p) => p.on(ParticipantEvent.IsSpeakingChanged, setAgentSpeaking));
      setConnected(true);

      // Default visual greeting
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

  async function startRecording() {
    const room = roomRef.current;
    if (!room || rpcInFlight || isRecordingRef.current) return;
    setError("");
    setRpcInFlight(true);

    try {
      await room.startAudio(); // satisfies mobile browser autoplay policy
      const agent = getAgentParticipant(room);
      if (!agent) {
        setError("Assistant is not ready yet. Please wait a moment.");
        setRpcInFlight(false);
        return;
      }

      const res = await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: "start_turn",
        payload: "",
      });
      if (res && res.startsWith("error:")) {
        throw new Error(res);
      }

      await room.localParticipant.setMicrophoneEnabled(true);

      isRecordingRef.current = true;
      setIsRecording(true);
      setRecordSeconds(0);
      recordStartTimeRef.current = Date.now();
      currentRecordingIdRef.current = `voice-${Date.now()}`;
      voiceSegmentsRef.current.clear();

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setRecordSeconds((s) => {
          if (s >= 59) {
            // Auto-stop after 60 seconds
            stopRecording();
            return 60;
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      setError("Failed to start recording. Please check microphone permissions.");
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      isRecordingRef.current = false;
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    } finally {
      setRpcInFlight(false);
    }
  }

  async function stopRecording() {
    const room = roomRef.current;
    if (!room || !isRecordingRef.current || rpcInFlight) return;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const duration = Date.now() - recordStartTimeRef.current;
    if (duration < 600) {
      // Ignore recordings shorter than ~0.6s (treat as cancel)
      await cancelRecording();
      return;
    }

    setRpcInFlight(true);
    setError("");

    try {
      await room.startAudio(); // mobile autoplay satisfaction
      unmuteAgentAudio(); // unmute agent audio for this spoken reply

      // Wait ~500 ms so the last words are not cut off before stopping
      await new Promise((resolve) => setTimeout(resolve, 500));

      const agent = getAgentParticipant(room);
      if (agent) {
        await room.localParticipant.performRpc({
          destinationIdentity: agent.identity,
          method: "end_turn",
          payload: "",
        });
      }

      await room.localParticipant.setMicrophoneEnabled(false);
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsThinking(true);

      // Insert or finalize the single merged user bubble
      const recId = currentRecordingIdRef.current;
      if (recId) {
        const merged = Array.from(voiceSegmentsRef.current.values()).filter(Boolean).join(" ").trim();
        upsert({
          id: recId,
          role: "me",
          text: merged || "🎤 Voice message",
          voice: true,
          final: true,
        });
      }
    } catch (err) {
      setError("Failed to send recording.");
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      isRecordingRef.current = false;
      setIsRecording(false);
      muteAgentAudio();
    } finally {
      setRpcInFlight(false);
    }
  }

  async function cancelRecording() {
    const room = roomRef.current;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    isRecordingRef.current = false;
    setIsRecording(false);
    currentRecordingIdRef.current = null;
    voiceSegmentsRef.current.clear();
    muteAgentAudio();

    if (!room) return;
    setRpcInFlight(true);
    try {
      const agent = getAgentParticipant(room);
      if (agent) {
        await room.localParticipant.performRpc({
          destinationIdentity: agent.identity,
          method: "cancel_turn",
          payload: "",
        });
      }
    } catch {
      // Discard silently on cancel
    } finally {
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      setRpcInFlight(false);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    const room = roomRef.current;
    if (!text || !room || rpcInFlight || isRecording) return;
    setInput("");
    // Mute audio for typed message reply
    muteAgentAudio();
    upsert({ id: `me-${Date.now()}`, role: "me", text, final: true });
    setWaiting(true);
    setIsThinking(true);
    await room.localParticipant.sendText(text, { topic: "lk.chat" });
  }

  function leave() {
    if (timerRef.current) clearInterval(timerRef.current);
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
            {isRecording && (
              <div className="b me interim">
                <span className="tag">🎤 recording</span>
                Recording {formatTime(recordSeconds)}
              </div>
            )}
            {(waiting || isThinking) && <div className="dots">••• Thinking…</div>}
            <div ref={endRef} />
          </div>

          <div className="voice">
            {isRecording
              ? "Recording… Tap stop to send, or ✕ to cancel."
              : isThinking
              ? "Thinking…"
              : "Tap the mic, speak, then tap stop to send."}
          </div>
          {error && <div className="voice err">{error}</div>}

          {isRecording ? (
            <div className="bar">
              <button
                type="button"
                className="round"
                style={{ background: "#71767b", fontSize: "16px" }}
                onClick={cancelRecording}
                disabled={rpcInFlight}
                title="Cancel recording"
              >
                ✕
              </button>
              <div style={{ flex: 1, textAlign: "center", fontWeight: 600, color: "var(--err)" }}>
                ⏺ Recording {formatTime(recordSeconds)}
              </div>
              <button
                type="button"
                className="round live"
                onClick={stopRecording}
                disabled={rpcInFlight}
                title="Stop and send"
              >
                ⏹
              </button>
            </div>
          ) : (
            <form className="bar" onSubmit={send}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message"
                autoFocus
                disabled={rpcInFlight}
              />
              <button
                type="button"
                className="round"
                onClick={startRecording}
                disabled={rpcInFlight}
                title="Tap to speak"
              >
                🎤
              </button>
              <button className="round" disabled={!input.trim() || rpcInFlight} title="Send">
                ➤
              </button>
            </form>
          )}
        </>
      )}
      <div ref={audioBox} hidden />
    </div>
  );
}
