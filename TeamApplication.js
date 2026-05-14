const mongoose = require("mongoose");
const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");

const {
  authenticateJWT,
  requireSuperAdmin,
  requireRole,
  User,
  ROLES,
  transporter,
} = require("./auth");

const router = express.Router();

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB max
  fileFilter(_req, file, cb) {
    ["image/jpeg", "image/png", "image/webp", "image/svg+xml"].includes(
      file.mimetype
    )
      ? cb(null, true)
      : cb(new Error("Logo must be JPEG, PNG, WebP or SVG"));
  },
});

//Team Schema

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, unique: true },
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Captain chosen by the manager (set after team is verified)
    captain: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Team logo stored as binary in the document
    logo: {
      data: { type: Buffer },
      contentType: { type: String },
      filename: { type: String },
    },
    status: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    verifiedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "" },

    // Auto-generated login credentials (stored hashed for the accounts,
    managerUsername: { type: String },
    captainUsername: { type: String },
  },
  { timestamps: true }
);

const Team = mongoose.model("Team", teamSchema);

//Helpers
/** Turn "Nairobi FC" → "nairobi-fc" */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Generate a readable username from team name + role, e.g. "nairobifc.manager" */
function buildUsername(teamName, role) {
  const base = slugify(teamName).replace(/-/g, "").slice(0, 12);
  return `${base}.${role}`;
}

//character random password
function randomPassword() {
  return crypto.randomBytes(8).toString("base64").slice(0, 12);
}

async function sendTeamCredentialsEmail({
  to,
  teamName,
  username,
  password,
  role,
}) {
  await transporter.sendMail({
    from: `"Club Platform" <${process.env.SMTP_USER}>`,
    to,
    subject: `✅ Your team "${teamName}" has been verified — login details inside`,
    html: `
      <h2>Congratulations! Your team <strong>${teamName}</strong> has been verified.</h2>
      <p>Here are the login credentials for the <strong>${role}</strong> account:</p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px"><strong>Username</strong></td><td>${username}</td></tr>
        <tr><td style="padding:4px 12px"><strong>Password</strong></td><td>${password}</td></tr>
      </table>
      <p style="color:#c00">⚠️ Please change your password after your first login.</p>
      <p>Log in at: <a href="${process.env.APP_BASE_URL}/login">${process.env.APP_BASE_URL}/login</a></p>
    `,
  });
}

async function sendRejectionEmail({ to, teamName, reason }) {
  await transporter.sendMail({
    from: `"Club Platform" <${process.env.SMTP_USER}>`,
    to,
    subject: `Update on your team application for "${teamName}"`,
    html: `
      <h2>Team Application Update</h2>
      <p>Thank you for applying to register <strong>${teamName}</strong>.</p>
      <p>After review, your application was <strong>not approved</strong> at this time.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
      <p>You are welcome to re-apply with updated information.</p>
    `,
  });
}

// Routes

