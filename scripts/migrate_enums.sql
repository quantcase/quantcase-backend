-- Create enum types (idempotent)
DO $$ BEGIN CREATE TYPE "DenominationType" AS ENUM ('rupee', 'percentage', 'ratio', 'other'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "KpiSource" AS ENUM ('transcript', 'QE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "KpiTypeCategory" AS ENUM ('assets', 'liabilities', 'equity', 'revenue', 'cogs', 'operating_expenses', 'profit_lines', 'cashflow', 'customer_kpis', 'industry_specific'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "WealthClientSegment" AS ENUM ('HNI', 'UHNI', 'Retail', 'Institutional', 'Private'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "WealthRiskProfile" AS ENUM ('conservative', 'moderate', 'aggressive'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "WealthInteractionType" AS ENUM ('call', 'email', 'whatsapp', 'meeting', 'sms'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "WealthSuggestionPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "WealthSuggestionStatus" AS ENUM ('pending', 'used', 'ignored'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "WealthModelType" AS ENUM ('equity', 'debt', 'hybrid', 'structured', 'pms', 'aif'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "PluginCategory" AS ENUM ('management', 'deal', 'opportunity', 'wealthos', 'technicals', 'private_equity', 'fundamentals'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "SignalSourceType" AS ENUM ('transcript', 'qe', 'management', 'ofactor', 'prowess'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- extracted_signals.source_type: String → SignalSourceType
ALTER TABLE extracted_signals ALTER COLUMN source_type TYPE "SignalSourceType" USING source_type::text::"SignalSourceType";

-- kpi_values.source: String → KpiSource
ALTER TABLE kpi_values ALTER COLUMN source TYPE "KpiSource" USING source::text::"KpiSource";

-- kpis: denomination, source, kpi_type
ALTER TABLE kpis ALTER COLUMN denomination TYPE "DenominationType" USING denomination::text::"DenominationType";
ALTER TABLE kpis ALTER COLUMN source TYPE "KpiSource" USING source::text::"KpiSource";
ALTER TABLE kpis ALTER COLUMN kpi_type TYPE "KpiTypeCategory" USING kpi_type::text::"KpiTypeCategory";

-- plugins.category
ALTER TABLE plugins ALTER COLUMN category TYPE "PluginCategory" USING category::text::"PluginCategory";

-- prowess_kpi_values.source
ALTER TABLE prowess_kpi_values ALTER COLUMN source TYPE "KpiSource" USING source::text::"KpiSource";

-- prowess_values_new.source
ALTER TABLE prowess_values_new ALTER COLUMN source TYPE "KpiSource" USING source::text::"KpiSource";

-- wealth_approved_models.model_type
ALTER TABLE wealth_approved_models ALTER COLUMN model_type TYPE "WealthModelType" USING model_type::text::"WealthModelType";

-- wealth_clients
ALTER TABLE wealth_clients ALTER COLUMN segment TYPE "WealthClientSegment" USING segment::text::"WealthClientSegment";
ALTER TABLE wealth_clients ALTER COLUMN risk_profile TYPE "WealthRiskProfile" USING risk_profile::text::"WealthRiskProfile";

-- wealth_interactions.type
ALTER TABLE wealth_interactions ALTER COLUMN type TYPE "WealthInteractionType" USING type::text::"WealthInteractionType";

-- wealth_suggestions: drop defaults, cast, restore defaults
ALTER TABLE wealth_suggestions ALTER COLUMN priority DROP DEFAULT;
ALTER TABLE wealth_suggestions ALTER COLUMN priority TYPE "WealthSuggestionPriority" USING priority::text::"WealthSuggestionPriority";
ALTER TABLE wealth_suggestions ALTER COLUMN priority SET DEFAULT 'MEDIUM'::"WealthSuggestionPriority";

ALTER TABLE wealth_suggestions ALTER COLUMN status DROP DEFAULT;
ALTER TABLE wealth_suggestions ALTER COLUMN status TYPE "WealthSuggestionStatus" USING status::text::"WealthSuggestionStatus";
ALTER TABLE wealth_suggestions ALTER COLUMN status SET DEFAULT 'pending'::"WealthSuggestionStatus";
