# ACMeSIM Web Client

Web test interface for the ACMeSIM LiveKit voice and text assistant (Next.js + React).

## Getting Started

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
Copy `.env.example` to `.env.local` and fill in your values:
```bash
cp .env.example .env.local
```

Required variables:
- `LIVEKIT_URL`: Your LiveKit Cloud WebSocket URL (`wss://<project-subdomain>.livekit.cloud`)
- `LIVEKIT_API_KEY`: LiveKit Cloud API key
- `LIVEKIT_API_SECRET`: LiveKit Cloud API secret
- `LIVEKIT_AGENT_NAME`: The name of the registered LiveKit agent (e.g. `ACMeSIM-agent`)
- `TEAM_ACCESS_CODE`: Access code required for users to enter the chat

### 3. Run development server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deploying to Vercel

1. Push this repository to GitHub.
2. In Vercel, click **Add New Project** and select this repository.
3. In **Environment Variables**, add:
   - `LIVEKIT_URL`
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
   - `LIVEKIT_AGENT_NAME`
   - `TEAM_ACCESS_CODE`
4. Click **Deploy**.
