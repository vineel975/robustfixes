import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { getModel } from "@/src/model-provider";

export async function POST(request: NextRequest) {
  try {
    const { diagnosis } = (await request.json()) as { diagnosis: string };

    if (!diagnosis?.trim()) {
      return NextResponse.json({ claimType: "other" });
    }

    const { text } = await generateText({
      model: getModel({ provider: "openrouter", modelName: "anthropic/claude-sonnet-4-5" }),
      prompt: `You are a medical claim classifier. Based on the diagnosis text below, classify into exactly one type.

CATARACT — classify as "cataract" if the diagnosis contains ANY of these or related terms:
  - Cataract (any type: nuclear, cortical, subcapsular, immature, mature, hypermature, senile, traumatic, congenital)
  - Phacoemulsification / Phaco / SICS / ECCE / ICCE
  - IOL / Intraocular Lens / Lens implant / Foldable lens / Monofocal / Multifocal / Toric lens
  - Pseudophakia / Aphakia
  - Diminution of vision / Blurred vision (when associated with lens/cataract)
  - Any eye surgery involving the lens

MATERNITY — classify as "maternity" if the diagnosis contains ANY of these or related terms:
  - Pregnancy (any trimester: first, second, third / antenatal / prenatal / postnatal / postpartum)
  - Delivery (normal / vaginal / spontaneous / assisted)
  - LSCS / Caesarean / C-section / Cesarean
  - Labour / Labor / Childbirth / Parturition
  - Obstetric / Obstetrical complications
  - Antepartum / Intrapartum / Postpartum
  - Gravida / Para / GPLA notation (e.g. G2P1L1A0)
  - Preeclampsia / Eclampsia / Gestational hypertension
  - Gestational diabetes / GDM
  - Placenta previa / Placental abruption / Ectopic pregnancy
  - Foetal / Fetal distress / Preterm labour
  - Miscarriage / Abortion / MTP (Medical Termination of Pregnancy)
  - Puerperal / Puerperium
  - Newborn care / Well baby care / Neonatal

OTHER — classify as "other" if it does not clearly match cataract or maternity.

Diagnosis: "${diagnosis}"

Reply with ONLY one word: cataract, maternity, or other.`,
    });

    const claimType = text.trim().toLowerCase();
    const valid = ["cataract", "maternity", "other"];
    return NextResponse.json({
      claimType: valid.includes(claimType) ? claimType : "other",
      diagnosis,
    });
  } catch (e) {
    console.error("[classify-claim-type] error:", e);
    return NextResponse.json({ claimType: "other" });
  }
}
