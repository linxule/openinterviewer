# OpenInterviewer

Open-source AI-powered qualitative research interview platform. Conduct deep, nuanced interviews at scale with AI interviewers that adapt their style based on participant responses.

## Features

- **AI-Powered Interviews**: Configurable AI interviewer with structured, standard, or exploratory modes
- **Profile Extraction**: Automatically gather participant demographic information during natural conversation
- **Multi-Question Support**: Define core research questions that the AI weaves into conversation naturally
- **Study Management**: Save, edit, and manage multiple studies from the dashboard
- **Real-time Analysis**: Automatic synthesis of stated vs revealed preferences, themes, and contradictions
- **Aggregate Synthesis**: Cross-interview analysis to identify patterns across all participants
- **Follow-up Studies**: Generate new studies based on synthesis findings
- **Secure Deployment**: API keys stay server-side, never exposed to participants
- **One-Click Deploy**: Deploy your own instance to Vercel in minutes

## Deploy Your Own Instance

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/linxule/openinterviewer&env=GEMINI_API_KEY,ADMIN_PASSWORD&envDescription=API%20key%20for%20Gemini%20and%20admin%20password%20for%20researcher%20access&envLink=https://aistudio.google.com/apikey&project-name=openinterviewer&repository-name=openinterviewer&stores=%5B%7B%22type%22:%22kv%22%7D%5D)

### Quick Start

