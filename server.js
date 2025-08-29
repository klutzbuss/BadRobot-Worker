import express from "express";
import multer from "multer";
import cors from "cors";
import Jimp from "jimp";

const app = express();
app.use(cors());
app.use(express.json());

// Accept bigger uploads and ANY field names to avoid LIMIT_UNEXPECTED_FILE
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB
});

function pickFile(req, names) {
  for (const f of req.files || []) {
    if (names.includes(f.fieldname)) return f;
  }
  return null;
}

/**
 * POST /process
 * Accepts flexible field names and multipart payloads created via FormData.
 * Expected (any of these aliases are accepted):
 *  - sourceImage | source_image | distorted | base
 *  - referenceImage | reference_image | reference | clean
 *  - sourceMask | source_mask | mask | maskA
 * Optional:
 *  - meta (JSON string)
 */
app.post("/process", upload.any(), async (req, res) => {
  try {
    // Parse meta if present (not required)
    let meta = {};
    if (req.body?.meta) {
      try { meta = JSON.parse(req.body.meta); } catch {}
    }

    const srcFile = pickFile(req, ["sourceImage","source_image","distorted","base"]);
    const refFile = pickFile(req, ["referenceImage","reference_image","reference","clean"]);
    const mskFile = pickFile(req, ["sourceMask","source_mask","mask","maskA"]);

    if (!srcFile || !refFile || !mskFile) {
      return res.status(400).json({
        error: "Missing files",
        detail: "Need sourceImage, referenceImage and sourceMask (any alias). Received: " + (req.files || []).map(f=>f.fieldname).join(", ")
      });
    }

    const base = await Jimp.read(srcFile.buffer);
    let ref = await Jimp.read(refFile.buffer);
    let mask = await Jimp.read(mskFile.buffer);

    const W = base.bitmap.width;
    const H = base.bitmap.height;

    // Fit reference & mask to base size if needed
    if (ref.bitmap.width !== W || ref.bitmap.height !== H) {
      ref = ref.contain(W, H, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
    }
    if (mask.bitmap.width !== W || mask.bitmap.height !== H) {
      mask = mask.contain(W, H, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
    }

    // Apply mask (white=keep ref)
    const refMasked = ref.clone();
    refMasked.mask(mask, 0, 0);

    const out = base.clone().composite(refMasked, 0, 0);
    const png = await out.getBufferAsync(Jimp.MIME_PNG);

    res.set("Content-Type", "image/png");
    res.send(png);
  } catch (err) {
    console.error("Worker error:", err);
    res.status(500).json({ error: "Processing failed", details: String(err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Worker listening on :${PORT}`));