// Manager submits a team registration application with a logo.
router.post(
  "/teams/apply",
  authenticateJWT,
  requireRole(ROLES.MANAGER),
  logoUpload.single("logo"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ error: "A team logo is required" });

      const { teamName } = req.body;
      if (!teamName)
        return res.status(400).json({ error: "teamName is required" });

      // One pending/verified application per manager
      const existing = await Team.findOne({
        manager: req.userId,
        status: { $in: ["pending", "verified"] },
      });
      if (existing)
        return res
          .status(400)
          .json({ error: "You already have an active team application." });

      const slug = slugify(teamName);
      if (await Team.findOne({ slug }))
        return res
          .status(400)
          .json({ error: "A team with that name already exists." });

      const team = new Team({
        name: teamName,
        slug,
        manager: req.userId,
        logo: {
          data: req.file.buffer,
          contentType: req.file.mimetype,
          filename: req.file.originalname,
        },
      });

      await team.save();

      res.status(201).json({
        message:
          "Team application submitted. You will receive an email once reviewed by the super admin.",
        teamId: team._id,
      });
    } catch (err) {
      if (err instanceof multer.MulterError || err.message.includes("Logo"))
        return res.status(400).json({ error: err.message });
      console.error("Team apply error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Public endpoint (no auth required — logos are visible on the platform).
router.get("/teams/logo/:teamId", async (req, res) => {
  try {
    const team = await Team.findById(req.params.teamId).select("logo");
    if (!team || !team.logo?.data)
      return res.status(404).json({ error: "Logo not found" });

    res.set("Content-Type", team.logo.contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(team.logo.data);
  } catch (err) {
    console.error("Serve logo error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

//  SUPER ADMIN ROUTES
router.get(
  "/superadmin/teams",
  authenticateJWT,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = req.query.status;

      const teams = await Team.find(filter)
        .select("-logo.data") // exclude binary blob from list
        .populate("manager", "email phoneNumber")
        .populate("captain", "email username")
        .populate("verifiedBy", "email username")
        .sort({ createdAt: -1 });

      const results = teams.map((t) => ({
        ...t.toObject(),
        logoUrl: `/teams/logo/${t._id}`,
      }));

      res.json({ total: results.length, teams: results });
    } catch (err) {
      console.error("List teams error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Full detail of a single team application.
router.get(
  "/superadmin/teams/:id",
  authenticateJWT,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const team = await Team.findById(req.params.id)
        .select("-logo.data")
        .populate("manager", "email phoneNumber username")
        .populate("captain", "email username")
        .populate("verifiedBy", "email username");

      if (!team) return res.status(404).json({ error: "Team not found" });

      res.json({ ...team.toObject(), logoUrl: `/teams/logo/${team._id}` });
    } catch (err) {
      console.error("Get team error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Super admin verifies a team.
router.patch(
  "/superadmin/teams/:id/verify",
  authenticateJWT,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const { captainEmail, captainPhone } = req.body;
      if (!captainEmail)
        return res.status(400).json({ error: "captainEmail is required" });

      const team = await Team.findById(req.params.id).populate(
        "manager",
        "email phoneNumber"
      );
      if (!team) return res.status(404).json({ error: "Team not found" });
      if (team.status !== "pending")
        return res
          .status(400)
          .json({ error: `Team is already ${team.status}` });

      // Auto-generate credentials
      const managerUsername = buildUsername(team.name, "manager");
      const captainUsername = buildUsername(team.name, "captain");
      const managerPassword = randomPassword();
      const captainPassword = randomPassword();

      //Create / update manager account
      let managerUser = await User.findById(team.manager._id);
      managerUser.username = managerUsername;
      managerUser.password = await bcrypt.hash(managerPassword, 10);
      managerUser.isVerified = true;
      managerUser.team = team._id;
      await managerUser.save();

      //Create captain account

      if (await User.findOne({ email: captainEmail, role: ROLES.CAPTAIN }))
        return res
          .status(400)
          .json({ error: "A captain account with that email already exists." });

      const captainUser = new User({
        email: captainEmail,
        username: captainUsername,
        password: await bcrypt.hash(captainPassword, 10),
        role: ROLES.CAPTAIN,
        isVerified: true,
        team: team._id,
        phoneNumber: captainPhone || "",
      });
      await captainUser.save();

      // Update team document
      team.status = "verified";
      team.verifiedBy = req.userId;
      team.verifiedAt = new Date();
      team.captain = captainUser._id;
      team.managerUsername = managerUsername;
      team.captainUsername = captainUsername;
      await team.save();

      // ── Send ONE email to the manager with BOTH sets of credentials ────────
      await transporter.sendMail({
        from: `"Club Platform" <${process.env.SMTP_USER}>`,
        to: team.manager.email,
        subject: `✅ "${team.name}" has been verified — login details for you and your captain`,
        html: `
        <h2>🎉 Your team <strong>${team.name}</strong> has been verified!</h2>

        <h3>Manager Login</h3>
        <table style="border-collapse:collapse;margin-bottom:16px">
          <tr><td style="padding:4px 12px"><strong>Username</strong></td><td>${managerUsername}</td></tr>
          <tr><td style="padding:4px 12px"><strong>Password</strong></td><td>${managerPassword}</td></tr>
        </table>

        <h3>Captain Login <span style="font-weight:normal;font-size:14px">(${captainEmail})</span></h3>
        <table style="border-collapse:collapse;margin-bottom:16px">
          <tr><td style="padding:4px 12px"><strong>Username</strong></td><td>${captainUsername}</td></tr>
          <tr><td style="padding:4px 12px"><strong>Password</strong></td><td>${captainPassword}</td></tr>
        </table>

        <p style="color:#c00">⚠️ Please share the captain's credentials with them securely and ask both users to change their passwords immediately after first login.</p>
        <p>Log in at: <a href="${process.env.APP_BASE_URL}/login">${process.env.APP_BASE_URL}/login</a></p>
      `,
      });

      res.json({
        message: `Team "${team.name}" verified. Credentials emailed to ${team.manager.email}.`,
        managerUsername,
        captainUsername,
      });
    } catch (err) {
      console.error("Verify team error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Super admin rejects a team application and notifies the manager.
router.patch(
  "/superadmin/teams/:id/reject",
  authenticateJWT,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const { reason } = req.body;
      const team = await Team.findById(req.params.id).populate(
        "manager",
        "email"
      );
      if (!team) return res.status(404).json({ error: "Team not found" });
      if (team.status !== "pending")
        return res
          .status(400)
          .json({ error: `Team is already ${team.status}` });

      team.status = "rejected";
      team.verifiedBy = req.userId;
      team.verifiedAt = new Date();
      team.rejectReason = reason || "";
      await team.save();

      await sendRejectionEmail({
        to: team.manager.email,
        teamName: team.name,
        reason,
      });

      res.json({
        message: `Team "${team.name}" rejected. Manager has been notified.`,
      });
    } catch (err) {
      console.error("Reject team error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Quick stats for the super admin dashboard.
router.get(
  "/superadmin/dashboard",
  authenticateJWT,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const [pending, verified, rejected, totalUsers] = await Promise.all([
        Team.countDocuments({ status: "pending" }),
        Team.countDocuments({ status: "verified" }),
        Team.countDocuments({ status: "rejected" }),
        User.countDocuments({ role: { $ne: ROLES.SUPER_ADMIN } }),
      ]);

      res.json({
        teams: {
          pending,
          verified,
          rejected,
          total: pending + verified + rejected,
        },
        totalUsers,
      });
    } catch (err) {
      console.error("Dashboard error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = { router, Team };
