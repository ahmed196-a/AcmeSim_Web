import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, TEAM_ACCESS_CODE } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "Server is missing LiveKit settings." }, { status: 500 });
  }

  let body: { code?: string; name?: string } = {};
  try {
    body = await req.json();
  } catch {}

  if (TEAM_ACCESS_CODE && body.code !== TEAM_ACCESS_CODE) {
    return NextResponse.json({ error: "Wrong access code." }, { status: 401 });
  }

  const name = (body.name || "Tester").slice(0, 40);
  const rand = crypto.randomUUID().slice(0, 8);
  const room = `acmesim-${rand}`; // one fresh room per chat: the agent is dispatched automatically
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: `web-${rand}`,
    name,
    ttl: "30m",
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });

  // If the deployed agent has a name (LIVEKIT_AGENT_NAME on the agent), it is NOT auto-dispatched.
  // Set the same name here and the token asks LiveKit to send exactly that agent to this room.
  const agentName = process.env.LIVEKIT_AGENT_NAME?.trim();
  if (agentName) {
    at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName })] });
  }

  return NextResponse.json({ token: await at.toJwt(), url: LIVEKIT_URL, room });
}
