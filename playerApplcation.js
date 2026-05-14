const mongoose = require("mongoose");
const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const { authenticateJWT, requireAdmin } = require("./auth");

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const APPLICATION_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
};

const POSITIONS = [
  "goalkeeper",
  "centre-back",
  "right-back",
  "left-back",
  "defensive-midfielder",
  "central-midfielder",
  "attacking-midfielder",
  "right-winger",
  "left-winger",
  "centre-forward",
  "striker",
];

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE_MB = 5;
const MAX_PHOTOS = 3; // player can upload up to 3 photos

// ─── Multer — store uploads in memory so we can write raw bytes to MongoDB ─────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Only JPEG, PNG and WebP images are allowed`));
    }
  },
});

// ─── Schema ───────────────────────────────────────────────────────────────────

// Each uploaded photo is stored inline as binary data (Buffer) alongside its
// content-type so we can serve it back with the correct MIME header.
const photoSchema = new mongoose.Schema(
  {
    data: { type: Buffer, required: true }, // raw binary pixels
    contentType: { type: String, required: true }, // e.g. "image/jpeg"
    filename: { type: String, required: true }, // original filename
    size: { type: Number, required: true }, // bytes
  },
  { _id: true } // each photo gets its own _id — used in the serve route
);

const playerApplicationSchema = new mongoose.Schema(
  {
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    email: { type: String, required: true },

    // ── Form fields ──────────────────────────────────────────────────────────
    age: {
      type: Number,
      required: true,
      min: [15, "Player must be at least 15 years old"],
      max: [45, "Player must be 45 or younger"],
    },
    height: {
      type: Number,
      required: true, // centimetres
      min: [140, "Height must be at least 140 cm"],
      max: [220, "Height cannot exceed 220 cm"],
    },
    weight: {
      type: Number,
      required: true, // kilograms
      min: [40, "Weight must be at least 40 kg"],
      max: [130, "Weight cannot exceed 130 kg"],
    },
    position: {
      type: String,
      required: true,
      enum: POSITIONS,
    },
    previousTeam: { type: String, required: true, trim: true },
    contractDuration: {
      type: Number,
      required: true, // months
      min: [1, "Contract duration must be at least 1 month"],
      max: [60, "Contract duration cannot exceed 60 months"],
    },
    playingStyle: {
      type: String,
      required: true,
      trim: true,
      maxlength: [
        500,
        "Playing style description cannot exceed 500 characters",
      ],
    },

    // ── Photos — stored as binary in the document ────────────────────────────
    photos: {
      type: [photoSchema],
      validate: {
        validator: (arr) => arr.length <= MAX_PHOTOS,
        message: `A maximum of ${MAX_PHOTOS} photos is allowed`,
      },
    },

    // ── Review fields ────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(APPLICATION_STATUS),
      default: APPLICATION_STATUS.PENDING,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    adminNote: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const PlayerApplication = mongoose.model(
  "PlayerApplication",
  playerApplicationSchema
);

// ─── Email helper ─────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendDecisionEmail(application, decision, customMessage) {
  const accepted = decision === APPLICATION_STATUS.ACCEPTED;
  await transporter.sendMail({
    from: `"Club Admin" <${process.env.SMTP_USER}>`,
    to: application.email,
    subject: accepted
      ? "🎉 Congratulations! Your player application has been accepted"
      : "Your player application update",
    html: accepted
      ? `<h2>Welcome to the team!</h2>
         <p>Your application as a <strong>${
           application.position
         }</strong> has been <strong>accepted</strong>.</p>
         ${
           customMessage
             ? `<p><strong>Message from the admin:</strong><br>${customMessage}</p>`
             : ""
         }
         <p>We will be in touch with next steps. Welcome aboard!</p>`
      : `<h2>Application Update</h2>
         <p>Thank you for applying as a <strong>${
           application.position
         }</strong>.
            After careful review, your application was <strong>not successful</strong> at this time.</p>
         ${
           customMessage
             ? `<p><strong>Feedback:</strong><br>${customMessage}</p>`
             : ""
         }
         <p>We encourage you to apply again in future. Best of luck!</p>`,
  });
}

// ─── Multer error handler ─────────────────────────────────────────────────────

function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError || err.message.includes("Only")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /applications/submit
 * Multipart form — fields + up to 3 image files under the key "photos".
 *
 * Form fields (all required unless noted):
 *   age, height, weight, position, previousTeam, contractDuration, playingStyle
 *
 * File field:
 *   photos   (up to 3 images, JPEG / PNG / WebP, max 5 MB each)
 */
router.post(
  "/applications/submit",
  authenticateJWT,
  upload.array("photos", MAX_PHOTOS),
  handleMulterError,
  async (req, res) => {
    try {
      const {
        age,
        height,
        weight,
        position,
        previousTeam,
        contractDuration,
        playingStyle,
      } = req.body;

      // Block duplicate pending applications
      const existingPending = await PlayerApplication.findOne({
        submittedBy: req.userId,
        status: APPLICATION_STATUS.PENDING,
      });
      if (existingPending) {
        return res.status(400).json({
          error:
            "You already have a pending application. Please wait for it to be reviewed.",
        });
      }

      // Convert multer file objects → photo sub-documents (raw Buffer stored)
      const photos = (req.files || []).map((file) => ({
        data: file.buffer, // ← raw binary pixels
        contentType: file.mimetype,
        filename: file.originalname,
        size: file.size,
      }));

      const application = new PlayerApplication({
        submittedBy: req.userId,
        email: req.email,
        age: Number(age),
        height: Number(height),
        weight: Number(weight),
        position,
        previousTeam,
        contractDuration: Number(contractDuration),
        playingStyle,
        photos,
      });

      await application.save();

      // Return photo IDs so the client can build display URLs immediately
      const photoIds = application.photos.map((p) => ({
        photoId: p._id,
        url: `/applications/${application._id}/photos/${p._id}`,
      }));

      res.status(201).json({
        message:
          "Application submitted successfully. You will be notified by email once reviewed.",
        applicationId: application._id,
        photos: photoIds,
      });
    } catch (err) {
      if (err.name === "ValidationError") {
        const errors = Object.values(err.errors).map((e) => e.message);
        return res.status(400).json({ error: errors.join(", ") });
      }
      console.error("Submit application error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * GET /applications/:id/photos/:photoId
 * Serve a single photo as an image response — works in <img src="..."> tags.
 * Accessible to the applicant (own application) and any admin.
 */
router.get(
  "/applications/:id/photos/:photoId",
  authenticateJWT,
  async (req, res) => {
    try {
      // Only fetch the photos sub-array — skip the heavy binary from other docs
      const application = await PlayerApplication.findById(
        req.params.id
      ).select("submittedBy photos");

      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      // Applicant can only fetch their own photos; admins can fetch any
      const isOwner =
        application.submittedBy.toString() === req.userId.toString();
      if (!isOwner && !req.isAdmin) {
        return res.status(403).json({ error: "Access denied" });
      }

      const photo = application.photos.id(req.params.photoId);
      if (!photo) {
        return res.status(404).json({ error: "Photo not found" });
      }

      // Set caching headers — binary content won't change
      res.set("Content-Type", photo.contentType);
      res.set("Content-Length", photo.size);
      res.set("Cache-Control", "private, max-age=86400");
      res.send(photo.data); // ← send raw Buffer directly to browser
    } catch (err) {
      console.error("Serve photo error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * GET /applications
 * Admin: list all applications (metadata only — no binary photo data).
 * Query param: ?status=pending | accepted | rejected
 */
router.get("/applications", authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};

    if (status) {
      if (!Object.values(APPLICATION_STATUS).includes(status)) {
        return res.status(400).json({
          error: `Invalid status. Use: ${Object.values(APPLICATION_STATUS).join(
            ", "
          )}`,
        });
      }
      filter.status = status;
    }

    // Exclude photo binary data from list — serve via the photo route instead
    const applications = await PlayerApplication.find(filter)
      .select("-photos.data") // omit binary blobs from list response
      .populate("submittedBy", "email phoneNumber role")
      .populate("reviewedBy", "email role")
      .sort({ createdAt: -1 });

    // Attach ready-to-use photo URLs to each application
    const results = applications.map((app) => {
      const obj = app.toObject();
      obj.photos = (app.photos || []).map((p) => ({
        photoId: p._id,
        filename: p.filename,
        contentType: p.contentType,
        size: p.size,
        url: `/applications/${app._id}/photos/${p._id}`,
      }));
      return obj;
    });

    res.json({ total: results.length, applications: results });
  } catch (err) {
    console.error("List applications error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /applications/:id
 * Admin: full detail of one application with photo URLs (no binary in JSON).
 */
router.get(
  "/applications/:id",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const application = await PlayerApplication.findById(req.params.id)
        .select("-photos.data")
        .populate("submittedBy", "email phoneNumber role")
        .populate("reviewedBy", "email role");

      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const obj = application.toObject();
      obj.photos = (application.photos || []).map((p) => ({
        photoId: p._id,
        filename: p.filename,
        contentType: p.contentType,
        size: p.size,
        url: `/applications/${application._id}/photos/${p._id}`,
      }));

      res.json(obj);
    } catch (err) {
      console.error("Get application error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * PATCH /applications/:id/review
 * Admin: accept or reject an application and email the applicant.
 *
 * Body:
 *   decision   "accepted" | "rejected"   (required)
 *   message    string                    (optional — sent to the applicant)
 *   adminNote  string                    (optional — internal only)
 */
router.patch(
  "/applications/:id/review",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const { decision, message, adminNote } = req.body;

      if (!decision || !["accepted", "rejected"].includes(decision)) {
        return res
          .status(400)
          .json({ error: 'decision must be "accepted" or "rejected"' });
      }

      const application = await PlayerApplication.findById(req.params.id);
      if (!application)
        return res.status(404).json({ error: "Application not found" });

      if (application.status !== APPLICATION_STATUS.PENDING) {
        return res.status(400).json({
          error: `Application has already been ${application.status} and cannot be reviewed again.`,
        });
      }

      application.status = decision;
      application.reviewedBy = req.userId;
      application.reviewedAt = new Date();
      if (adminNote) application.adminNote = adminNote;

      await application.save();
      await sendDecisionEmail(application, decision, message);

      res.json({
        message: `Application ${decision}. The applicant has been notified by email.`,
        applicationId: application._id,
        status: application.status,
        reviewedAt: application.reviewedAt,
      });
    } catch (err) {
      console.error("Review application error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * GET /applications/me
 * Player: check own application status and get their own photo URLs.
 */
router.get("/applications/me", authenticateJWT, async (req, res) => {
  try {
    const applications = await PlayerApplication.find({
      submittedBy: req.userId,
    })
      .select("-adminNote -photos.data")
      .sort({ createdAt: -1 });

    const results = applications.map((app) => {
      const obj = app.toObject();
      obj.photos = (app.photos || []).map((p) => ({
        photoId: p._id,
        url: `/applications/${app._id}/photos/${p._id}`,
      }));
      return obj;
    });

    res.json({ applications: results });
  } catch (err) {
    console.error("My applications error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = { router, PlayerApplication, APPLICATION_STATUS, POSITIONS };
