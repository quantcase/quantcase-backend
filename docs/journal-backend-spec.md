# QuantCase — Investment Journal: Backend Spec

> **Audience:** Backend team  
> **Frontend status:** UI is fully built with static/dummy data. All data must come from the APIs below once implemented.  
> **Base URL:** `https://qc-backend.mach33.club` (existing backend)  
> **Auth:** All endpoints require authenticated user session (existing auth mechanism).

---

## 1. Product Overview

The Investment Journal lets users attach a written investment thesis to each holding in their portfolio. Once a thesis exists, QuantCase monitors it automatically: as MOD scores change quarter-over-quarter, the system evaluates whether the thesis still holds and surfaces an "AI nudge" when data contradicts the stated reasoning.

**Three surfaces depend on this backend:**

| Surface | Component | What it needs |
|---|---|---|
| Portfolio → Journal tab | `tab-journal.tsx` | All holdings with thesis health + AI nudge |
| Dashboard modal | `complete-journal-modal.tsx` | Holdings without a thesis, with AI context per MOD dimension |
| Dashboard banner | Progress banner | Count of holdings with/without theses |

---

## 2. Core Data Model

### 2.1 `JournalEntry` (per holding)

```typescript
interface JournalEntry {
  holdingId:   string;          // e.g. "HDFCBANK" (stock symbol or internal ID)
  userId:      string;
  dimension:   "M" | "O" | "D"; // Primary MOD dimension that drove the buy decision
  subFactors:  string[];         // Selected sub-factors (see §5 for valid values)
  thesis:      string;           // Free text, max 300 chars
  conviction:  1 | 2 | 3 | 4 | 5;
  createdAt:   string;           // ISO 8601
  updatedAt:   string;
}
```

### 2.2 `ThesisHealth` (computed by backend, refreshed after each MOD score update)

```typescript
type ThesisHealth = "intact" | "partial" | "broken" | "none";

interface ThesisHealthResult {
  holdingId:     string;
  thesisHealth:  ThesisHealth;
  aiNudge?:      string;   // Present only when thesisHealth is "partial" or "broken"
  evaluatedAt:   string;
}
```

**How `thesisHealth` should be computed:**

| State | Trigger condition |
|---|---|
| `none` | No `JournalEntry` exists for this holding |
| `intact` | Entry exists; MOD score and sub-scores for the chosen dimension are stable or improving |
| `partial` | Entry exists; one or more sub-scores contradict the thesis (e.g. distribution moat claimed, but distribution sub-score dropped >8pts) |
| `broken` | Entry exists; core thesis assumption is materially contradicted by data (e.g. guidance accuracy < 50 when "Guidance Accuracy" was a selected sub-factor) |

**`aiNudge` content:** Should reference the specific sub-score that changed and quote the user's thesis language where possible. 1–3 sentences.

### 2.3 `StockContext` (needed by the journal modal — AI context per MOD dimension)

```typescript
interface StockContext {
  symbol:   string;
  aiContext: {
    M: string;  // 2-3 sentence AI-generated management context
    O: string;  // 2-3 sentence opportunity context
    D: string;  // 2-3 sentence deal/valuation context
  };
  signals: {
    label: string;
    type:  "green" | "amber" | "red" | "neutral";
  }[];
  prompts: string[];  // 3 suggested thesis starter phrases
}
```

---

## 3. API Endpoints

### 3.1 List holdings needing a journal entry (modal entrypoint)

```
GET /api/journal/pending
```

Returns holdings in the user's portfolio that have `thesisHealth === "none"` (no thesis yet). Used to populate the Complete Journal modal.

**Response:**
```json
{
  "success": true,
  "data": {
    "holdings": [
      {
        "symbol":    "RELIANCE",
        "name":      "Reliance Industries",
        "sector":    "Energy",
        "capType":   "Large",
        "price":     2891.00,
        "priceChange": 16.5,
        "priceChangeDir": "pos",
        "mod": { "M": 74, "O": 80, "D": 72 },
        "aiContext": {
          "M": "Management has delivered on Jio KPIs for 6 consecutive quarters...",
          "O": "Jio has 35%+ market share and the retail expansion story is real...",
          "D": "At 1.4× P/B and 22× P/E — not cheap, but not stretched..."
        },
        "signals": [
          { "label": "Jio subscriber growth steady", "type": "green" },
          { "label": "Petchem margins under pressure", "type": "amber" }
        ],
        "subFactors": {
          "M": ["Guidance Accuracy", "Capital Allocation", "Disclosure Honesty"],
          "O": ["Industry Tailwind", "Distribution Strength", "Competitive Edge", "TAM Expansion"],
          "D": ["Valuation", "Earnings Growth/Quality", "P/E Re-rating Potential", "Risk-Reward"]
        },
        "prompts": [
          "Buying for Jio value unlock...",
          "Retail expansion undervalued by market...",
          "Conglomerate discount will narrow..."
        ]
      }
    ],
    "totalHoldings": 12,
    "withThesis": 8,
    "pending": 4
  }
}
```

