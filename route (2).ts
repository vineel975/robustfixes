/**
 * POST /api/audit/start
 *
 * Fire-and-return endpoint used by the Spectra iframe integration.
 * Unlike /api/audit (which polls until completion), this endpoint
 * uploads the file, creates the Convex job, and immediately returns
 * the jobId. The iframe then navigates to /job/[id]?embedded=1 and
 * Convex real-time subscriptions handle the rest.
 *
 * Request: multipart/form-data
 *   claimId        string   required
 *   medicalBill    PDF file required
 *   tariffBill     PDF file optional
 *   policyWordings string   optional
 *
 * Response (success):
 *   { success: true,  jobId: string, claimId: string }
 *
 * Response (error):
 *   { success: false, error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { processSinglePdf } from "@/src/extract";
import { fetchModels } from "@tokenlens/fetch";
import { validateExtractedPatient, getPatientInfoDbByClaimId } from "@/lib/db";

// Allow up to 2 minutes for large PDF uploads to Convex storage
export const maxDuration = 120;


const CONVEX_URL =
  process.env.CONVEX_URL_PUBLIC ??
  process.env.NEXT_PUBLIC_CONVEX_URL;

async function uploadToConvex(
  convex: ConvexHttpClient,
  buffer: ArrayBuffer,
  mimeType: string,
  retries = 3,
): Promise<Id<"_storage">> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Generate a fresh upload URL for each attempt
      const uploadUrl: string = await convex.mutation(
        api.jobMutations.generateUploadUrl,
        {},
      );

      // 2-minute timeout as per Convex docs for large file uploads
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: buffer,
        signal: AbortSignal.timeout(120_000), // 2 minutes
      });

      if (!uploadResponse.ok) {
        throw new Error(
          `Convex storage upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
        );
      }

      const { storageId } = (await uploadResponse.json()) as {
        storageId: Id<"_storage">;
      };
      return storageId;

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[uploadToConvex] Attempt ${attempt}/${retries} failed:`, lastError.message);

      // Don't retry on the last attempt
      if (attempt < retries) {
        // Wait 2s before retrying
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  }

  throw lastError ?? new Error("Upload failed after all retries");
}

export async function POST(request: NextRequest) {
  // ── 1. Parse multipart form data ──────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { success: false, error: "Request must be multipart/form-data." },
      { status: 400 },
    );
  }

  const claimId = (formData.get("claimId") as string | null)?.trim();
  const medicalBill = formData.get("medicalBill") as File | null;
  const tariffBill = formData.get("tariffBill") as File | null;
  const policyWordings =
    (formData.get("policyWordings") as string | null)?.trim() || undefined;

  // Parse spectraFields sent by Spectra as a multipart JSON string
  let spectraFields: Record<string, unknown> | undefined;
  const spectraFieldsRaw = (formData.get("spectraFields") as string | null)?.trim();
  if (spectraFieldsRaw) {
    try { spectraFields = JSON.parse(spectraFieldsRaw); } catch { /* ignore parse errors */ }
  }

  if (!claimId) {
    return NextResponse.json(
      { success: false, error: "claimId is required." },
      { status: 400 },
    );
  }
  if (!medicalBill || medicalBill.size === 0) {
    return NextResponse.json(
      { success: false, error: "medicalBill (PDF) is required." },
      { status: 400 },
    );
  }
  if (medicalBill.type !== "application/pdf") {
    return NextResponse.json(
      { success: false, error: "medicalBill must be a PDF file." },
      { status: 400 },
    );
  }
  if (tariffBill && tariffBill.size > 0 && tariffBill.type !== "application/pdf") {
    return NextResponse.json(
      { success: false, error: "tariffBill must be a PDF file." },
      { status: 400 },
    );
  }

  const convex = new ConvexHttpClient(CONVEX_URL!);

  // ── 2. Read PDF bytes and upload to Convex storage ─────────────────────────
  const hospitalBuffer = Buffer.from(await medicalBill.arrayBuffer());
  const hospitalSizeMb = (hospitalBuffer.byteLength / 1024 / 1024).toFixed(2);
  console.log(`[audit/start] Medical bill size: ${hospitalSizeMb} MB`);

  // Upload to Convex storage so the PDF viewer can render it on the right side
  let hospitalStorageId: Id<"_storage">;
  try {
    hospitalStorageId = await uploadToConvex(convex, hospitalBuffer.buffer.slice(hospitalBuffer.byteOffset, hospitalBuffer.byteOffset + hospitalBuffer.byteLength) as ArrayBuffer, "application/pdf");
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Failed to upload medical bill: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  let tariffStorageId: Id<"_storage"> | undefined;
  if (tariffBill && tariffBill.size > 0) {
    try {
      const tariffBuf = await tariffBill.arrayBuffer();
      tariffStorageId = await uploadToConvex(convex, tariffBuf, "application/pdf");
    } catch (err) {
      console.warn("[audit/start] Tariff upload failed (non-critical):", err);
    }
  }

  // ── 3. Create Convex job with files (for PDF viewer) — NO action scheduled ─
  let jobId: Id<"processJob">;
  try {
    jobId = await convex.mutation(api.jobMutations.createJobAndProcess, {
      claimId,
      hospitalStorageId,
      hospitalFileName: medicalBill.name || "medical-bill.pdf",
      tariffStorageId,
      tariffFileName: tariffBill?.name,
      spectraFields,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Failed to create job: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // ── 4. Process PDF synchronously then return jobId ──────────────────────────
  // Cannot fire-and-forget in Next.js — serverless kills background tasks on response.
  // maxDuration = 120 gives us 2 minutes to process before returning.
  try {
    // Mark job as processing
    await convex.mutation(api.jobMutations.updateJobStatus, {
      jobId,
      status: "processing",
    });

    const modelName = process.env.MODEL_NAME || "google/gemini-3-flash-preview";
    const provider   = process.env.MODEL_PROVIDER || "openrouter";
    const providers  = await fetchModels();
    const claimType  = (spectraFields?.claimType as string) ?? "cataract";

    const { result, totals } = await processSinglePdf({
      fileName: medicalBill.name || "medical-bill.pdf",
      pdfBuffer: hospitalBuffer,
      modelName,
      provider: (provider === "openai" ? "openai" : "openrouter") as "openai" | "openrouter",
      providers,
      claimType: claimType as "cataract" | "maternity" | "other",
    });

    // ── Post-processing: patient validation ────────────────────────────────────
    try {
      const patientValidation = await validateExtractedPatient({
        patientName: result.analysis.patientName?.value,
        patientAge: result.analysis.patientAge?.value,
        patientGender: result.analysis.patientGender?.value,
        policyNumber: result.analysis.policyNumber?.value,
      }, claimId);

      // Build extended validation fields from spectraFields DB values
      // These power the tick/exclamation icons for hospitalName, admissionDate, documentDate
      if (spectraFields && patientValidation) {
        const extendedFields: Array<{
          field: string;
          aiValue: string | null;
          dbValue: string | null;
          isMatch: boolean;
          aiSource: string;
          dbSource: string;
        }> = [];

        const normalizeForCompare = (v: unknown): string =>
          v == null ? "" : String(v).trim().toLowerCase();

        const dateMatch = (ai: string, db: string): boolean => {
          // Normalize both to YYYY-MM-DD for comparison
          const parseDate = (s: string): string => {
            const clean = s.trim();
            const iso = clean.match(/^(\d{4}-\d{2}-\d{2})/);
            if (iso) return iso[1];
            const dmy = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
            if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,"0")}-${dmy[1].padStart(2,"0")}`;
            const dotNet = clean.match(/^\/Date\((\d+)\)\/$/);
            if (dotNet) {
              const d = new Date(parseInt(dotNet[1], 10));
              return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
            }
            return clean;
          };
          return parseDate(ai) === parseDate(db);
        };

        // Patient name
        const aiName = normalizeForCompare(result.analysis.patientName?.value);
        const dbName = normalizeForCompare(spectraFields.patientName);
        if (aiName && dbName) {
          extendedFields.push({
            field: "patientName",
            aiValue: String(result.analysis.patientName?.value ?? ""),
            dbValue: String(spectraFields.patientName ?? ""),
            isMatch: aiName.includes(dbName) || dbName.includes(aiName),
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (Patient Name)",
          });
        }

        // Hospital name
        const aiHospital = normalizeForCompare(result.analysis.hospitalName?.value);
        const dbHospital = normalizeForCompare(spectraFields.hospitalName);
        if (aiHospital && dbHospital) {
          extendedFields.push({
            field: "hospitalName",
            aiValue: String(result.analysis.hospitalName?.value ?? ""),
            dbValue: String(spectraFields.hospitalName ?? ""),
            isMatch: aiHospital.includes(dbHospital) || dbHospital.includes(aiHospital),
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (Provider)",
          });
        }

        // Patient age
        const aiAge = String(result.analysis.patientAge?.value ?? "").trim();
        const dbAge = String(spectraFields.patientAge ?? "").trim();
        if (aiAge && dbAge) {
          extendedFields.push({
            field: "patientAge",
            aiValue: aiAge,
            dbValue: dbAge,
            isMatch: parseFloat(aiAge) === parseFloat(dbAge),
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (Age)",
          });
        }

        // Policy number
        const aiPolicy = normalizeForCompare(result.analysis.policyNumber?.value);
        const dbPolicy = normalizeForCompare(spectraFields.policyNumber);
        if (aiPolicy && dbPolicy) {
          extendedFields.push({
            field: "policyNumber",
            aiValue: String(result.analysis.policyNumber?.value ?? ""),
            dbValue: String(spectraFields.policyNumber ?? ""),
            isMatch: aiPolicy === dbPolicy,
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (UHID/Policy)",
          });
        }

        // Admission date
        const aiDoa = String(result.analysis.admissionDate?.value ?? "").trim();
        const dbDoa = String(spectraFields.admissionDate ?? "").trim();
        if (aiDoa && dbDoa) {
          extendedFields.push({
            field: "admissionDate",
            aiValue: aiDoa,
            dbValue: dbDoa,
            isMatch: dateMatch(aiDoa, dbDoa),
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (DOA)",
          });
        }

        // Discharge date
        const aiDod = String(result.analysis.dischargeDate?.value ?? "").trim();
        const dbDod = String(spectraFields.dischargeDate ?? "").trim();
        if (aiDod && dbDod) {
          extendedFields.push({
            field: "dischargeDate",
            aiValue: aiDod,
            dbValue: dbDod,
            isMatch: dateMatch(aiDod, dbDod),
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (DOD)",
          });
        }

        // Document date
        const aiDate = String(result.analysis.date?.value ?? "").trim();
        const dbDate = String(spectraFields.documentDate ?? "").trim();
        if (aiDate && dbDate) {
          extendedFields.push({
            field: "documentDate",
            aiValue: aiDate,
            dbValue: dbDate,
            isMatch: dateMatch(aiDate, dbDate),
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (Document Date)",
          });
        }

        // Gender
        const aiGender = normalizeForCompare(result.analysis.patientGender?.value);
        const dbGender = normalizeForCompare(spectraFields.patientGender);
        if (aiGender && dbGender) {
          // Spectra DB: hdnGender 1=Female, 2=Male
          const normalizeGender = (g: string) => {
            if (g === "2" || g === "m" || g === "male")   return "male";
            if (g === "1" || g === "f" || g === "female") return "female";
            return g;
          };
          extendedFields.push({
            field: "patientGender",
            aiValue: String(result.analysis.patientGender?.value ?? ""),
            dbValue: String(spectraFields.patientGender ?? ""),
            isMatch: normalizeGender(aiGender) === normalizeGender(dbGender),
            aiSource: "Extracted from PDF",
            dbSource: "Spectra DB (Gender)",
          });
        }

        if (extendedFields.length > 0) {
          // Merge into existing patientValidation.fields
          patientValidation.fields = [
            ...(patientValidation.fields || []),
            ...extendedFields.filter(ef =>
              !patientValidation.fields.some(f => f.field === ef.field)
            ),
          ] as typeof patientValidation.fields;
        }
      }

      result.analysis.patientValidation = patientValidation;
    } catch (e) {
      console.warn("[audit/start] Patient validation failed:", e);
    }

    try {
      const patientInfoDb = await getPatientInfoDbByClaimId(claimId);
      if (patientInfoDb) {
        result.analysis.patientInfoDb = patientInfoDb;
      }
    } catch (e) {
      console.warn("[audit/start] Patient DB info failed:", e);
    }

    // Save result.analysis (not the full result object — UI reads analysis from jobResults)
    await convex.mutation(api.jobMutations.completeJobWithResult, {
      jobId,
      analysis: result.analysis,
      filePath: result.filePath || "",
      usage: result.usage || {},
      processingTimeMs: totals.totalTimeMs || 0,
      cost: totals.totalCost || 0,
      status: "completed",
      successCount: 1,
      errorCount: 0,
      totalCost:                totals.totalCost,
      totalTokens:              totals.totalTokens,
      totalPromptTokens:        totals.totalPromptTokens,
      totalCompletionTokens:    totals.totalCompletionTokens,
    });

    // ── Trigger tariff matching as a lightweight Convex action ─────────────────
    // Tariff needs Convex ctx to read tariff PDFs from storage — can't run in Next.js
    try {
      await convex.action(api.processPdf.runTariffMatching, {
        jobId,
        tariffStorageId,
      });
    } catch (e) {
      console.warn("[audit/start] Tariff matching failed:", e);
    }
  } catch (err) {
    console.error("[audit/start] Processing error:", err);
    await convex.mutation(api.jobMutations.completeJobWithResult, {
      jobId,
      analysis: null,
      status: "error",
      successCount: 0,
      errorCount: 1,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  }

  // Return jobId — UI polls Convex for real-time result updates
  return NextResponse.json(
    { success: true, jobId: jobId as string, claimId },
    { status: 200 },
  );
}

// Handle CORS preflight from Spectra
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
