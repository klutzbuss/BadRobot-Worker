import express from "express";
import multer from "multer";
import cors from "cors";
import Jimp from "jimp";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

/**
 * POST /process
 * Minimal masked replacement:
 * - sourceImage (required): distorted/base image (PNG/JPEG)
 * - referenceImage (required): clean/reference image (same W×H ideally)
 * - sourceMask (required): 8-bit PNG mask (white=editable area; black=lock)
 *
 * Returns: corrected PNG at EXACT same W×H as sourceImage.
 *
 * Notes:
 * - This is a single-pair MVP. Call it once per color pair from your app (sequentially).
 * - We keep canvas fixed. If dims differ, we center-fit reference & mask onto source size.
 */
app.post(
  "/process",
  upload.fields([
    { name: "sourceImage", maxCount: 1 },
    { name: "referenceImage", maxCount: 1 },
    { name: "sourceMask", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const srcFile = req.files?.sourceImage?.[0];
      const refFile = req.files?.referenceImage?.[0];
      const mskFile = req.files?.sourceMask?.[0];

      if (!srcFile || !refFile || !mskFile) {
        return res.status(400).json({ error: "Missing files: sourceImage, referenceImage, sourceMask are required." });
      }

      // Load images
      const base = await Jimp.read(srcFile.buffer);       // distorted/base
      let ref = await Jimp.read(refFile.buffer);          // reference
      let mask = await Jimp.read(mskFile.buffer);         // mask (white=editable)

      const W = base.bitmap.width;
      const H = base.bitmap.height;

      // Ensure reference & mask match base canvas size (fixed-canvas contract)
      if (ref.bitmap.width !== W || ref.bitmap.height !== H) {
        ref = ref.contain(W, H, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
      }
      if (mask.bitmap.width !== W || mask.bitmap.height !== H) {
        mask = mask.contain(W, H, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
      }

      // Prepare a masked reference patch: white in mask = keep reference pixels, black = transparent
      // Jimp's mask uses "white = keep", applied to the image being masked.
      const refMasked = ref.clone();
      // Ensure mask is single channel-like (Jimp converts internally)
      refMasked.mask(mask, 0, 0);

      // Composite masked reference over base (this replaces only white areas)
      const out = base.clone().composite(refMasked, 0, 0);

      const png = await out.getBufferAsync(Jimp.MIME_PNG);
      res.set("Content-Type", "image/png");
      res.send(png);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Processing failed", details: String(err) });
    }
  }
);

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Worker listening on :${PORT}`));
