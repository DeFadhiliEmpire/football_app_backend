const mongoose = require("mongoose");
const express = require("express");
const { authenticateJWT, requireRole, ROLES } = require("./auth");

const router = express.Router();

// Only the manager of the specific team can mutate their team's data Captains get read access to fixtures and tournaments
const MANAGER_ONLY = requireRole(ROLES.MANAGER);
const TEAM_ADMIN = requireRole(ROLES.MANAGER, ROLES.CAPTAIN, ROLES.COACH);

//verify the acting manager owns this team
async function assertTeamOwner(req, res) {
  const { Team } = require("./teams");
  const team = await Team.findById(req.teamId);
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return null;
  }
  if (team.manager.toString() !== req.userId.toString()) {
    res.status(403).json({ error: "You are not the manager of this team" });
    return null;
  }
  return team;
}
// Fixture Schema
const fixtureSchema = new mongoose.Schema(
  {
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
    opponent: { type: String, required: true, trim: true },
    venue: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    competition: { type: String, required: true, trim: true },
    isHome: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["scheduled", "played", "postponed", "cancelled"],
      default: "scheduled",
    },
    // Score — only set after the match is played
    result: {
      homeGoals: { type: Number, default: null },
      awayGoals: { type: Number, default: null },
      outcome: {
        type: String,
        enum: ["win", "draw", "loss", null],
        default: null,
      },
    },

    notes: { type: String, default: "", maxlength: 500 },
  },
  { timestamps: true }
);

const Fixture = mongoose.model("Fixture", fixtureSchema);

//Tournament Schema
const tournamentSchema = new mongoose.Schema(
  {
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
    name: { type: String, required: true, trim: true },
    organizer: { type: String, required: true, trim: true },
    venue: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    prizePool: { type: String, default: "" }, // e.g. "KES 500,000"
    description: { type: String, default: "", maxlength: 1000 },
    registrationDeadline: { type: Date, default: null },
    status: {
      type: String,
      enum: ["upcoming", "ongoing", "completed", "withdrawn"],
      default: "upcoming",
    },

    // Rounds the team has played in this tournament
    rounds: [
      {
        round: { type: String, required: true }, // "Group Stage", "Quarter Final" etc
        opponent: { type: String, required: true },
        date: { type: Date, required: true },
        homeGoals: { type: Number, default: null },
        awayGoals: { type: Number, default: null },
        outcome: {
          type: String,
          enum: ["win", "draw", "loss", null],
          default: null,
        },
      },
    ],
  },
  { timestamps: true }
);

const Tournament = mongoose.model("Tournament", tournamentSchema);

// Player Contract Schema
const contractSchema = new mongoose.Schema(
  {
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Core terms
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    durationMonths: { type: Number, required: true },
    position: { type: String, required: true },
    weeklyWage: { type: Number, default: null }, // optional — KES or whatever currency
    currency: { type: String, default: "KES" },
    status: {
      type: String,
      enum: ["active", "expired", "terminated", "transferred"],
      default: "active",
    },
    // Termination details
    terminatedAt: { type: Date, default: null },
    terminatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    terminationNote: { type: String, default: "" },
  },
  { timestamps: true }
);

// Enforce one active contract per player per team at a time
contractSchema.index({ team: 1, player: 1, status: 1 });

const Contract = mongoose.model("Contract", contractSchema);

//  FIXTURE ROUTES

