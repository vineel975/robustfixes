import { NextRequest, NextResponse } from "next/server";
import { benefitSectionSummaryPrompt } from "@/src/prompts";
import { generateText } from "ai";
import { getModel } from "@/src/model-provider";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      section?: "ailment" | "exclusions" | "copay" | "maternity";
      rawText?: string;
      claimType?: string;
    };

    const section   = body?.section;
    const rawText   = (body?.rawText ?? "").trim();
    const claimType = body?.claimType ?? "other";

    if (!section || !rawText) {
      return NextResponse.json({ points: [], summary: `No ${section ?? "section"} information available.` });
    }

    const { text } = await generateText({
      model: getModel({ provider: "openrouter", modelName: "anthropic/claude-sonnet-4-5" }),
      prompt: benefitSectionSummaryPrompt(section, rawText, claimType),
    });

    const trimmed = text.trim();

    // Try to parse as JSON array of bullet points
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        // Filter out empty strings
        const points = parsed.filter((p: unknown) => typeof p === "string" && p.trim().length > 0) as string[];
        return NextResponse.json({ points, summary: points.join(". ") });
      }
    } catch {
      // Not JSON — return as plain text summary
    }

    return NextResponse.json({ points: [], summary: trimmed });
  } catch (e) {
    console.error("[benefit-section-summary] error:", e);
    return NextResponse.json({ points: [], summary: "Summary unavailable." }, { status: 500 });
  }
}
