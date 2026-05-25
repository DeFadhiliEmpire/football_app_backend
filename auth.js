require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const router = express.Router();

const ROLES = {
  SUPER_ADMIN: "super_admin",
  COACH: "coach",
  MANAGER: "manager",
  CAPTAIN: "captain",
  PLAYER: "player",
};

// Roles that have admin-level privileges
const ADMIN_ROLES = [ROLES.COACH, ROLES.MANAGER, ROLES.CAPTAIN];
const SUPER_ADMIN_ROLES = [ROLES.SUPER_ADMIN];

//Schema
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.PLAYER,
    },
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    isVerified: { type: Boolean, default: false },
    verificationToken: { type: String },
    verificationTokenExpiry: { type: Date },
  },
  { timestamps: true }
);

// Convenience virtual — true if the user has admin-level privileges
userSchema.virtual("isAdmin").get(function () {
  return ADMIN_ROLES.includes(this.role);
});
userSchema.virtual("isSuperAdmin").get(function () {
  return this.role === ROLES.SUPER_ADMIN;
});

const User = mongoose.model("User", userSchema);

//Email helper
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  family:4,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },

  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
});

transporter.verify((error, success) => {
  if (error) {
    console.log("SMTP VERIFY ERROR:", error);
  } else {
    console.log("SMTP SERVER READY");
  }
});

async function sendVerificationEmail(email, token) {
  const verifyURL = `${process.env.APP_BASE_URL}/auth/verify-email?token=${token}`;
  await transporter.sendMail({
    from: `"MyFootBallApp" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Verify your email address",
    html: `
      <p>Thanks for signing up! Please verify your email by clicking the link below.</p>
      <p><a href="${verifyURL}">${verifyURL}</a></p>
      <p>This link expires in 24 hours.</p>
    `,
  });
}

//Sign-up
router.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, phoneNumber, role, team } = req.body;

    if (!email || !password || !phoneNumber) {
      return res
        .status(400)
        .json({ error: "email, password and phoneNumber are required" });
    }

    // Validate role if provided; default to "player" if omitted
    const assignedRole = role || ROLES.PLAYER;
    if (
      !Object.values(ROLES).includes(assignedRole) ||
      assignedRole === ROLES.SUPER_ADMIN
    ) {
      return res.status(400).json({
        error: `Invalid role. Must be one of: ${Object.values(ROLES).join(
          ", "
        )}`,
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = new User({
      email,
      password: hashedPassword,
      phoneNumber,
      role: assignedRole,
      team,
      verificationToken,
      verificationTokenExpiry,
    });

    await user.save();
    await sendVerificationEmail(email, verificationToken);

    res.status(201).json({
      message:
        "Account created. Please check your email to verify your address before logging in.",
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

//Email verification

router.get("/auth/verify-email", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "Token is required" });

    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpiry: { $gt: new Date() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ error: "Invalid or expired verification token" });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpiry = undefined;
    await user.save();

    res.json({ message: "Email verified successfully. You can now log in." });
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

//Login
router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.isVerified) {
      return res
        .status(403)
        .json({ error: "Please verify your email before logging in" });
    }

    const payload = {
      userId: user._id,
      email: user.email,
      role: user.role,
      isAdmin: ADMIN_ROLES.includes(user.role),
      isSuperAdmin: user.role === ROLES.SUPER_ADMIN,
      teamId: user.team,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.json({ token, role: user.role });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

//Middleware: verify JWT

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.email = decoded.email;
    req.role = decoded.role;
    req.isAdmin = decoded.isAdmin;
    req.isSuperAdmin = decoded.isSuperAdmin;
    req.teamId = decoded.teamId;
    next();
  } catch (e) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

//Middleware: require admin role

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res
      .status(403)
      .json({ message: "Access denied. Admin role required." });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.isSuperAdmin)
    return res
      .status(403)
      .json({ message: "Access denied. Super admin only." });
  next();
}

//Middleware require one or more specific roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({
        message: `Access denied. Required role(s): ${roles.join(", ")}`,
      });
    }
    next();
  };
}

async function seedSuperAdmin() {
  await mongoose.connect(process.env.MONGO_URI);
  const exists = await User.findOne({ role: ROLES.SUPER_ADMIN });
  if (exists) {
    console.log("Super admin already exists.");
    process.exit(0);
  }

  const password =
    process.env.SUPER_ADMIN_PASSWORD || crypto.randomBytes(12).toString("hex");
  const hashed = await bcrypt.hash(password, 12);

  await new User({
    email: process.env.SUPER_ADMIN_EMAIL || "superadmin@myapp.com",
    username: "superadmin",
    password: hashed,
    role: ROLES.SUPER_ADMIN,
    isVerified: true,
    phoneNumber: "N/A",
  }).save();

  console.log("✅ Super admin created");
  console.log(
    `   Email:    ${process.env.SUPER_ADMIN_EMAIL || "superadmin@myapp.com"}`
  );
  console.log(`   Password: ${password}`);
  console.log("   ⚠️  Save this password now — it will not be shown again.");
  process.exit(0);
}
//protected routes

// Only the captain can assign the armband
router.patch(
  "/team/armband",
  authenticateJWT,
  requireRole(ROLES.CAPTAIN),
  (req, res) => {
    res.json({ message: "Armband assigned" });
  }
);

// Only coach or manager can add/remove players from the squad
router.post(
  "/team/players",
  authenticateJWT,
  requireRole(ROLES.COACH, ROLES.MANAGER),
  (req, res) => {
    res.json({ message: "Player added to the squad" });
  }
);

// Admins only (coach, manager, or captain)
router.post("/team/lineup", authenticateJWT, requireAdmin, (req, res) => {
  res.json({ message: "Lineup saved", savedBy: req.email });
});

// Any logged-in user (player or admin)
router.get("/team/schedule", authenticateJWT, (req, res) => {
  res.json({ message: "Here is the team schedule", role: req.role });
});

module.exports = {
  router,
  ADMIN_ROLES,
  ROLES,
  authenticateJWT,
  requireAdmin,
  requireSuperAdmin,
  requireRole,
  transporter,
  seedSuperAdmin,
};
