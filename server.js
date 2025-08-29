// server.js  — BadRobot worker (regeneration-only, with strong error handling)

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";        // used only for simple conversions / sanity
import { Buffer } from "node:buffer";

// If you’re calling Nano Banana (Gemini) from here, import your client:
// import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// ---------- basic middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Use in-memory uploads; Cloud Run ephemeral FS is fine if you later switch.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB per file, adjust as needed
    files: 40,                  // masks can push this up
  }
});

// ---------- helpers ----------
const okTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp" // keep if you chose to allow webp; remove otherwise
]);

function ensureFiles(req, fields) {
  for (const f of fields) {
    if (!req.files || !req.files[f] || req.files[f].length === 0) {
      throw badRequest(`Missing file: ${f}`);
    }
  }
}

function badRequest(detail) {
  const e = new Error(detail);
  e.status = 400;
  return e;
}

function unsupported(detail) {
  const e = new Error(detail);
  e.status = 415;
  return e;
}

async function toPNG(buffer) {
  // Convert any allowed mime to PNG to keep a single pipeline downstream.
  return sharp(buffer).png().toBuffer();
}

function listMasks(req, prefix) {
  // Accept source_mask_0, source_mask_1, ... (sparse accepted)
  const entries = Object.entries(req.files || {}).filter(([name]) =>
    name.startsWith(prefix)
  );
  // sort by numeric suffix to keep pairing consistent
  entries.sort((a, b) => {
    const ai = parseInt(a[0].split("_").pop() || "0", 10);
    const bi = parseInt(b[0].split("_").pop() || "0", 10);
    return ai - bi;
  });
  return entries.map(([, arr]) => arr[0]);
}

// ---------- status routes (fixes “Cannot GET /”) ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("BadRobot worker is running. POST /process to use.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---------- main processing route ----------
app.post(
  "/process",
  upload.fields([
    { name: "source_image", maxCount: 1 },
    { name: "reference_image", maxCount: 1 },
    // Any number of masks named source_mask_#, reference_mask_#
    // Multer will accept dynamic field names because of memoryStorage
  ]),
  async (req, res, next) => {
    try {
      // 1) Validate presence
      ensureFiles(req, ["source_image", "reference_image"]);

      const sourceFile = req.files["source_image"][0];
      const refFile = req.files["reference_image"][0];

      // 2) Validate mime types
      if (!okTypes.has(sourceFile.mimetype)) {
        throw unsupported(
          `Unsupported file type for source_image: ${sourceFile.mimetype}`
        );
      }
      if (!okTypes.has(refFile.mimetype)) {
        throw unsupported(
          `Unsupported file type for reference_image: ${refFile.mimetype}`
        );
      }

      // 3) Collect mask pairs (A=distorted, B=reference)
      const sourceMasks = listMasks(req, "source_mask_");
      const refMasks = listMasks(req, "reference_mask_");

      if (sourceMasks.length === 0 || refMasks.length === 0) {
        throw badRequest(
          "No masks found. Please paint at least one source_mask_# and reference_mask_#."
        );
      }
      if (sourceMasks.length !== refMasks.length) {
        throw badRequest(
          `Mask count mismatch. source=${sourceMasks.length} reference=${refMasks.length}`
        );
      }

      // 4) Normalize to PNG buffers for a single downstream pipeline
      const sourcePNG = await toPNG(sourceFile.buffer);
      const refPNG = await toPNG(refFile.buffer);

      const pairs = [];
      for (let i = 0; i < sourceMasks.length; i++) {
        const sMask = sourceMasks[i];
        const rMask = refMasks[i];

        if (!okTypes.has(sMask.mimetype)) {
          throw unsupported(`source_mask_${i} type: ${sMask.mimetype}`);
        }
        if (!okTypes.has(rMask.mimetype)) {
          throw unsupported(`reference_mask_${i} type: ${rMask.mimetype}`);
        }

        const sMaskPNG = await toPNG(sMask.buffer);
        const rMaskPNG = await toPNG(rMask.buffer);

        pairs.push({
          index: i,
          sourceMaskPNG: sMaskPNG,
          referenceMaskPNG: rMaskPNG,
        });
      }

      // Optional knobs from the UI
      const mode = (req.body.mode || "auto").toLowerCase(); // auto|style
      const returnFormat = (req.body.return_format || "png").toLowerCase(); // png|jpeg
      const quality = Math.min(
        100,
        Math.max(40, parseInt(req.body.quality || "92", 10))
      );

      console.log("[worker] request summary", {
        sourceSize: sourcePNG.length,
        refSize: refPNG.length,
        pairs: pairs.length,
        mode,
        returnFormat,
        quality
      });

      // 5) Call your Nano Banana / Gemini regeneration here
      // ----------------------------------------------------------------
      // Replace the stub below with your real call that:
      //   - reads sourcePNG + refPNG + mask pairs
      //   - regenerates the masked regions from reference
      //   - returns a final image Buffer (PNG or JPEG)
      //
      // Example placeholder that simply passes the original source through:
      const finalBuffer = await regeneratePatchWithGemini({
        sourcePNG,
        refPNG,
        pairs,
        mode,
      });
      // ----------------------------------------------------------------

      // 6) Encode to desired output format
      let out = finalBuffer;
      if (returnFormat === "jpeg" || returnFormat === "jpg") {
        out = await sharp(finalBuffer).jpeg({ quality }).toBuffer();
        res.type("image/jpeg");
      } else {
        // default PNG
        out = await sharp(finalBuffer).png().toBuffer();
        res.type("image/png");
      }

      return res.send(out);
    } catch (err) {
      next(err);
    }
  }
);

// ---------- global error handler (turns 502 into readable JSON) ----------
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const payload = {
    error: status === 400 ? "Bad Request" :
           status === 415 ? "Unsupported Media Type" :
           "Processing failed",
    detail: err.message || "Unknown worker error",
  };
  console.error("[worker:error]", status, payload.detail);
  res.status(status).json(payload);
});

// ---------- start server ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[worker] listening on ${PORT}`);
});

// ==================
// IMPLEMENTATION STUB
// ==================
/**
 * Replace this with your real Nano Banana (Gemini) call.
 * It should return a Buffer of the **full corrected image**.
 * The UI paints linked masks; you’ll receive them as PNG buffers in `pairs`.
 */
async function regeneratePatchWithGemini({ sourcePNG, refPNG, pairs, mode }) {
  // TODO: call your gemini-2.5 image model with:
  // - sourcePNG as the base image to edit
  // - for each mask pair: use referencePatch and guide the model to regenerate the area
  // - keep crop and resolution exactly the same
  //
  // IMPORTANT: If your current Gemini endpoint can’t directly use two linked masks,
  // you can iterate per pair and composite results with sharp. But ideally, use a single
  // prompt/tool that takes (source, reference, A-mask, B-mask) together.
  //
  // For now, we just return the original source to keep pipeline alive.
  return Buffer.from(sourcePNG);
}
