🧠 WealthOS — PRD + Technical Design Document
1. 📌 Product Overview
1.1 What is WealthOS?

WealthOS is a Relationship Manager (RM) operating system that:

Guides daily client communication

Recommends what to say, to whom, and why

Tracks actions, compliance, and outcomes

Bridges investment insights → client conversations

Core Role: Translate investment conviction → personalized client communication

1.2 Key Users
User	Role
RM (Primary)	Uses system daily for client interactions
Team Leads	Monitor RM performance
Compliance	Audit communication + actions
Product/Admin	Configure rules, templates
1.3 Core Value Proposition

Reduce RM thinking load → “What should I say today?”

Increase conversion & retention

Standardize communication quality

Create audit/compliance trail

2. 🎯 Product Goals
2.1 Primary Goals

Daily RM Guidance

Clear actionable suggestions per client

Personalized Communication

Based on portfolio, behavior, risk profile

Closed-loop Feedback

Learn from RM calls & outcomes

Compliance-safe system

No raw transcripts exposed

2.2 Success Metrics
Metric	Target
RM Daily Active Usage	>80%
Suggestion Adoption Rate	>60%
Client Engagement Rate	+25%
Compliance Violations	0 critical
Time spent per RM per day	↓ 30%
3. 🧩 Feature Breakdown
3.1 Daily RM Dashboard (Core)
Features

Today’s priority list:

High-risk clients

Rebalance alerts

Opportunity-based outreach

Suggested actions:

Call / WhatsApp / Email

Client segmentation:

HNI / Retail / Dormant / At-risk

Output Example
Client: Rajesh Kumar
Priority: HIGH
Reason: Portfolio drawdown + missed rebalance
Suggested Action: Call
Message Hook: "Markets volatile, let’s rebalance to protect downside"
3.2 “What To Say Today” Engine
Inputs

Portfolio data

Diligence Terminal outputs (model portfolios)

RM call history

Client risk profile

Outputs

Suggested talking points

Objection handling hints

Personalization cues

Constraints

No hallucinations

Must be grounded in approved models only

3.3 Client Profile Engine
Data Stored

Risk profile

Portfolio composition

Past interactions

Behavioral signals:

Response latency

Trade frequency

Panic selling tendency

Derived Features

Risk sensitivity score

Engagement score

Churn probability

3.4 Action Logging & Compliance
Actions tracked:

Calls

Messages sent

Recommendations made

Compliance rules:

Only approved portfolios allowed

No raw transcript exposure

Audit logs immutable

3.5 Client Communication Generator
Channels:

WhatsApp

Email

Call scripts

Features:

Pre-approved templates

AI-generated but constrained outputs

Tone control:

Conservative / Neutral / Aggressive

3.6 Feedback Loop System
Inputs:

RM call recordings (processed)

Client responses

Action outcomes

Outputs:

Improved messaging suggestions

RM performance insights

4. 🧠 System Architecture
4.1 High-Level Architecture
                ┌────────────────────┐
                │  Diligence Terminal│
                └─────────┬──────────┘
                          │ (read-only)
                          ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Client Data  │ → │ WealthOS Core│ → │ RM Dashboard │
└──────────────┘   └──────┬───────┘   └──────────────┘
                          │
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
 Suggestion Engine   Communication AI   Compliance Engine
4.2 Core Services
Service	Responsibility
Client Service	Client data + features
Suggestion Engine	Generate daily actions
Messaging Engine	Generate communication
Compliance Service	Rule enforcement
Analytics Service	RM + client insights
5. ⚙️ Backend Design
5.1 Tech Stack (Recommended)

Backend: Node.js (NestJS preferred)

DB: PostgreSQL (+ JSONB)

Cache: Redis

Queue: BullMQ / Temporal (if scaling)

LLM Layer: OpenAI / Claude (via abstraction layer)

Storage: S3 (call recordings, logs)

5.2 Key Tables
Clients
id
name
risk_profile
engagement_score
churn_probability
metadata (JSONB)
Portfolios
client_id
holdings (JSONB)
last_rebalance_date
risk_score
Interactions
id
client_id
type (call/email/whatsapp)
summary
timestamp
Suggestions
id
client_id
priority
reason
suggested_action
message
status (used/ignored)
5.3 APIs
Dashboard
GET /dashboard/today
GET /clients/:id/profile
Suggestions
POST /suggestions/generate
GET /suggestions/:clientId
Actions
POST /actions/log
6. 🤖 AI / LLM Layer
6.1 Design Principles

No direct free-form generation

Retrieval + constrained generation

Always grounded in:

Portfolio data

Approved models