1. Click the "Deploy with Vercel" button above
2. Connect your GitHub account (if not already)
3. Enter the required environment variables:
   - `GEMINI_API_KEY`: Your Google Gemini API key ([Get one here](https://aistudio.google.com/apikey))
   - `ADMIN_PASSWORD`: Password to access the researcher dashboard
4. Click "Deploy"
5. Wait for deployment to complete (~2 minutes)
6. Visit your app and configure your study!

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key for AI interviews |
| `ADMIN_PASSWORD` | Yes | Password to protect researcher dashboard |
| `ANTHROPIC_API_KEY` | No | Optional: Use Claude instead of Gemini for interviews |
| `AI_PROVIDER` | No | `gemini` (default) or `claude` |
| `AI_MODEL` | No | Override default model (see Model Selection below) |

## How It Works

### For Researchers

1. **Setup Study** (`/setup`): Configure your research questions, profile fields, and AI behavior
2. **Save Study**: Studies are saved to your dashboard for reuse and editing
3. **Generate Link**: Create a shareable participant link with your study configuration embedded
4. **Share**: Distribute the link to participants via email, survey tools, or social media
5. **View Results** (`/dashboard`): Access individual transcripts and per-interview synthesis
6. **Aggregate Analysis**: View cross-interview patterns, themes, and divergent views
7. **Generate Follow-ups**: Create new studies based on synthesis findings to dig deeper

### For Participants

1. **Click Link**: Participants visit the shared URL
2. **Consent**: Read study information and consent to participate
3. **Interview**: Chat naturally with the AI interviewer
4. **Complete**: View summary and thank you message

### Data Flow

```text
Researcher                          Participant
    │                                    │
    ├── Setup Study                      │
    ├── Save to Dashboard                │
    ├── Generate Link ──────────────────►│
    │                                    ├── Consent
    │                                    ├── Interview
    │                                    │       ↓
    │                                    │   AI Interviewer (Gemini/Claude)
    │                                    │       ↓
    │                                    └── Complete
    │                                           ↓
    │◄───────────────────────────── Vercel KV (Storage)
    │
    ├── View Individual Synthesis
    ├── Run Aggregate Analysis
    └── Generate Follow-up Studies
```

## Local Development

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env.local
# Edit .env.local with your API keys

# Run development server
npm run dev

# Build for production
npm run build
```

### Development without Vercel KV

The app works without Vercel KV during development:
- Interview data is not persisted (warning shown)
- Dashboard shows empty state
- All other features work normally

To test with KV locally, install the [Vercel CLI](https://vercel.com/docs/cli) and run:

```bash
vercel link
vercel env pull .env.local
```

## Project Structure

```text
/src
├── app/                      # Next.js App Router pages
│   ├── api/                  # API routes (server-side)
│   │   ├── interview/        # AI interview generation
│   │   ├── greeting/         # Interview greeting
│   │   ├── synthesis/        # Individual + aggregate analysis
│   │   ├── studies/          # Study CRUD operations
│   │   ├── generate-link/    # Participant URL generation
│   │   ├── interviews/       # Interview CRUD + export
│   │   ├── auth/             # Authentication
│   │   └── config/           # API key status check
│   ├── setup/                # Study configuration
│   ├── consent/              # Participant consent
│   ├── interview/            # Interview chat
│   ├── synthesis/            # Analysis view
│   ├── export/               # Data export
│   ├── dashboard/            # Researcher dashboard
│   ├── studies/              # Study list + detail views
│   ├── login/                # Researcher login
│   └── p/[token]/            # Participant entry point
├── components/               # React components
├── hooks/                    # Custom React hooks
├── lib/                      # Server-side utilities
│   ├── ai.ts                 # AI provider abstraction
│   ├── providers/            # Gemini & Claude implementations
│   └── kv.ts                 # Vercel KV client
├── utils/                    # Client-side utilities
├── services/                 # Client-side services
├── store.ts                  # Zustand state management
├── types.ts                  # TypeScript types
└── middleware.ts             # Auth protection
```

## AI Provider Configuration

### Default: Gemini

The app uses Gemini by default for all AI operations:
- Interview responses
- Greeting generation
- Interview synthesis

### Model Selection

Models can be selected at two levels:

1. **Per-study (UI)**: Choose a model in the Study Setup page for each study
2. **Environment default**: Set default models via environment variables

**Priority:** Study UI selection > Provider-specific env var > Legacy `AI_MODEL` > Default

#### Environment Variables

```env
# Gemini default model
GEMINI_MODEL=gemini-2.5-flash

# Claude default model
CLAUDE_MODEL=claude-sonnet-4-5

# Legacy (deprecated - use provider-specific vars above)
AI_MODEL=gemini-2.5-flash
```

#### Available Models

**Gemini:**

| Model | Description |
|-------|-------------|
| `gemini-2.5-flash` | Fast, cost-effective (default) |
| `gemini-2.5-pro` | Higher quality |
| `gemini-3-pro-preview` | Most intelligent (preview, may require allowlisting) |

**Claude:**

| Model | Description | Pricing |
|-------|-------------|---------|
| `claude-haiku-4-5` | Fastest | $1/$5 per MTok |
| `claude-sonnet-4-5` | Balanced (default) | $3/$15 per MTok |
| `claude-opus-4-5` | Most capable | $15/$75 per MTok |

**Note:** Preview models may require API access approval. Check [Google AI docs](https://ai.google.dev/gemini-api/docs/models) and [Anthropic docs](https://docs.anthropic.com/en/docs/about-claude/models) for the latest model availability.

### Optional: Claude for Interviews

To use Claude instead of Gemini:

```env
AI_PROVIDER=claude
ANTHROPIC_API_KEY=your-claude-api-key
CLAUDE_MODEL=claude-sonnet-4-5
```

### AI Reasoning Mode

The app automatically uses enhanced reasoning (thinking mode) for analytical operations like synthesis, while keeping interviews fast and conversational.

**Default Behavior:**

| Operation | Reasoning | Model Used |
|-----------|-----------|------------|
| Interview responses | OFF | User-selected model |
| Greeting generation | OFF | User-selected model |
| Per-interview synthesis | ON (high) | Auto-upgraded (Gemini 3 Pro / Claude Opus) |
| Aggregate synthesis | ON (high) | Auto-upgraded |
| Follow-up study generation | ON (high) | Auto-upgraded |

**Per-Study Override:**

In Study Setup, you can override the default behavior:
- **Automatic (recommended)**: Use defaults above
- **Always enabled**: Force reasoning ON for all operations (slower interviews)
- **Always disabled**: Force reasoning OFF for all operations (faster but less thorough synthesis)

**Cost Implications:**
- Synthesis operations automatically use premium models for best quality
- Gemini: Uses `gemini-3-pro-preview` for synthesis
- Claude: Uses `claude-opus-4-5` ($15/$75 per MTok) for synthesis
- Reasoning tokens count toward billing

**Troubleshooting:**
- If synthesis fails silently, check API quotas for premium models
- `gemini-3-pro-preview` may require allowlisting in Google AI Studio
- Claude Opus ($15/$75/MTok) is used for synthesis - monitor costs
- Set reasoning to "Always disabled" if you want to use your selected model without upgrades

## Configuring API Keys

API keys are managed through environment variables in your Vercel dashboard:

1. Go to your Vercel project → **Settings** → **Environment Variables**
2. Add or update the required variables
3. **Redeploy** for changes to take effect (Production deployments pick up new values automatically)

### Required Keys

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | Powers AI interviews (server-side) |
| `ADMIN_PASSWORD` | Protects researcher dashboard |

### Optional Keys

| Variable | Purpose | When Needed |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Use Claude for interviews | When AI Provider is set to "Claude" |
| `GEMINI_MODEL` | Override default Gemini model | To change from `gemini-2.5-flash` |
| `CLAUDE_MODEL` | Override default Claude model | To change from `claude-sonnet-4-5` |
| `SESSION_SECRET` | Separate session signing key | Advanced: separate from ADMIN_PASSWORD |
| `PARTICIPANT_TOKEN_SECRET` | Separate token signing key | Advanced: separate from ADMIN_PASSWORD |

### Getting API Keys

- **Gemini**: [Google AI Studio](https://aistudio.google.com/apikey) - Free tier available
- **Claude**: [Anthropic Console](https://console.anthropic.com/) - Requires account with credits

## Link Management

### Link Expiration

When creating a study, you can set participant links to expire after:

- 7 days
- 30 days
- 90 days
- Never (default)

Expired links show an error message directing participants to request a new link.

### Link Revocation

From the Study Detail page, you can instantly revoke all participant links by toggling "Links Enabled" off. This is useful if:

- You've finished data collection
- You suspect the link has been shared inappropriately
- You need to pause the study temporarily

## Security

### API Key Protection

- **Server-side keys** (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`): Stored as environment variables, never exposed to browser
- **Participant URLs**: Signed JWT tokens that cannot be tampered with
- **Dashboard**: Password-protected with HTTP-only cookie authentication
- **Data**: Stored in Vercel KV (Redis) with encrypted connections

## License

MIT

## Contributing

Contributions welcome! Please read the contributing guidelines before submitting PRs.