---

### 3.2 Save a journal entry

```
POST /api/journal/entries
```

Called when the user clicks "Save & next →" in the modal.

**Request body:**
```json
{
  "symbol":     "RELIANCE",
  "dimension":  "O",
  "subFactors": ["Industry Tailwind", "Competitive Edge"],
  "thesis":     "Buying for Jio value unlock — the sum-of-parts hasn't been recognised by the market yet.",
  "conviction": 4
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "entryId":      "jrn_abc123",
    "holdingId":    "RELIANCE",
    "thesisHealth": "intact",
    "aiNudge":      null,
    "createdAt":    "2026-06-26T10:30:00Z"
  }
}
```

---

### 3.3 Get all journal entries (Journal tab)

```
GET /api/journal/entries
```

Returns all holdings for the user's portfolio with thesis data and health status. Used to render the full Journal tab.

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "intact":    4,
      "partial":   2,
      "broken":    2,
      "none":      4,
      "total":     12
    },
    "entries": [
      {
        "symbol":        "HDFCBANK",
        "name":          "HDFC Bank",
        "sector":        "Private Banks",
        "capType":       "Large",
        "modScore":      82,
        "modRating":     "STRONG",
        "trendDir":      "up",
        "pnl":           4145,
        "pnlPct":        12.2,
        "thesisHealth":  "intact",
        "alert":         null,
        "subScores": [
          { "label": "Guidance Accuracy", "pillar": "mgmt", "score": 88 },
          { "label": "Capital Allocation", "pillar": "mgmt", "score": 84 },
          { "label": "Industry Tailwind",  "pillar": "opp",  "score": 81 },
          { "label": "Valuation (Deal)",   "pillar": "deal", "score": 68 }
        ],
        "journal": {
          "entryId":     "jrn_abc123",
          "dimension":   "M",
          "subFactors":  ["Guidance Accuracy", "Capital Allocation"],
          "thesis":      "Buying for deposit franchise recovery and ROA expansion...",
          "conviction":  4,
          "aiNudge":     null,
          "updatedAt":   "2026-06-20T08:00:00Z"
        }
      },
      {
        "symbol":       "ASIANPAINT",
        "thesisHealth": "broken",
        "alert":        "Score downgraded 62→54 · guidance cut · thesis flagged Broken",
        "journal": {
          "thesis":    "Premium consumer brand with pricing power...",
          "conviction": 2,
          "aiNudge":   "Tier-2 demand has been weak for 3 consecutive quarters. Management guided margin recovery in Q2 FY24 — it never materialized. Your 'pricing power' thesis is now contradicted by a guidance accuracy score of 42. Consider whether the original thesis still holds."
        }
      },
      {
        "symbol":       "RELIANCE",
        "thesisHealth": "none",
        "journal":      null
      }
    ]
  }
}
```

---

### 3.4 Update an existing journal entry

```
PUT /api/journal/entries/:entryId
```

Called when the user clicks "Revise" on a journal card.

**Request body:** Same as POST (§3.2), all fields optional (partial update).

**Response:** Same shape as POST response.

---

### 3.5 Get a single journal entry

```
GET /api/journal/entries/:symbol
```

Returns the journal entry for a specific holding. Used when opening the "Open →" detail view.

**Response:** Single entry object from the `entries` array in §3.3.

---

### 3.6 Delete a journal entry

```
DELETE /api/journal/entries/:entryId
```

**Response:**
```json
{ "success": true, "data": { "deleted": true } }
```

---

### 3.7 Re-evaluate thesis health (manual trigger)

```
POST /api/journal/entries/:entryId/evaluate
```

Triggers an immediate re-evaluation of thesis health against latest MOD scores. The backend should also run this automatically after each MOD score update (see §4).

**Response:**
```json
{
  "success": true,
  "data": {
    "entryId":      "jrn_abc123",
    "thesisHealth": "partial",
    "aiNudge":      "Distribution moat thesis still holds — Distribution Strength scores 82. However, margin compression in Q4 is partially contradicting the rural recovery story.",
    "evaluatedAt":  "2026-06-26T10:30:00Z"
  }
}
```

---

## 4. Background Processing (Thesis Health Engine)

### 4.1 Trigger

Re-evaluate thesis health for all entries for a given holding whenever:
- A new earnings call is processed for that stock
- MOD scores are updated for that holding
- Sub-scores change by more than 5 points in any pillar

### 4.2 Evaluation Logic

For each `JournalEntry`:

1. Fetch the current sub-scores for the holding
2. Find the sub-scores that match the user's `subFactors` array
3. Compare current scores to scores at the time the entry was created (`createdAt`)
4. Apply this decision table:

```
IF no sub-factor score has dropped > 5pts AND overall MOD score is stable/up
  → thesisHealth = "intact", aiNudge = null