6.2 Prompt Structure
INPUT:
- Client profile
- Portfolio summary
- Market context (from DT)
- Past interactions

TASK:
Generate:
1. Suggested action
2. Talking points
3. Message draft

CONSTRAINTS:
- No hallucination
- No new investment ideas outside approved models
- Professional tone
6.3 Pipelines
Suggestion Pipeline
Trigger → Feature extraction → Scoring → LLM generation → Validation → Output
7. 📊 Scoring Systems
7.1 Client Priority Score

Factors:

Portfolio drawdown

Time since last contact

Risk mismatch

Market events

7.2 Engagement Score

Response rate

Call frequency

Action conversion

7.3 RM Performance Score

Suggestion usage %

Conversion rate

Client retention

8. 🔐 Compliance & Safety
Rules

Only approved portfolios can be referenced

No raw transcript exposure

All outputs logged

All suggestions explainable

Audit Logs

Who said what

When

Based on which model

9. 🖥️ Frontend (Dashboard UX)
Sections
1. Today View

Priority clients

Suggested actions

2. Client Detail

Portfolio

Risk profile

Interaction history

Suggested scripts

3. Analytics

RM performance

Client segmentation

10. 🚀 Rollout Plan
Phase 1 (MVP)

Dashboard

Basic suggestions

Action logging

Phase 2

AI messaging

Feedback loop

Client scoring

Phase 3

Full personalization

Deep integrations

Compliance automation

11. ⚠️ Risks & Mitigations
Risk	Mitigation
Hallucinated advice	Strict grounding
RM ignoring system	UX simplicity
Data quality issues	Validation pipelines
Compliance breach	Rule engine + audit logs
12. 🧱 Future Enhancements

Voice call real-time assistance

Auto-call summaries

Predictive churn alerts

RM copilot mode

🧠 Final Summary

WealthOS is essentially:

“A decision + communication layer on top of investment intelligence”

Diligence Terminal → decides what to believe

WealthOS → decides what to say



🗄️ 1. DATABASE SCHEMA (Postgres)

Designed for:

High read throughput (RM dashboards)

Flexibility (JSONB where needed)

Auditability (compliance-first)

🧩 Core Tables
1. clients
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  segment TEXT, -- HNI / Retail / etc
  risk_profile TEXT, -- conservative/moderate/aggressive
  engagement_score FLOAT DEFAULT 0,
  churn_probability FLOAT DEFAULT 0,
  last_contact_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);