// Manager: add a new fixture for the team.
router.post(
  "/team/fixtures",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const { opponent, venue, date, competition, isHome, notes } = req.body;

      if (!opponent || !venue || !date || !competition)
        return res.status(400).json({
          error: "opponent, venue, date and competition are required",
        });

      if (isNaN(new Date(date)))
        return res
          .status(400)
          .json({ error: "date must be a valid ISO date string" });

      const fixture = new Fixture({
        team: team._id,
        opponent,
        venue,
        date: new Date(date),
        competition,
        isHome: isHome !== undefined ? isHome : true,
        notes: notes || "",
      });

      await fixture.save();
      res.status(201).json({ message: "Fixture added successfully", fixture });
    } catch (err) {
      console.error("Add fixture error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Team admin: list all fixtures
router.get("/team/fixtures", authenticateJWT, TEAM_ADMIN, async (req, res) => {
  try {
    const filter = { team: req.teamId };

    if (req.query.status) filter.status = req.query.status;
    if (req.query.upcoming === "true") {
      filter.status = "scheduled";
      filter.date = { $gte: new Date() };
    }

    const fixtures = await Fixture.find(filter).sort({ date: 1 });
    res.json({ total: fixtures.length, fixtures });
  } catch (err) {
    console.error("List fixtures error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

//update a fixture
router.patch(
  "/team/fixtures/:id",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const fixture = await Fixture.findOne({
        _id: req.params.id,
        team: team._id,
      });
      if (!fixture) return res.status(404).json({ error: "Fixture not found" });

      const {
        opponent,
        venue,
        date,
        competition,
        isHome,
        status,
        notes,
        result,
      } = req.body;

      if (opponent) fixture.opponent = opponent;
      if (venue) fixture.venue = venue;
      if (competition) fixture.competition = competition;
      if (isHome !== undefined) fixture.isHome = isHome;
      if (notes !== undefined) fixture.notes = notes;
      if (status) fixture.status = status;
      if (date) {
        if (isNaN(new Date(date)))
          return res.status(400).json({ error: "Invalid date" });
        fixture.date = new Date(date);
      }
      if (result) {
        fixture.result.homeGoals = result.homeGoals ?? fixture.result.homeGoals;
        fixture.result.awayGoals = result.awayGoals ?? fixture.result.awayGoals;
        fixture.result.outcome = result.outcome ?? fixture.result.outcome;
        if (result.homeGoals !== undefined) fixture.status = "played";
      }

      await fixture.save();
      res.json({ message: "Fixture updated", fixture });
    } catch (err) {
      console.error("Update fixture error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//delete fitures
router.delete(
  "/team/fixtures/:id",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const fixture = await Fixture.findOne({
        _id: req.params.id,
        team: team._id,
      });
      if (!fixture) return res.status(404).json({ error: "Fixture not found" });
      if (fixture.status === "played")
        return res.status(400).json({
          error: "Cannot delete a fixture that has already been played",
        });

      await fixture.deleteOne();
      res.json({ message: "Fixture removed" });
    } catch (err) {
      console.error("Delete fixture error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Manager: register the team for an upcoming tournament
router.post(
  "/team/tournaments",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const {
        name,
        organizer,
        venue,
        startDate,
        endDate,
        prizePool,
        description,
        registrationDeadline,
      } = req.body;

      if (!name || !organizer || !venue || !startDate || !endDate)
        return res.status(400).json({
          error: "name, organizer, venue, startDate and endDate are required",
        });

      if (new Date(startDate) > new Date(endDate))
        return res
          .status(400)
          .json({ error: "startDate must be before endDate" });

      const tournament = new Tournament({
        team: team._id,
        name,
        organizer,
        venue,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        prizePool: prizePool || "",
        description: description || "",
        registrationDeadline: registrationDeadline
          ? new Date(registrationDeadline)
          : null,
      });

      await tournament.save();
      res.status(201).json({ message: "Tournament added", tournament });
    } catch (err) {
      console.error("Add tournament error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Team admin: list all tournaments
router.get(
  "/team/tournaments",
  authenticateJWT,
  TEAM_ADMIN,
  async (req, res) => {
    try {
      const filter = { team: req.teamId };
      if (req.query.status) filter.status = req.query.status;

      const tournaments = await Tournament.find(filter).sort({ startDate: 1 });
      res.json({ total: tournaments.length, tournaments });
    } catch (err) {
      console.error("List tournaments error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Manager: update tournament details or add/update a round result.
router.patch(
  "/team/tournaments/:id",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const tournament = await Tournament.findOne({
        _id: req.params.id,
        team: team._id,
      });
      if (!tournament)
        return res.status(404).json({ error: "Tournament not found" });

      const {
        name,
        organizer,
        venue,
        startDate,
        endDate,
        prizePool,
        description,
        registrationDeadline,
        status,
        round,
      } = req.body;

      if (name) tournament.name = name;
      if (organizer) tournament.organizer = organizer;
      if (venue) tournament.venue = venue;
      if (prizePool !== undefined) tournament.prizePool = prizePool;
      if (description !== undefined) tournament.description = description;
      if (status) tournament.status = status;
      if (startDate) tournament.startDate = new Date(startDate);
      if (endDate) tournament.endDate = new Date(endDate);
      if (registrationDeadline !== undefined)
        tournament.registrationDeadline = registrationDeadline
          ? new Date(registrationDeadline)
          : null;

      // Add or update a round result
      if (round) {
        if (!round.round || !round.opponent || !round.date)
          return res.status(400).json({
            error: "round.round, round.opponent and round.date are required",
          });

        const existingRound = tournament.rounds.find(
          (r) => r.round === round.round
        );
        if (existingRound) {
          // Update existing round
          Object.assign(existingRound, round);
        } else {
          tournament.rounds.push(round);
        }
      }

      await tournament.save();
      res.json({ message: "Tournament updated", tournament });
    } catch (err) {
      console.error("Update tournament error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Manager: remove a tournament entry
router.delete(
  "/team/tournaments/:id",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const tournament = await Tournament.findOne({
        _id: req.params.id,
        team: team._id,
      });
      if (!tournament)
        return res.status(404).json({ error: "Tournament not found" });
      if (["ongoing", "completed"].includes(tournament.status))
        return res.status(400).json({
          error: `Cannot delete a tournament that is ${tournament.status}`,
        });

      await tournament.deleteOne();
      res.json({ message: "Tournament removed" });
    } catch (err) {
      console.error("Delete tournament error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//  register an active player contract after a player application is accepted
router.post(
  "/team/contracts",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const {
        playerId,
        startDate,
        endDate,
        durationMonths,
        position,
        weeklyWage,
        currency,
      } = req.body;

      if (!playerId || !startDate || !endDate || !durationMonths || !position)
        return res.status(400).json({
          error:
            "playerId, startDate, endDate, durationMonths and position are required",
        });

      // Prevent duplicate active contract for same player in same team
      const existing = await Contract.findOne({
        team: team._id,
        player: playerId,
        status: "active",
      });
      if (existing)
        return res.status(400).json({
          error: "This player already has an active contract with the team",
        });

      const contract = new Contract({
        team: team._id,
        player: playerId,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        durationMonths: Number(durationMonths),
        position,
        weeklyWage: weeklyWage || null,
        currency: currency || "KES",
      });

      await contract.save();

      // Attach player to this team in the User document
      const { User } = require("./auth");
      await User.findByIdAndUpdate(playerId, { team: team._id });

      res.status(201).json({ message: "Contract registered", contract });
    } catch (err) {
      console.error("Add contract error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Manager: list all contracts for the team
router.get(
  "/team/contracts",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const filter = { team: team._id };
      if (req.query.status) filter.status = req.query.status;

      const contracts = await Contract.find(filter)
        .populate("player", "email username phoneNumber")
        .populate("terminatedBy", "email username")
        .sort({ createdAt: -1 });

      res.json({ total: contracts.length, contracts });
    } catch (err) {
      console.error("List contracts error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//Manager: terminate a player's contract .removes the player from the active squad
router.patch(
  "/team/contracts/:id/terminate",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const contract = await Contract.findOne({
        _id: req.params.id,
        team: team._id,
      });
      if (!contract)
        return res.status(404).json({ error: "Contract not found" });

      if (contract.status !== "active")
        return res
          .status(400)
          .json({ error: `Contract is already ${contract.status}` });

      contract.status = "terminated";
      contract.terminatedAt = new Date();
      contract.terminatedBy = req.userId;
      contract.terminationNote = req.body.reason || "";
      await contract.save();

      // Detach player from the team in the User document
      const { User } = require("./auth");
      await User.findByIdAndUpdate(contract.player, { team: null });

      res.json({
        message:
          "Player contract terminated. Player has been removed from the squad.",
        contract,
      });
    } catch (err) {
      console.error("Terminate contract error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

//mark a contract as naturally expired at the end of its duration
router.patch(
  "/team/contracts/:id/expire",
  authenticateJWT,
  MANAGER_ONLY,
  async (req, res) => {
    try {
      const team = await assertTeamOwner(req, res);
      if (!team) return;

      const contract = await Contract.findOne({
        _id: req.params.id,
        team: team._id,
      });
      if (!contract)
        return res.status(404).json({ error: "Contract not found" });
      if (contract.status !== "active")
        return res
          .status(400)
          .json({ error: `Contract is already ${contract.status}` });

      contract.status = "expired";
      await contract.save();

      const { User } = require("./auth");
      await User.findByIdAndUpdate(contract.player, { team: null });

      res.json({
        message: "Contract marked as expired. Player released from squad.",
        contract,
      });
    } catch (err) {
      console.error("Expire contract error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// list all players with active contracts (the current squad).
router.get("/team/squad", authenticateJWT, TEAM_ADMIN, async (req, res) => {
  try {
    const contracts = await Contract.find({
      team: req.teamId,
      status: "active",
    })
      .populate("player", "email username phoneNumber")
      .sort({ position: 1 });

    const squad = contracts.map((c) => ({
      contractId: c._id,
      player: c.player,
      position: c.position,
      contractStart: c.startDate,
      contractEnd: c.endDate,
      weeklyWage: c.weeklyWage,
      currency: c.currency,
    }));

    res.json({ total: squad.length, squad });
  } catch (err) {
    console.error("Squad error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = { router, Fixture, Tournament, Contract };