IF any selected sub-factor has dropped 5–15pts
  → thesisHealth = "partial", generate aiNudge

IF any selected sub-factor has dropped > 15pts
OR overall MOD score is below 55 AND user's dimension score is the weakest pillar
  → thesisHealth = "broken", generate aiNudge
```

### 4.3 AI Nudge Generation

The nudge should:
- Name the specific sub-score that changed (e.g. "Guidance Accuracy score has dropped to 42")
- Reference the user's original thesis language if it directly contradicts the data
- End with a concrete action prompt ("Consider whether...", "Set a 6-month review trigger")
- Be 2–3 sentences, no longer

Use the existing Claude integration (or LLM) with a prompt like:

```
User's thesis: "{thesis}"
Selected dimension: {dimension} ({subFactors joined})
Changed sub-score: {label} dropped from {prev} to {current}
Current MOD: M={M} O={O} D={D}

Write a 2-3 sentence AI nudge that explains the contradiction, references the user's thesis, and gives a concrete action. Be direct, not dramatic.
```

---

## 5. Reference Data

### Sub-factors (fixed list, same across all stocks)

**Management (M)**
- Guidance Accuracy
- Capital Allocation
- Disclosure Honesty

**Opportunity (O)**
- Industry Tailwind
- Distribution Strength
- Competitive Edge
- TAM Expansion

**Deal (D)**
- Valuation
- Earnings Growth/Quality
- P/E Re-rating Potential
- Risk-Reward

### Conviction levels

| Value | Label | Description |
|---|---|---|
| 1 | Watching | Not yet decided |
| 2 | Interested | Early signals positive |
| 3 | Moderate | Core thesis in place |
| 4 | High | Strong conviction |
| 5 | Highest | Maximum conviction |

### MOD rating thresholds

| Score | Rating |
|---|---|
| ≥ 80 | STRONG |
| 60–79 | FAIR |
| < 60 | STRETCHED |

### Pillar → sub-score mapping

Sub-scores are labeled by pillar in the response:
- `mgmt` → Management pillar
- `opp` → Opportunity pillar
- `deal` → Deal pillar

---

## 6. Frontend Integration Points

### What the frontend will call and when

| User action | API call |
|---|---|
| Opens "Complete journal" modal | `GET /api/journal/pending` |
| Saves a thesis in the modal | `POST /api/journal/entries` |
| Skips a holding in the modal | No API call needed (UI-only skip) |
| Opens Portfolio → Journal tab | `GET /api/journal/entries` |
| Clicks "Revise" on a card | `PUT /api/journal/entries/:entryId` |
| Clicks "Export journal PDF" | Out of scope for this spec |
| Clicks "+ Add thesis" on no-thesis row | Opens modal → same as above |

### Progress banner (dashboard)

The dashboard shows: `"6 of 12 holdings have thesis entries"`.

The frontend will derive this from the `summary` object in `GET /api/journal/entries`:
```json
{ "intact": 4, "partial": 2, "broken": 2, "none": 4, "total": 12 }
```
`withThesis = intact + partial + broken = 8`, `total = 12`.

---

## 7. Error Handling

All errors should follow the existing backend pattern:

```json
{
  "success": false,
  "error": {
    "code":    "ENTRY_NOT_FOUND",
    "message": "No journal entry found for this holding"
  }
}
```

| Code | HTTP Status | When |
|---|---|---|
| `ENTRY_NOT_FOUND` | 404 | Entry ID doesn't exist or doesn't belong to this user |
| `HOLDING_NOT_FOUND` | 404 | Symbol not in user's portfolio |
| `THESIS_TOO_LONG` | 400 | `thesis` exceeds 300 characters |
| `INVALID_CONVICTION` | 400 | `conviction` is not 1–5 |
| `INVALID_DIMENSION` | 400 | `dimension` is not "M", "O", or "D" |
| `INVALID_SUB_FACTOR` | 400 | Any value in `subFactors` is not in the fixed list (§5) |

---

## 8. Out of Scope (for this phase)

- Export to PDF
- Sharing journal entries with other users
- Filtering by thesis health (filter chip exists in UI but is not yet wired)
- Historical thesis versioning (track changes to a thesis over time)
- Journal for mutual funds (only equity holdings for now)