2. portfolios
CREATE TABLE portfolios (
  id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  total_value NUMERIC,
  risk_score FLOAT,
  last_rebalance_date TIMESTAMP,
  holdings JSONB, -- [{symbol, weight, qty}]
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
3. interactions
CREATE TABLE interactions (
  id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  rm_id UUID,
  type TEXT, -- call / email / whatsapp
  summary TEXT,
  sentiment TEXT, -- positive/neutral/negative
  timestamp TIMESTAMP,
  metadata JSONB
);
4. suggestions
CREATE TABLE suggestions (
  id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  priority TEXT, -- HIGH/MEDIUM/LOW
  reason TEXT,
  suggested_action TEXT, -- call/email/etc
  message TEXT,
  status TEXT DEFAULT 'pending', -- used/ignored
  score FLOAT,
  created_at TIMESTAMP DEFAULT NOW()
);
5. actions
CREATE TABLE actions (
  id UUID PRIMARY KEY,
  suggestion_id UUID REFERENCES suggestions(id),
  client_id UUID REFERENCES clients(id),
  rm_id UUID,
  action_type TEXT,
  content TEXT,
  outcome TEXT, -- success/failure/no-response
  created_at TIMESTAMP DEFAULT NOW()
);
6. rm_users
CREATE TABLE rm_users (
  id UUID PRIMARY KEY,
  name TEXT,
  team TEXT,
  performance_score FLOAT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
7. approved_models (CRITICAL for guardrails)
CREATE TABLE approved_models (
  id UUID PRIMARY KEY,
  name TEXT,
  description TEXT,
  model_type TEXT, -- portfolio / strategy
  data JSONB, -- structured model data
  created_at TIMESTAMP DEFAULT NOW()
);
8. client_model_mapping
CREATE TABLE client_model_mapping (
  id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  model_id UUID REFERENCES approved_models(id),
  assigned_at TIMESTAMP DEFAULT NOW()
);
9. audit_logs (IMMUTABLE)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  entity_type TEXT,
  entity_id UUID,
  action TEXT,
  performed_by UUID,
  timestamp TIMESTAMP DEFAULT NOW(),
  payload JSONB
);
10. feature_store (derived signals)
CREATE TABLE feature_store (
  id UUID PRIMARY KEY,
  client_id UUID,
  feature_name TEXT,
  value FLOAT,
  updated_at TIMESTAMP DEFAULT NOW()
);
🔗 2. ER DIAGRAM (Textual)
RM_USERS (1) ────────< INTERACTIONS >──────── (1) CLIENTS
                         │
                         ▼
                     SUGGESTIONS
                         │
                         ▼
                      ACTIONS

CLIENTS (1) ────────< PORTFOLIOS

CLIENTS (1) ────────< CLIENT_MODEL_MAPPING >────── (1) APPROVED_MODELS

CLIENTS (1) ────────< FEATURE_STORE

ALL ENTITIES ────────> AUDIT_LOGS
Key Relationships

Client → Portfolio: 1:N

Client → Suggestions: 1:N

Suggestion → Actions: 1:N

Client → Approved Models: Many-to-many

Everything → Audit Logs: append-only

⚙️ 3. LLM PROMPT TEMPLATES

These are production-ready and aligned with your system.

🧠 3.1 Suggestion Generation Prompt
SYSTEM:
You are a financial assistant helping Relationship Managers communicate with clients.
You MUST follow all constraints strictly.

INPUT:
Client Profile:
- Risk: {{risk_profile}}
- Engagement Score: {{engagement_score}}
- Churn Probability: {{churn_probability}}

Portfolio Summary:
{{portfolio_summary}}

Recent Interactions:
{{interaction_summary}}

Approved Models:
{{approved_models}}

Market Context (from Diligence Terminal):
{{market_context}}

TASK:
Generate:
1. Priority (HIGH/MEDIUM/LOW)
2. Reason for outreach
3. Suggested Action (call/email/whatsapp)
4. Talking Points (3-5 bullets)
5. Message Draft (max 80 words)

CONSTRAINTS:
- Only refer to approved models
- No new investment ideas
- No hallucinated data
- Be conservative and professional
- Keep message human and simple
🗣️ 3.2 Message Personalization Prompt
SYSTEM:
You generate client-ready financial communication.

INPUT:
Client Name: {{name}}
Risk Profile: {{risk_profile}}
Context: {{suggestion_reason}}
Talking Points: {{talking_points}}

TASK:
Generate a message for {{channel}}:
- Tone: {{tone}} (conservative/neutral/aggressive)
- Max 80 words
- Clear and actionable

CONSTRAINTS:
- No jargon
- No promises of returns
- No speculative statements
- Must align with provided talking points
📊 3.3 Interaction Summary Prompt
SYSTEM:
You summarize RM-client conversations.

INPUT:
Transcript: {{transcript}}

TASK:
Extract:
- Summary (max 100 words)
- Sentiment (positive/neutral/negative)
- Key concerns
- Action items

CONSTRAINTS:
- Do not include raw transcript text
- No assumptions beyond transcript
🚨 4. LLM GUARDRAILS (CRITICAL)
🔒 4.1 Hard Constraints (Must enforce in code)
✅ Retrieval grounding

Every prompt must include:

Approved models

Portfolio data

→ NEVER allow free-form generation

✅ Output validation layer

After LLM response:

Reject if:

Mentions unknown stocks

Mentions “new opportunities”

Contains numbers not in input

✅ Schema validation

Use strict JSON output format:

{
  "priority": "HIGH",
  "reason": "...",
  "action": "call",
  "talking_points": ["...", "..."],
  "message": "..."
}
🧱 4.2 System Guardrails
1. Approved Universe Filter

Before LLM:

allowedStocks = portfolio + approved_models

After LLM:

if (response mentions stock NOT in allowedStocks) reject
2. No Hallucination Rule

Force LLM to cite:

“Based on your current portfolio…”

“As per your existing allocation…”

3. Risk Alignment Rule

Aggressive suggestions ONLY if:

risk_profile == aggressive

4. Compliance Layer

Block phrases:

“guaranteed returns”

“sure profit”

“insider”

“confidential tip”

🧪 4.3 Scoring + Ranking Layer (Pre-LLM)

Don’t rely on LLM for priority.

Instead:

priorityScore =
  0.3 * drawdown +
  0.2 * daysSinceLastContact +
  0.2 * churnProbability +
  0.3 * riskMismatch

LLM only converts → language

🧠 5. Recommended Architecture Pattern
🔥 Golden Rule

LLM = formatter, NOT decision maker

Pipeline
Feature Store → Scoring Engine → Suggestion Object
                      ↓
                 LLM Layer (formatting)
                      ↓
              Validation Layer (STRICT)
                      ↓
                   Output Layer